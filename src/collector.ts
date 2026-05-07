import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { fetchGammaMarket } from "./gamma.js";
import { fetchJson, fetchWithRetry } from "./http.js";
import { slugForCurrent15m } from "./slug.js";
import { ensureDbReady, insertCollectorRow } from "./db.js";

dotenv.config();

type Snapshot = {
  tsIsoUtc: string;
  tsLocal: string;
  tsMs: number;
  market: string;
  slug: string;
  conditionId: string;
  upPriceBuy: number;
  downPriceBuy: number;
  upCentsBuy: number;
  downCentsBuy: number;
  currentPrice: number | null;
  priceToBeat: number | null;
  deltaFromPriceToBeat: number | null;
  deltaFromPriceToBeatPct: number | null;
  quoteSource: "gamma" | "last_trade" | "clob_market";
  bestBid?: number;
  bestAsk?: number;
};

type TradeRow = {
  outcome?: string;
  price?: number | string;
  timestamp?: number;
};

type RawClobPrice = { price?: string | number };

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  const t = typeof raw === "string" ? raw.trim() : "";
  return t || fallback;
}

function envMarkets(): string[] {
  const csv = envString("COLLECT_MARKETS", envString("TRADING_MARKETS", "btc"));
  return csv
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function envTzMode(): "utc" | "local" {
  const raw = envString("COLLECT_TZ", "utc").toLowerCase();
  return raw === "local" ? "local" : "utc";
}

function envPriceSource(): "last_trade" | "gamma" | "clob_market" {
  const raw = envString("COLLECT_PRICE_SOURCE", "clob_market").toLowerCase();
  if (raw === "gamma") return "gamma";
  if (raw === "last_trade") return "last_trade";
  return "clob_market";
}

const intervalMs = Math.max(500, envNumber("COLLECT_INTERVAL_MS", 5000));
const outFile = envString("COLLECT_OUT_FILE", "data/market-snapshots.jsonl");
const markets = envMarkets();
const tzMode = envTzMode();
const priceSource = envPriceSource();
const clobApiUrl = envString("CLOB_API_URL", "https://clob.polymarket.com").replace(/\/$/, "");
const slugOverride = envString("COLLECT_SLUG", "");
const rtdsUrl = envString("COLLECT_RTDS_URL", "wss://ws-live-data.polymarket.com");
const onlyOnChange = envString("COLLECT_ONLY_ON_CHANGE", "true").toLowerCase() === "true";
const includeSpotContext = envString("COLLECT_INCLUDE_SPOT_CONTEXT", "false").toLowerCase() === "true";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatLocal(tsMs: number): string {
  const d = new Date(tsMs);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(
    d.getMinutes()
  )}:${pad2(d.getSeconds())}`;
}

function outPathFor(tsMs: number): string {
  const d = new Date(tsMs);
  const y = tzMode === "utc" ? d.getUTCFullYear() : d.getFullYear();
  const m = pad2((tzMode === "utc" ? d.getUTCMonth() : d.getMonth()) + 1);
  const day = pad2(tzMode === "utc" ? d.getUTCDate() : d.getDate());
  const hour = tzMode === "utc" ? d.getUTCHours() : d.getHours();
  const blockStart = Math.floor(hour / 4) * 4;
  const blockEnd = blockStart + 3;

  const parsed = path.parse(outFile);
  const ext = parsed.ext || ".jsonl";
  const base = parsed.ext ? parsed.name : parsed.base;
  const dir = parsed.dir || ".";
  const fileName = `${base}_${y}-${m}-${day}_${pad2(blockStart)}-${pad2(blockEnd)}${ext}`;
  return path.resolve(process.cwd(), dir, fileName);
}

function appendLine(outPath: string, line: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.appendFileSync(outPath, line + "\n", "utf8");
}

function toSnapshot(market: string, m: Awaited<ReturnType<typeof fetchGammaMarket>>): Snapshot {
  const now = Date.now();
  const upCents = Math.round(m.upMid * 100);
  const downCents = Math.round(m.downMid * 100);
  return {
    tsIsoUtc: new Date(now).toISOString(),
    tsLocal: formatLocal(now),
    tsMs: now,
    market,
    slug: m.slug,
    conditionId: m.conditionId,
    upPriceBuy: m.upMid,
    downPriceBuy: m.downMid,
    upCentsBuy: upCents,
    downCentsBuy: downCents,
    currentPrice: null,
    priceToBeat: null,
    deltaFromPriceToBeat: null,
    deltaFromPriceToBeatPct: null,
    quoteSource: "gamma",
    bestBid: m.bestBid,
    bestAsk: m.bestAsk,
  };
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clamp01(x: number): number {
  return Math.min(0.999, Math.max(0.001, x));
}

const beatBySlug = new Map<string, number>();
const liveCurrentByMarket = new Map<string, number>();
let rtdsStarted = false;
let binanceStarted = false;
const lastFingerprintByMarket = new Map<string, string>();

function marketSymbol(market: string): string {
  if (market === "btc") return "btcusdt";
  if (market === "eth") return "ethusdt";
  return "";
}

function parseRtdsPayload(payload: unknown): Array<{ symbol: string; value: number }> {
  const out: Array<{ symbol: string; value: number }> = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const it of node) walk(it);
      return;
    }
    const r = node as Record<string, unknown>;
    const symRaw = r.symbol;
    const valRaw = r.value;
    const sym = typeof symRaw === "string" ? symRaw.toLowerCase() : "";
    const val = toNum(valRaw);
    if (sym && val !== null) out.push({ symbol: sym, value: val });
    for (const v of Object.values(r)) walk(v);
  };
  walk(payload);
  return out;
}

function startRtdsFeed(): void {
  if (rtdsStarted) return;
  rtdsStarted = true;
  const symbols = markets.map(marketSymbol).filter(Boolean);
  if (!symbols.length) return;

  const connect = (): void => {
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(rtdsUrl);
      ws.onopen = () => {
        const msg = { type: "subscribe", topic: "crypto_prices", filter: symbols };
        ws?.send(JSON.stringify(msg));
      };
      ws.onmessage = (ev) => {
        const raw = typeof ev.data === "string" ? ev.data : "";
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw) as unknown;
          const rows = parseRtdsPayload(parsed);
          for (const row of rows) {
            if (row.symbol === "btcusdt") liveCurrentByMarket.set("btc", row.value);
            else if (row.symbol === "ethusdt") liveCurrentByMarket.set("eth", row.value);
          }
        } catch {
          /* ignore malformed ws message */
        }
      };
      ws.onclose = () => {
        setTimeout(connect, 1500);
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      };
    } catch {
      setTimeout(connect, 2500);
    }
  };

  connect();
}

function startBinanceFeed(): void {
  if (binanceStarted) return;
  binanceStarted = true;
  const streams = markets.map(marketSymbol).filter(Boolean).map((s) => `${s}@bookTicker`);
  if (!streams.length) return;
  const url = `wss://stream.binance.com:9443/stream?streams=${streams.join("/")}`;

  const connect = (): void => {
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(url);
      ws.onmessage = (ev) => {
        const raw = typeof ev.data === "string" ? ev.data : "";
        if (!raw) return;
        try {
          const msg = JSON.parse(raw) as Record<string, unknown>;
          const data = (msg.data ?? msg) as Record<string, unknown>;
          const symbol = String(data.s ?? "").toLowerCase();
          const bid = toNum(data.b);
          const ask = toNum(data.a);
          if (!symbol || bid === null || ask === null) return;
          const mid = (bid + ask) / 2;
          if (symbol === "btcusdt") liveCurrentByMarket.set("btc", mid);
          else if (symbol === "ethusdt") liveCurrentByMarket.set("eth", mid);
        } catch {
          /* ignore malformed ws */
        }
      };
      ws.onclose = () => setTimeout(connect, 1500);
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      };
    } catch {
      setTimeout(connect, 2500);
    }
  };
  connect();
}

function slugStartMs(slug: string): number | null {
  const parts = slug.split("-");
  const last = parts[parts.length - 1];
  const ts = Number(last);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return ts * 1000;
}

async function fetchSpotPrice(market: string): Promise<number | null> {
  const symbol = marketSymbol(market).toUpperCase();
  if (!symbol) return null;
  const url = `https://api.binance.com/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`;
  try {
    const res = await fetchWithRetry(url, { timeoutMs: 10_000, retries: 1 });
    if (!res.ok) return null;
    const j = (await res.json()) as { bidPrice?: string; askPrice?: string; price?: string };
    const bid = Number(j.bidPrice);
    const ask = Number(j.askPrice);
    if (Number.isFinite(bid) && Number.isFinite(ask)) return (bid + ask) / 2;
    const px = Number(j.price);
    return Number.isFinite(px) ? px : null;
  } catch {
    return null;
  }
}

async function fetchBeatAtWindowStart(market: string, slug: string): Promise<number | null> {
  const symbol = marketSymbol(market).toUpperCase();
  const startMs = slugStartMs(slug);
  if (!symbol || startMs === null) return null;
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&startTime=${startMs}&limit=1`;
  try {
    const rows = await fetchJson<unknown[]>(url, { timeoutMs: 10_000, retries: 1 });
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    if (!Array.isArray(row) || row.length < 2) return null;
    const open = Number(row[1]);
    return Number.isFinite(open) ? open : null;
  } catch {
    return null;
  }
}

async function currentPriceForMarket(market: string): Promise<number | null> {
  // Prefer fresh REST quote each tick to avoid stale websocket cache.
  return fetchSpotPrice(market);
}

async function fetchClobBuyPrice(tokenId: string): Promise<number | null> {
  const url = `${clobApiUrl}/price?token_id=${encodeURIComponent(tokenId)}&side=BUY`;
  const j = await fetchJson<RawClobPrice>(url, { timeoutMs: 20_000, retries: 2 });
  const px = toNum(j.price);
  return px !== null && px >= 0 && px <= 1 ? px : null;
}

async function clobMarketCents(
  upTokenId?: string,
  downTokenId?: string
): Promise<{ upCents: number; downCents: number } | null> {
  if (!upTokenId || !downTokenId) return null;
  let [upPx, downPx] = await Promise.all([fetchClobBuyPrice(upTokenId), fetchClobBuyPrice(downTokenId)]);

  if (upPx === null && downPx !== null) upPx = 1 - downPx;
  if (downPx === null && upPx !== null) downPx = 1 - upPx;
  if (upPx === null || downPx === null) return null;

  upPx = clamp01(upPx);
  downPx = clamp01(downPx);
  return { upCents: Math.round(upPx * 100), downCents: Math.round(downPx * 100) };
}

async function latestTradeCents(conditionId: string): Promise<{ upCents: number; downCents: number } | null> {
  const url = `https://data-api.polymarket.com/trades?market=${encodeURIComponent(conditionId)}&limit=200&offset=0`;
  const rows = await fetchJson<TradeRow[]>(url, { timeoutMs: 20_000, retries: 2 });
  let upTs = -1;
  let downTs = -1;
  let upPx: number | null = null;
  let downPx: number | null = null;

  for (const r of rows) {
    const out = String(r.outcome ?? "");
    const ts = typeof r.timestamp === "number" ? r.timestamp : -1;
    const px = toNum(r.price);
    if (px === null || !(px >= 0 && px <= 1)) continue;
    if (out === "Up" && ts >= upTs) {
      upTs = ts;
      upPx = px;
    } else if (out === "Down" && ts >= downTs) {
      downTs = ts;
      downPx = px;
    }
  }

  if (upPx === null || downPx === null) return null;
  return { upCents: Math.round(upPx * 100), downCents: Math.round(downPx * 100) };
}

async function tick(): Promise<void> {
  for (const market of markets) {
    const slug = slugOverride || slugForCurrent15m(market);
    try {
      const m = await fetchGammaMarket(slug);
      const row = toSnapshot(market, m);
      if (priceSource === "clob_market") {
        try {
          const c = await clobMarketCents(m.upTokenId, m.downTokenId);
          if (c) {
            row.upCentsBuy = c.upCents;
            row.downCentsBuy = c.downCents;
            row.upPriceBuy = c.upCents / 100;
            row.downPriceBuy = c.downCents / 100;
            row.quoteSource = "clob_market";
          }
        } catch {
          /* keep gamma snapshot on clob issues */
        }
      } else if (priceSource === "last_trade") {
        try {
          const t = await latestTradeCents(m.conditionId);
          if (t) {
            row.upCentsBuy = t.upCents;
            row.downCentsBuy = t.downCents;
            row.upPriceBuy = t.upCents / 100;
            row.downPriceBuy = t.downCents / 100;
            row.quoteSource = "last_trade";
          }
        } catch {
          /* keep gamma snapshot on trade API issues */
        }
      }
      if (includeSpotContext) {
        try {
          const spot = await currentPriceForMarket(market);
          if (spot !== null) {
            row.currentPrice = spot;
            if (!beatBySlug.has(slug)) {
              beatBySlug.set(slug, spot);
            }
            const beat = beatBySlug.get(slug) ?? spot;
            row.priceToBeat = beat;
            row.deltaFromPriceToBeat = spot - beat;
            row.deltaFromPriceToBeatPct = beat !== 0 ? ((spot - beat) / beat) * 100 : null;
          }
        } catch {
          /* keep null when spot API temporarily fails */
        }
      }
      const file = outPathFor(row.tsMs);
      const fp = `${row.slug}|${row.upCentsBuy}|${row.downCentsBuy}|${row.currentPrice?.toFixed(2) ?? "na"}|${row.priceToBeat?.toFixed(2) ?? "na"}`;
      const prev = lastFingerprintByMarket.get(market);
      if (!onlyOnChange || prev !== fp) {
        appendLine(file, JSON.stringify(row));
        await insertCollectorRow({
          collector: "api",
          tsUtc: row.tsIsoUtc,
          tsMs: row.tsMs,
          tsLocal: row.tsLocal,
          market: row.market,
          slug: row.slug,
          upCentsBuy: row.upCentsBuy,
          downCentsBuy: row.downCentsBuy,
          payload: row,
        }).catch(() => {});
        const spotMsg = includeSpotContext
          ? ` current=${row.currentPrice ?? "na"} beat=${row.priceToBeat ?? "na"}`
          : "";
        console.log(
          `[collect] ${row.tsLocal} ${market} ${row.slug} buy up=${row.upCentsBuy}c down=${row.downCentsBuy}c (${row.quoteSource})${spotMsg} -> ${file}`
        );
        lastFingerprintByMarket.set(market, fp);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[collect] ${formatLocal(Date.now())} ${market} ${slug} error: ${msg}`);
    }
  }
}

async function main(): Promise<void> {
  startRtdsFeed();
  startBinanceFeed();
  const dbEnabled = await ensureDbReady().catch(() => false);
  const example = outPathFor(Date.now());
  console.log(
    `Collector started. interval=${intervalMs}ms markets=${markets.join(",")} tz=${tzMode} source=${priceSource} slug=${slugOverride || "auto-current"} onlyOnChange=${onlyOnChange} spotContext=${includeSpotContext} db=${dbEnabled ? "on" : "off"} filePattern=${example}`
  );
  for (;;) {
    await tick();
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

