import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fetchGammaMarket } from "./gamma.js";
import { fetchJson } from "./http.js";
import { slugForCurrent15m } from "./slug.js";

dotenv.config();

type Side = "UP" | "DOWN";
type PriceRow = { upCents: number; downCents: number; slug: string };
type ClobPrice = { price?: string | number };

type Position = {
  slug: string;
  openedAtMs: number;
  firstSide: Side;
  firstLegPrices: number[];
  secondLegPrices: number[];
  lastFirstFillCents: number;
  forced: boolean;
};

function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  const v = typeof raw === "string" ? raw.trim() : "";
  return v || fallback;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function clampCents(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function mean(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

const market = envString("PAPER_MARKET", "btc").toLowerCase();
const pollMs = Math.max(500, envNumber("PAPER_POLL_INTERVAL_MS", 2500));
const maxPairSumCents = clampCents(envNumber("PAPER_MAX_PAIR_SUM_CENTS", 98));
const firstLegMaxCents = clampCents(envNumber("PAPER_FIRST_LEG_MAX_CENTS", 55));
const secondLegTimeoutSec = Math.max(1, envNumber("PAPER_SECOND_LEG_TIMEOUT_SEC", 12));
const maxLegsPerSide = Math.max(1, envNumber("PAPER_MAX_LEGS_PER_SIDE", 4));
const addStepCents = Math.max(1, envNumber("PAPER_ADD_STEP_CENTS", 2));
const forceSecondLeg = envString("PAPER_FORCE_SECOND_LEG", "true").toLowerCase() === "true";
const sharesPerLeg = Math.max(0.01, envNumber("PAPER_SHARES_PER_LEG", 10));
const feeRate = Math.max(0, envNumber("PAPER_FEE_RATE", 0.00072));
const initialUsd = Math.max(1, envNumber("PAPER_INITIAL_USD", 1000));
const clobApiUrl = envString("CLOB_API_URL", "https://clob.polymarket.com").replace(/\/$/, "");
const telegramToken = envString("TELEGRAM_BOT_TOKEN", "");
const telegramChatId = envString("TELEGRAM_CHAT_ID", "");
const paperLogFile = envString("PAPER_LOG_FILE", "data/paper-logs.jsonl");

let cashUsd = initialUsd;
let realizedUsd = 0;
let position: Position | null = null;
let totalTrades = 0;
let totalBuys = 0;

function appendPaperLog(level: "info" | "warn" | "error", message: string): void {
  try {
    const outPath = path.resolve(process.cwd(), paperLogFile);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const row = {
      tsIsoUtc: new Date().toISOString(),
      level,
      message,
    };
    fs.appendFileSync(outPath, JSON.stringify(row) + "\n", "utf8");
  } catch {
    /* ignore file logging errors */
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
  const url = `https://api.telegram.org/bot${telegramToken}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text,
        disable_web_page_preview: true,
      }),
    });
  } catch {
    /* ignore telegram errors */
  }
}

async function fetchClobBuyPrice(tokenId?: string): Promise<number | null> {
  if (!tokenId) return null;
  const url = `${clobApiUrl}/price?token_id=${encodeURIComponent(tokenId)}&side=BUY`;
  try {
    const j = await fetchJson<ClobPrice>(url, { timeoutMs: 3500, retries: 0 });
    const px = typeof j.price === "string" ? Number(j.price) : typeof j.price === "number" ? j.price : NaN;
    if (!Number.isFinite(px)) return null;
    return Math.max(0.001, Math.min(0.999, px));
  } catch {
    return null;
  }
}

async function getLivePrices(slug: string): Promise<PriceRow> {
  const gm = await fetchGammaMarket(slug);
  const [upPx, downPx] = await Promise.all([fetchClobBuyPrice(gm.upTokenId), fetchClobBuyPrice(gm.downTokenId)]);
  const up = upPx ?? gm.upMid;
  const down = downPx ?? gm.downMid;
  return { upCents: clampCents(up * 100), downCents: clampCents(down * 100), slug: gm.slug };
}

async function buyLeg(side: Side, cents: number, slug: string): Promise<void> {
  const px = cents / 100;
  const cost = px * sharesPerLeg;
  const fee = cost * feeRate;
  cashUsd -= cost + fee;
  totalBuys += 1;
  const sideLabel = side === "UP" ? "YES" : "NO";
  const msg = `BUY ${market.toUpperCase()} ${sideLabel} ${sharesPerLeg} @ ${cents}c | buys=${totalBuys} | cash=$${cashUsd.toFixed(
    2
  )} | realized=$${realizedUsd.toFixed(2)} | ${slug}`;
  logInfo(msg);
  await notifyTelegram(msg);
}

async function tryOpenPosition(pr: PriceRow, now: number): Promise<void> {
  if (position) return;
  const firstSide: Side = pr.upCents <= pr.downCents ? "UP" : "DOWN";
  const firstPrice = firstSide === "UP" ? pr.upCents : pr.downCents;
  const secondPrice = firstSide === "UP" ? pr.downCents : pr.upCents;
  if (firstPrice > firstLegMaxCents) return;
  if (firstPrice + secondPrice > maxPairSumCents) return;
  await buyLeg(firstSide, firstPrice, pr.slug);
  position = {
    slug: pr.slug,
    openedAtMs: now,
    firstSide,
    firstLegPrices: [firstPrice],
    secondLegPrices: [],
    lastFirstFillCents: firstPrice,
    forced: false,
  };
}

async function settlePosition(pos: Position, now: number): Promise<void> {
  const pairs = Math.min(pos.firstLegPrices.length, pos.secondLegPrices.length);
  if (pairs <= 0) return;
  const payout = pairs * sharesPerLeg;
  cashUsd += payout;
  const avgFirst = mean(pos.firstLegPrices);
  const avgSecond = mean(pos.secondLegPrices);
  const pairSum = avgFirst + avgSecond;
  const grossPerPair = (100 - pairSum) / 100 * sharesPerLeg;
  const feePaid =
    (pos.firstLegPrices.reduce((a, c) => a + c / 100, 0) + pos.secondLegPrices.reduce((a, c) => a + c / 100, 0)) *
    sharesPerLeg *
    feeRate;
  const pnl = grossPerPair * pairs - feePaid;
  realizedUsd += pnl;
  totalTrades += 1;
  const elapsedSec = ((now - pos.openedAtMs) / 1000).toFixed(1);
  const closeMsg = `CLOSE ${pos.slug} | pairs=${pairs} | sum=${pairSum.toFixed(2)}c | forced=${
    pos.forced ? "yes" : "no"
  } | pnl=$${pnl.toFixed(3)} | realized=$${realizedUsd.toFixed(2)} | cash=$${cashUsd.toFixed(
    2
  )} | trades=${totalTrades} | wait=${elapsedSec}s`;
  logInfo(closeMsg);
  await notifyTelegram(closeMsg);
}

async function managePosition(pr: PriceRow, now: number): Promise<void> {
  const pos = position;
  if (!pos) return;
  if (pos.slug !== pr.slug) {
    const secondNow = pos.firstSide === "UP" ? pr.downCents : pr.upCents;
    while (pos.secondLegPrices.length < pos.firstLegPrices.length) {
      await buyLeg(pos.firstSide === "UP" ? "DOWN" : "UP", secondNow, pos.slug);
      pos.secondLegPrices.push(secondNow);
      pos.forced = true;
    }
    await settlePosition(pos, now);
    position = null;
    return;
  }

  const firstNow = pos.firstSide === "UP" ? pr.upCents : pr.downCents;
  const secondNow = pos.firstSide === "UP" ? pr.downCents : pr.upCents;

  if (
    pos.firstLegPrices.length < maxLegsPerSide &&
    firstNow <= firstLegMaxCents &&
    firstNow <= pos.lastFirstFillCents - addStepCents
  ) {
    await buyLeg(pos.firstSide, firstNow, pr.slug);
    pos.firstLegPrices.push(firstNow);
    pos.lastFirstFillCents = firstNow;
  }

  while (pos.secondLegPrices.length < pos.firstLegPrices.length) {
    const nextAvgFirst = mean(pos.firstLegPrices);
    const nextAvgSecond = mean([...pos.secondLegPrices, secondNow]);
    if (nextAvgFirst + nextAvgSecond <= maxPairSumCents) {
      await buyLeg(pos.firstSide === "UP" ? "DOWN" : "UP", secondNow, pr.slug);
      pos.secondLegPrices.push(secondNow);
    } else {
      break;
    }
  }

  const timeoutMs = secondLegTimeoutSec * 1000;
  if (forceSecondLeg && now - pos.openedAtMs >= timeoutMs && pos.secondLegPrices.length < pos.firstLegPrices.length) {
    while (pos.secondLegPrices.length < pos.firstLegPrices.length) {
      await buyLeg(pos.firstSide === "UP" ? "DOWN" : "UP", secondNow, pr.slug);
      pos.secondLegPrices.push(secondNow);
      pos.forced = true;
    }
  }

  if (pos.secondLegPrices.length >= pos.firstLegPrices.length && pos.firstLegPrices.length > 0) {
    await settlePosition(pos, now);
    position = null;
  }
}

async function tick(): Promise<void> {
  const now = Date.now();
  const slug = slugForCurrent15m(market);
  const pr = await getLivePrices(slug);
  await managePosition(pr, now);
  await tryOpenPosition(pr, now);
  const openInfo = position
    ? `open=${position.firstSide} legs ${position.firstLegPrices.length}/${position.secondLegPrices.length} slug=${position.slug}`
    : "open=none";
  const equity = cashUsd;
  logInfo(
    `${new Date(now).toISOString()} ${pr.slug} up=${pr.upCents}c down=${pr.downCents} cash=$${cashUsd.toFixed(
      2
    )} eq=$${equity.toFixed(2)} pnl=$${(equity - initialUsd).toFixed(2)} ${openInfo}`
  );
}

async function main(): Promise<void> {
  logInfo(
    `Paper bot started. market=${market} poll=${pollMs}ms sum<=${maxPairSumCents} first<=${firstLegMaxCents} timeout=${secondLegTimeoutSec}s legs<=${maxLegsPerSide} step=${addStepCents}c shares=${sharesPerLeg} start=$${initialUsd.toFixed(
      2
    )} telegram=${telegramToken && telegramChatId ? "on" : "off"} logFile=${paperLogFile}`
  );
  await notifyTelegram(
    `Paper bot started: ${market.toUpperCase()} | sum<=${maxPairSumCents} first<=${firstLegMaxCents} timeout=${secondLegTimeoutSec}s legs<=${maxLegsPerSide} step=${addStepCents}c`
  );
  for (;;) {
    try {
      await tick();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logWarn(`tick error: ${msg}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(e);
  appendPaperLog("error", `fatal: ${msg}`);
  process.exit(1);
});

