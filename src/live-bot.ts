import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { ClobTrader, parsePrivateKey } from "./clob-trader.js";
import { fetchGammaMarket, type ParsedMarket } from "./gamma.js";
import { fetchJson } from "./http.js";
import { slugForCurrent15m } from "./slug.js";

dotenv.config();

type Side = "UP" | "DOWN";
type PriceRow = { upCents: number; downCents: number; slug: string; gm: ParsedMarket };
type ClobPrice = { price?: string | number };

type Position = {
  slug: string;
  openedAtMs: number;
  firstSide: Side;
  firstLegPrices: number[];
  secondLegPrices: number[];
  lastFirstFillCents: number;
  forced: boolean;
  gm: ParsedMarket;
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

const market = envString("LIVE_MARKET", envString("PAPER_MARKET", "btc")).toLowerCase();
const pollMs = Math.max(500, envNumber("LIVE_POLL_INTERVAL_MS", envNumber("PAPER_POLL_INTERVAL_MS", 2500)));
const maxPairSumCents = clampCents(envNumber("LIVE_MAX_PAIR_SUM_CENTS", envNumber("PAPER_MAX_PAIR_SUM_CENTS", 98)));
const firstLegMaxCents = clampCents(envNumber("LIVE_FIRST_LEG_MAX_CENTS", envNumber("PAPER_FIRST_LEG_MAX_CENTS", 52)));
const secondLegTimeoutSec = Math.max(1, envNumber("LIVE_SECOND_LEG_TIMEOUT_SEC", envNumber("PAPER_SECOND_LEG_TIMEOUT_SEC", 14)));
const maxLegsPerSide = Math.max(1, envNumber("LIVE_MAX_LEGS_PER_SIDE", envNumber("PAPER_MAX_LEGS_PER_SIDE", 3)));
const addStepCents = Math.max(1, envNumber("LIVE_ADD_STEP_CENTS", envNumber("PAPER_ADD_STEP_CENTS", 3)));
const forceSecondLeg = envString("LIVE_FORCE_SECOND_LEG", envString("PAPER_FORCE_SECOND_LEG", "true")).toLowerCase() === "true";
const sharesPerLeg = Math.max(0.01, envNumber("LIVE_SHARES_PER_LEG", envNumber("PAPER_SHARES_PER_LEG", 10)));
const slippageCents = Math.max(0, envNumber("LIVE_SLIPPAGE_CENTS", 2));
const negRisk = envString("LIVE_NEG_RISK", "false").toLowerCase() === "true";
const maxBuyUsdPerDay = Math.max(0, envNumber("LIVE_MAX_BUY_USD_PER_DAY", 500));
const tradingMode = envString("LIVE_TRADING_MODE", "dry").toLowerCase();
const confirmRisk = envString("LIVE_CONFIRM", "").toLowerCase() === "yes";

const clobApiUrl = envString("CLOB_API_URL", "https://clob.polymarket.com").replace(/\/$/, "");
const chainId = envNumber("POLYMARKET_CHAIN_ID", 137);
const rpcUrl = envString("POLYGON_RPC_URL", "");
const telegramToken = envString("TELEGRAM_BOT_TOKEN", "");
const telegramChatId = envString("TELEGRAM_CHAT_ID", "");
const liveLogFile = envString("LIVE_LOG_FILE", "data/live-logs.jsonl");

let position: Position | null = null;
let totalTrades = 0;
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

  const tsIsoUtc = new Date().toISOString();
  try {
    const outPath = path.resolve(process.cwd(), liveLogFile);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.appendFileSync(
      outPath,
      JSON.stringify({ tsIsoUtc, tsMs: Date.now(), level, market, message }) + "\n",
      "utf8"
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

function trackBuySpend(cents: number): boolean {
  const key = new Date().toISOString().slice(0, 10);
  if (key !== buyUsdDayKey) {
    buyUsdDayKey = key;
    buyUsdToday = 0;
  }
  const usd = (cents / 100) * sharesPerLeg;
  if (maxBuyUsdPerDay > 0 && buyUsdToday + usd > maxBuyUsdPerDay) {
    logWarn(`daily buy cap reached ($${buyUsdToday.toFixed(2)} + $${usd.toFixed(2)} > $${maxBuyUsdPerDay})`);
    return false;
  }
  buyUsdToday += usd;
  return true;
}

async function fetchClobBuyPrice(tokenId?: string): Promise<number | null> {
  if (!tokenId) return null;
  const url = `${clobApiUrl}/price?token_id=${encodeURIComponent(tokenId)}&side=BUY`;
  try {
    const j = await fetchJson<ClobPrice>(url, { timeoutMs: 5000, retries: 1 });
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
  return { upCents: clampCents(up * 100), downCents: clampCents(down * 100), slug: gm.slug, gm };
}

async function buyLeg(side: Side, cents: number, slug: string, gm: ParsedMarket): Promise<boolean> {
  if (!trackBuySpend(cents)) {
    await notifyTelegram(`LIVE SKIP BUY: daily cap | ${slug}`);
    return false;
  }

  const tokenId = tokenForSide(gm, side);
  if (!tokenId) {
    logWarn(`no token id for ${side} on ${slug}`);
    return false;
  }

  const sideLabel = side === "UP" ? "YES" : "NO";
  const t = trader;
  if (!t) return false;

  const res = await t.buyFok(tokenId, cents, sharesPerLeg, negRisk);
  if (!res.ok) {
    const err = res.error ?? "unknown";
    logWarn(`BUY FAILED ${sideLabel} ${sharesPerLeg} @ ${cents}c: ${err}`);
    await notifyTelegram(`LIVE BUY FAILED ${market.toUpperCase()} ${sideLabel} @ ${cents}c | ${err}`);
    return false;
  }

  totalBuys += 1;
  const mode = res.dryRun ? "DRY" : "LIVE";
  const msg = `${mode} BUY ${market.toUpperCase()} ${sideLabel} ${sharesPerLeg} @ ${cents}c | buys=${totalBuys} | ${slug}${
    res.orderId ? ` | oid=${res.orderId}` : ""
  }`;
  logInfo(msg);
  await notifyTelegram(msg);
  return true;
}

async function tryOpenPosition(pr: PriceRow, now: number): Promise<void> {
  if (position) return;
  const firstSide: Side = pr.upCents <= pr.downCents ? "UP" : "DOWN";
  const firstPrice = firstSide === "UP" ? pr.upCents : pr.downCents;
  const secondPrice = firstSide === "UP" ? pr.downCents : pr.upCents;
  if (firstPrice > firstLegMaxCents) return;
  if (firstPrice + secondPrice > maxPairSumCents) return;

  const ok = await buyLeg(firstSide, firstPrice, pr.slug, pr.gm);
  if (!ok) return;

  position = {
    slug: pr.slug,
    openedAtMs: now,
    firstSide,
    firstLegPrices: [firstPrice],
    secondLegPrices: [],
    lastFirstFillCents: firstPrice,
    forced: false,
    gm: pr.gm,
  };
}

async function settlePosition(pos: Position, now: number): Promise<void> {
  const pairs = Math.min(pos.firstLegPrices.length, pos.secondLegPrices.length);
  if (pairs <= 0) return;

  const avgFirst = mean(pos.firstLegPrices);
  const avgSecond = mean(pos.secondLegPrices);
  const pairSum = avgFirst + avgSecond;
  const grossPerPair = ((100 - pairSum) / 100) * sharesPerLeg;
  const pnlEst = grossPerPair * pairs;

  totalTrades += 1;
  const elapsedSec = ((now - pos.openedAtMs) / 1000).toFixed(1);
  const closeMsg = `PAIR DONE ${pos.slug} | pairs=${pairs} | sum=${pairSum.toFixed(2)}c | forced=${
    pos.forced ? "yes" : "no"
  } | est_pnl=$${pnlEst.toFixed(3)} | trades=${totalTrades} | wait=${elapsedSec}s | tokens held until merge/resolve`;
  logInfo(closeMsg);
  await notifyTelegram(closeMsg);
}

async function managePosition(pr: PriceRow, now: number): Promise<void> {
  const pos = position;
  if (!pos) return;

  const gm = pr.slug === pos.slug ? pr.gm : pos.gm;

  if (pos.slug !== pr.slug) {
    const secondNow = pos.firstSide === "UP" ? pr.downCents : pr.upCents;
    while (pos.secondLegPrices.length < pos.firstLegPrices.length) {
      const ok = await buyLeg(pos.firstSide === "UP" ? "DOWN" : "UP", secondNow, pos.slug, gm);
      if (!ok) break;
      pos.secondLegPrices.push(secondNow);
      pos.forced = true;
    }
    if (pos.secondLegPrices.length >= pos.firstLegPrices.length) {
      await settlePosition(pos, now);
      position = null;
    }
    return;
  }

  const firstNow = pos.firstSide === "UP" ? pr.upCents : pr.downCents;
  const secondNow = pos.firstSide === "UP" ? pr.downCents : pr.upCents;

  if (
    pos.firstLegPrices.length < maxLegsPerSide &&
    firstNow <= firstLegMaxCents &&
    firstNow <= pos.lastFirstFillCents - addStepCents
  ) {
    const ok = await buyLeg(pos.firstSide, firstNow, pr.slug, gm);
    if (ok) {
      pos.firstLegPrices.push(firstNow);
      pos.lastFirstFillCents = firstNow;
    }
  }

  while (pos.secondLegPrices.length < pos.firstLegPrices.length) {
    const nextAvgFirst = mean(pos.firstLegPrices);
    const nextAvgSecond = mean([...pos.secondLegPrices, secondNow]);
    if (nextAvgFirst + nextAvgSecond <= maxPairSumCents) {
      const ok = await buyLeg(pos.firstSide === "UP" ? "DOWN" : "UP", secondNow, pr.slug, gm);
      if (!ok) break;
      pos.secondLegPrices.push(secondNow);
    } else {
      break;
    }
  }

  const timeoutMs = secondLegTimeoutSec * 1000;
  if (forceSecondLeg && now - pos.openedAtMs >= timeoutMs && pos.secondLegPrices.length < pos.firstLegPrices.length) {
    while (pos.secondLegPrices.length < pos.firstLegPrices.length) {
      const ok = await buyLeg(pos.firstSide === "UP" ? "DOWN" : "UP", secondNow, pr.slug, gm);
      if (!ok) break;
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
    ? `open=${position.firstSide} legs ${position.firstLegPrices.length}/${position.secondLegPrices.length}`
    : "open=none";
  logInfo(`${pr.slug} up=${pr.upCents}c down=${pr.downCents}c ${openInfo}`);
}

async function main(): Promise<void> {
  if (tradingMode !== "dry" && tradingMode !== "live") {
    console.error(`LIVE_TRADING_MODE must be "dry" or "live", got: ${tradingMode}`);
    process.exit(1);
  }

  if (tradingMode === "live" && !confirmRisk) {
    console.error('LIVE_TRADING_MODE=live requires LIVE_CONFIRM=yes');
    process.exit(1);
  }

  const pk = parsePrivateKey(envString("POLYMARKET_PRIVATE_KEY", envString("PRIVATE_KEY", "")));
  if (!pk) {
    console.error("POLYMARKET_PRIVATE_KEY (0x + 64 hex) is required for live bot");
    process.exit(1);
  }

  const funder = envString("POLYMARKET_FUNDER_ADDRESS", envString("DEPOSIT_WALLET_ADDRESS", ""));
  const signatureType = envNumber("POLYMARKET_SIGNATURE_TYPE", 1);

  trader = new ClobTrader({
    host: clobApiUrl,
    chainId,
    privateKey: pk,
    funderAddress: funder || undefined,
    signatureType,
    dryRun: !isLive,
    slippageCents,
    rpcUrl: rpcUrl || undefined,
  });

  await trader.init();

  const modeLabel = isLive ? "LIVE (real orders)" : "DRY-RUN (no orders posted)";
  const startMsg = `Live bot ${modeLabel}: ${market.toUpperCase()} | sum<=${maxPairSumCents} first<=${firstLegMaxCents} timeout=${secondLegTimeoutSec}s legs<=${maxLegsPerSide} step=${addStepCents}c shares=${sharesPerLeg} slip=${slippageCents}c cap=$${maxBuyUsdPerDay}/day`;
  logInfo(startMsg);
  await notifyTelegram(startMsg);

  if (isLive) {
    await notifyTelegram("⚠️ LIVE trading ON — real USDC at risk. Stop paper bot if it shares the same wallet.");
  }

  for (;;) {
    try {
      await tick();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logWarn(`tick error: ${msg}`);
      await notifyTelegram(`LIVE tick error: ${msg}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
