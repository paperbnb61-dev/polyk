import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import {
  applyBuy,
  decideBuy,
  formatPositionLine,
  loadCeleConfig,
  settleWindow,
  type Side,
  type SlugPosition,
} from "./cele-strategy.js";
import { envNumber, envString } from "./env-util.js";
import { fetchMarketQuote, isQuoteTradable } from "./market-quotes.js";
import { slugForCurrent15m } from "./slug.js";
import { ensureDbReady, insertPaperEvent } from "./db.js";

dotenv.config();

const market = envString("PAPER_MARKET", "btc").toLowerCase();
const pollMs = Math.max(120, envNumber("PAPER_POLL_INTERVAL_MS", 400));
const cele = loadCeleConfig("PAPER_");
const feeRate = Math.max(0, envNumber("PAPER_FEE_RATE", 0.00072));
const initialUsd = Math.max(1, envNumber("PAPER_INITIAL_USD", 10000));
const telegramToken = envString("TELEGRAM_BOT_TOKEN", "");
const telegramChatId = envString("TELEGRAM_CHAT_ID", "");
const paperLogFile = envString("PAPER_LOG_FILE", "data/paper-logs.jsonl");

let cashUsd = initialUsd;
let realizedUsd = 0;
let position: SlugPosition | null = null;
let totalWindows = 0;
let totalBuys = 0;
let dbEnabled = false;

function detectEventType(message: string): string {
  if (message.startsWith("BUY ")) return "BUY";
  if (message.startsWith("WINDOW END")) return "WINDOW";
  if (message.includes("Paper bot started")) return "START";
  if (message.includes("tick error")) return "ERROR";
  return "STATUS";
}

function extractSlug(message: string): string | null {
  const m = message.match(/(btc-updown-15m-\d+)/);
  return m?.[1] ?? null;
}

function appendPaperLog(level: "info" | "warn" | "error", message: string): void {
  const tsIsoUtc = new Date().toISOString();
  const tsMs = Date.now();
  const slug = extractSlug(message);
  const eventType = detectEventType(message);
  try {
    const outPath = path.resolve(process.cwd(), paperLogFile);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.appendFileSync(
      outPath,
      JSON.stringify({ tsIsoUtc, tsMs, level, market, slug, eventType, message }) + "\n",
      "utf8",
    );
  } catch {
    /* ignore */
  }
  if (dbEnabled) {
    void insertPaperEvent({
      tsUtc: tsIsoUtc,
      tsMs,
      level,
      market,
      slug,
      eventType,
      message,
      payload: { cashUsd, realizedUsd, totalBuys, totalWindows },
    }).catch(() => {});
  }
}

function logInfo(message: string): void {
  console.log(`[paper] ${message}`);
  appendPaperLog("info", message);
}

function logWarn(message: string): void {
  console.warn(`[paper] ${message}`);
  appendPaperLog("warn", message);
}

async function notifyTelegram(text: string): Promise<void> {
  if (!telegramToken || !telegramChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: telegramChatId, text, disable_web_page_preview: true }),
    });
  } catch {
    /* ignore */
  }
}

async function buySide(side: Side, cents: number, slug: string, reason: string): Promise<void> {
  const cost = (cents / 100) * cele.sharesPerOrder;
  const fee = cost * feeRate;
  cashUsd -= cost + fee;
  totalBuys += 1;
  const label = side === "UP" ? "YES" : "NO";
  const msg =
    `BUY ${market.toUpperCase()} ${label} ${cele.sharesPerOrder}@${cents}c | ${reason} | #${totalBuys} | ` +
    `cash=$${cashUsd.toFixed(2)} realized=$${realizedUsd.toFixed(2)} | ${slug}`;
  logInfo(msg);
  await notifyTelegram(msg);
}

async function closeWindow(pos: SlugPosition, upMark: number, downMark: number): Promise<void> {
  const s = settleWindow(pos, upMark, downMark);
  const returnUsd = s.pairedRedeemUsd + s.unpairedUpUsd + s.unpairedDownUsd;
  const fees = s.buyUsd * feeRate * 2;
  const pnl = returnUsd - s.buyUsd - fees;
  cashUsd += returnUsd;
  realizedUsd += pnl;
  totalWindows += 1;
  const msg =
    `WINDOW END ${s.slug} | paired=${s.pairedShares.toFixed(1)} sumAvg=${s.sumAvgCents.toFixed(1)}c | ` +
    `buy=$${s.buyUsd.toFixed(2)} return=$${returnUsd.toFixed(2)} pnl=$${pnl.toFixed(2)} | ` +
    `cash=$${cashUsd.toFixed(2)} realized=$${realizedUsd.toFixed(2)} windows=${totalWindows}`;
  logInfo(msg);
  await notifyTelegram(msg);
}

async function tick(): Promise<void> {
  const now = Date.now();
  const slug = slugForCurrent15m(market);
  const q = await fetchMarketQuote(slug);

  if (position && position.slug !== q.slug) {
    await closeWindow(position, q.upMidCents, q.downMidCents);
    position = null;
  }

  if (!isQuoteTradable(q)) {
    logInfo(`${q.slug} skip bad quote up=${q.upAskCents}c down=${q.downAskCents}c`);
    return;
  }

  const intent = decideBuy(cele, q, position, now);
  if (intent) {
    if (!position) {
      position = {
        slug: q.slug,
        openedAtMs: now,
        upQty: 0,
        downQty: 0,
        upCostUsd: 0,
        downCostUsd: 0,
        upBuys: 0,
        downBuys: 0,
        lastBuyMs: 0,
        lastUpCents: null,
        lastDownCents: null,
      };
    }
    await buySide(intent.side, intent.cents, q.slug, intent.reason);
    applyBuy(position, intent.side, intent.cents, cele.sharesPerOrder, now);
  }

  const posLine = position ? formatPositionLine(position) : "flat";
  logInfo(
    `${q.slug} ask up=${q.upAskCents}c down=${q.downAskCents}c | eq=$${cashUsd.toFixed(2)} pnl=$${(cashUsd - initialUsd).toFixed(2)} | ${posLine}`,
  );
}

async function main(): Promise<void> {
  const dbUrlPresent = Boolean(process.env.DATABASE_URL?.trim());
  if (dbUrlPresent) {
    dbEnabled = await ensureDbReady().catch(() => false);
  }

  const startMsg =
    `Cele-style paper | ${market.toUpperCase()} poll=${pollMs}ms shares=${cele.sharesPerOrder} ` +
    `maxLegs/side=${cele.maxBuysPerSide} maxSumAvg=${cele.maxSumAvg} capImbal=${cele.maxSideImbalanceShares} ` +
    `start=$${initialUsd.toFixed(0)} db=${dbEnabled ? "on" : "off"}`;
  logInfo(startMsg);
  await notifyTelegram(startMsg);

  for (;;) {
    try {
      await tick();
    } catch (e) {
      logWarn(`tick error: ${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
