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
import { ClobTrader, parsePrivateKey } from "./clob-trader.js";
import { envNumber, envString } from "./env-util.js";
import type { ParsedMarket } from "./gamma.js";
import { fetchMarketQuote, isQuoteTradable } from "./market-quotes.js";
import { slugForCurrent15m } from "./slug.js";

dotenv.config();

const market = envString("LIVE_MARKET", envString("PAPER_MARKET", "btc")).toLowerCase();
const pollMs = Math.max(120, envNumber("LIVE_POLL_INTERVAL_MS", envNumber("PAPER_POLL_INTERVAL_MS", 400)));
const cele = loadCeleConfig("LIVE_");
const slippageCents = Math.max(0, envNumber("LIVE_SLIPPAGE_CENTS", 2));
const negRisk = envString("LIVE_NEG_RISK", "false").toLowerCase() === "true";
const maxBuyUsdPerDay = Math.max(0, envNumber("LIVE_MAX_BUY_USD_PER_DAY", 5000));
const tradingMode = envString("LIVE_TRADING_MODE", "dry").toLowerCase();
const confirmRisk = envString("LIVE_CONFIRM", "").toLowerCase() === "yes";

const clobApiUrl = envString("CLOB_API_URL", "https://clob.polymarket.com").replace(/\/$/, "");
const chainId = envNumber("POLYMARKET_CHAIN_ID", 137);
const rpcUrl = envString("POLYGON_RPC_URL", "");
const telegramToken = envString("TELEGRAM_BOT_TOKEN", "");
const telegramChatId = envString("TELEGRAM_CHAT_ID", "");
const liveLogFile = envString("LIVE_LOG_FILE", "data/live-logs.jsonl");

let position: SlugPosition | null = null;
let totalWindows = 0;
let totalBuys = 0;
let buyUsdToday = 0;
let buyUsdDayKey = "";
let trader: ClobTrader | null = null;
const isLive = tradingMode === "live" && confirmRisk;

function logLine(level: "info" | "warn" | "error", message: string): void {
  const prefix = isLive ? "[live]" : "[live-dry]";
  const line = `${prefix} ${message}`;
  if (level === "warn") console.warn(line);
  else if (level === "error") console.error(line);
  else console.log(line);

  try {
    const outPath = path.resolve(process.cwd(), liveLogFile);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.appendFileSync(
      outPath,
      JSON.stringify({ tsIsoUtc: new Date().toISOString(), tsMs: Date.now(), level, market, message }) + "\n",
      "utf8",
    );
  } catch {
    /* ignore */
  }
}

function logInfo(m: string): void {
  logLine("info", m);
}
function logWarn(m: string): void {
  logLine("warn", m);
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

function tokenForSide(gm: ParsedMarket, side: Side): string | null {
  const id = side === "UP" ? gm.upTokenId : gm.downTokenId;
  return id && id.length > 10 ? id : null;
}

function trackBuySpend(usd: number): boolean {
  const key = new Date().toISOString().slice(0, 10);
  if (key !== buyUsdDayKey) {
    buyUsdDayKey = key;
    buyUsdToday = 0;
  }
  if (maxBuyUsdPerDay > 0 && buyUsdToday + usd > maxBuyUsdPerDay) {
    logWarn(`daily buy cap ($${buyUsdToday.toFixed(2)} + $${usd.toFixed(2)} > $${maxBuyUsdPerDay})`);
    return false;
  }
  buyUsdToday += usd;
  return true;
}

async function buySide(side: Side, cents: number, slug: string, gm: ParsedMarket, reason: string): Promise<boolean> {
  const usd = (cents / 100) * cele.sharesPerOrder;
  if (!trackBuySpend(usd)) {
    await notifyTelegram(`LIVE SKIP: daily cap | ${slug}`);
    return false;
  }

  const tokenId = tokenForSide(gm, side);
  if (!tokenId) {
    logWarn(`no token for ${side} ${slug}`);
    return false;
  }

  const t = trader;
  if (!t) return false;

  const sideLabel = side === "UP" ? "YES" : "NO";
  const res = await t.buyFok(tokenId, cents, cele.sharesPerOrder, negRisk);
  if (!res.ok) {
    logWarn(`BUY FAIL ${sideLabel} ${cele.sharesPerOrder}@${cents}c (${reason}): ${res.error ?? "?"}`);
    return false;
  }

  totalBuys += 1;
  const mode = res.dryRun ? "DRY" : "LIVE";
  const msg = `${mode} BUY ${market.toUpperCase()} ${sideLabel} ${cele.sharesPerOrder}@${cents}c | ${reason} | #${totalBuys} | ${slug}${
    res.orderId ? ` oid=${res.orderId}` : ""
  }`;
  logInfo(msg);
  await notifyTelegram(msg);
  return true;
}

async function closeWindow(pos: SlugPosition, upMark: number, downMark: number): Promise<void> {
  const s = settleWindow(pos, upMark, downMark);
  totalWindows += 1;
  const estReturn = s.pairedRedeemUsd + s.unpairedUpUsd + s.unpairedDownUsd;
  const estPnl = estReturn - s.buyUsd;
  const msg =
    `WINDOW END ${s.slug} | paired=${s.pairedShares.toFixed(1)} sumAvg=${s.sumAvgCents.toFixed(1)}c | ` +
    `buy=$${s.buyUsd.toFixed(2)} estReturn=$${estReturn.toFixed(2)} estPnl=$${estPnl.toFixed(2)} | ` +
    `up=${s.upQty.toFixed(1)} down=${s.downQty.toFixed(1)} | holds until REDEEM on Polymarket`;
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
    const ok = await buySide(intent.side, intent.cents, q.slug, q.gm, intent.reason);
    if (ok) applyBuy(position, intent.side, intent.cents, cele.sharesPerOrder, now);
  }

  const posLine = position ? formatPositionLine(position) : "flat";
  logInfo(
    `${q.slug} ask up=${q.upAskCents}c down=${q.downAskCents}c sum=${q.upAskCents + q.downAskCents}c | ${posLine}`,
  );
}

async function main(): Promise<void> {
  if (tradingMode !== "dry" && tradingMode !== "live") {
    console.error(`LIVE_TRADING_MODE must be dry or live`);
    process.exit(1);
  }
  if (tradingMode === "live" && !confirmRisk) {
    console.error("LIVE_TRADING_MODE=live requires LIVE_CONFIRM=yes");
    process.exit(1);
  }

  const pk = parsePrivateKey(envString("POLYMARKET_PRIVATE_KEY", envString("PRIVATE_KEY", "")));
  if (!pk) {
    console.error("POLYMARKET_PRIVATE_KEY required");
    process.exit(1);
  }

  trader = new ClobTrader({
    host: clobApiUrl,
    chainId,
    privateKey: pk,
    funderAddress: envString("POLYMARKET_FUNDER_ADDRESS", envString("DEPOSIT_WALLET_ADDRESS", "")) || undefined,
    signatureType: envNumber("POLYMARKET_SIGNATURE_TYPE", 1),
    dryRun: !isLive,
    slippageCents,
    rpcUrl: rpcUrl || undefined,
  });
  await trader.init();

  const modeLabel = isLive ? "LIVE" : "DRY-RUN";
  const startMsg =
    `Cele-style bot ${modeLabel} | ${market.toUpperCase()} | poll=${pollMs}ms | ` +
    `shares=${cele.sharesPerOrder} maxLegs/side=${cele.maxBuysPerSide} maxSumAvg=${cele.maxSumAvg} ` +
    `instantSum<=${cele.maxInstantSumCents}c imbalance<=${cele.maxSideImbalanceShares} ` +
    `2ndSide=${cele.secondSideTimeThresholdMs}ms cap=$${maxBuyUsdPerDay}/day`;
  logInfo(startMsg);
  await notifyTelegram(startMsg);
  if (isLive) await notifyTelegram("LIVE ON — cele accumulation mode. Real USDC at risk.");

  for (;;) {
    try {
      await tick();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logWarn(`tick: ${msg}`);
      await notifyTelegram(`LIVE tick error: ${msg}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
