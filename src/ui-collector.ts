import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { slugForCurrent15m } from "./slug.js";
import { fetchGammaMarket } from "./gamma.js";
import { fetchJson } from "./http.js";
import { ensureDbReady, insertCollectorRow } from "./db.js";

dotenv.config();

type UiSnapshot = {
  tsIsoUtc: string;
  tsLocal: string;
  tsMs: number;
  url: string;
  slug: string;
  market: string;
  upCentsBuy: number | null;
  downCentsBuy: number | null;
};

type RawClobPrice = { price?: string | number };

function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  const t = typeof raw === "string" ? raw.trim() : "";
  return t || fallback;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatLocal(tsMs: number): string {
  const d = new Date(tsMs);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(
    d.getMinutes()
  )}:${pad2(d.getSeconds())}`;
}

function outPathFor(baseOutFile: string, tsMs: number): string {
  const d = new Date(tsMs);
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  const hour = d.getHours();
  const blockStart = Math.floor(hour / 4) * 4;
  const blockEnd = blockStart + 3;
  const parsed = path.parse(baseOutFile);
  const ext = parsed.ext || ".jsonl";
  const base = parsed.ext ? parsed.name : parsed.base;
  const dir = parsed.dir || ".";
  return path.resolve(process.cwd(), dir, `${base}_${y}-${m}-${day}_${pad2(blockStart)}-${pad2(blockEnd)}${ext}`);
}

function appendLine(outPath: string, line: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.appendFileSync(outPath, line + "\n", "utf8");
}

function toNumberLoose(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseCentsSafe(raw: string, side: "up" | "down"): number | null {
  const re = side === "up" ? /\bUp\s*(\d{1,3})\s*(?:¢|c)\b/gi : /\bDown\s*(\d{1,3})\s*(?:¢|c)\b/gi;
  const vals: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 100) vals.push(n);
  }
  return vals.length ? vals[vals.length - 1] : null;
}

function slugFromUrl(url: string): string {
  const u = new URL(url);
  const parts = u.pathname.split("/").filter(Boolean);
  const idx = parts.indexOf("event");
  return idx >= 0 && parts[idx + 1] ? parts[idx + 1] : "";
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  try {
    return (await Promise.race([p, timeout])) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function fetchClobBuyPrice(tokenId: string): Promise<number | null> {
  const url = `https://clob.polymarket.com/price?token_id=${encodeURIComponent(tokenId)}&side=BUY`;
  const j = await fetchJson<RawClobPrice>(url, { timeoutMs: 20_000, retries: 2 });
  const px = toNum(j.price);
  return px !== null && px >= 0 && px <= 1 ? px : null;
}

async function fallbackCentsFromMarket(slug: string): Promise<{ up: number | null; down: number | null }> {
  try {
    const gm = await fetchGammaMarket(slug);
    if (gm.upTokenId && gm.downTokenId) {
      const [upPx, downPx] = await Promise.all([fetchClobBuyPrice(gm.upTokenId), fetchClobBuyPrice(gm.downTokenId)]);
      if (upPx !== null && downPx !== null) return { up: Math.round(upPx * 100), down: Math.round(downPx * 100) };
    }
    return { up: Math.round(gm.upMid * 100), down: Math.round(gm.downMid * 100) };
  } catch {
    return { up: null, down: null };
  }
}

async function main(): Promise<void> {
  const intervalMs = Math.max(500, envNumber("UI_COLLECT_INTERVAL_MS", 5000));
  const tickTimeoutMs = Math.max(2000, envNumber("UI_COLLECT_TICK_TIMEOUT_MS", 12000));
  const outFile = envString("UI_COLLECT_OUT_FILE", "data/ui-market-snapshots.jsonl");
  const uiMarket = envString("UI_COLLECT_MARKET", "btc").toLowerCase();
  const uiSlug = envString("UI_COLLECT_SLUG", "");
  const fixedUrl = envString("UI_COLLECT_URL", "");
  const hasFixedSlug = Boolean(uiSlug);
  const hasFixedUrl = Boolean(fixedUrl);
  const eventUrl =
    fixedUrl || `https://polymarket.com/event/${encodeURIComponent(uiSlug || slugForCurrent15m(uiMarket))}`;

  const { chromium } = await import("playwright");
  const dbEnabled = await ensureDbReady().catch(() => false);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route("**/*", (route: any) => {
    const t = route.request().resourceType();
    if (t === "image" || t === "media" || t === "font") return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(eventUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

  let activeUrl = eventUrl;
  let slug = slugFromUrl(eventUrl);
  let market = slug.split("-")[0] || uiMarket || "unknown";
  console.log(
    `UI collector started. interval=${intervalMs}ms url=${eventUrl} mode=${hasFixedUrl || hasFixedSlug ? "fixed" : "auto-roll"} db=${dbEnabled ? "on" : "off"}`
  );

  for (;;) {
    try {
      await withTimeout(
        (async () => {
          if (!hasFixedUrl && !hasFixedSlug) {
            const nextSlug = slugForCurrent15m(uiMarket);
            const nextUrl = `https://polymarket.com/event/${encodeURIComponent(nextSlug)}`;
            if (nextUrl !== activeUrl) {
              await page.goto(nextUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
              activeUrl = nextUrl;
              slug = nextSlug;
              market = slug.split("-")[0] || uiMarket || "unknown";
              console.log(`[ui-collect] switched to ${slug}`);
            }
          }

          const tsMs = Date.now();
          const allText = (await page.innerText("body").catch(() => "")) || "";
          const btnTexts = await page
            .locator("button, [role='button']")
            .allTextContents()
            .then((arr: string[]) => arr.map((s: string) => s.trim()).filter(Boolean))
            .catch(() => []);

          let upRaw: string | null = null;
          let downRaw: string | null = null;
          for (const t of btnTexts) {
            if (!upRaw && /^Up\s*\d{1,3}\s*(?:¢|c)$/i.test(t)) upRaw = t;
            if (!downRaw && /^Down\s*\d{1,3}\s*(?:¢|c)$/i.test(t)) downRaw = t;
          }
          if (!upRaw || !downRaw) {
            const mAll = allText.match(/\b(?:Up|Down)\s*\d{1,3}\s*(?:¢|c)\b/gi) ?? [];
            for (const m of mAll) {
              if (!upRaw && /^up/i.test(m)) upRaw = m;
              if (!downRaw && /^down/i.test(m)) downRaw = m;
            }
          }

          const extracted = { upRaw, downRaw };

          let up = extracted.upRaw ? parseCentsSafe(extracted.upRaw, "up") : null;
          let down = extracted.downRaw ? parseCentsSafe(extracted.downRaw, "down") : null;
          if (up === null || down === null) {
            const fb = await fallbackCentsFromMarket(slug);
            if (up === null) up = fb.up;
            if (down === null) down = fb.down;
          }

          const row: UiSnapshot = {
            tsIsoUtc: new Date(tsMs).toISOString(),
            tsLocal: formatLocal(tsMs),
            tsMs,
            url: activeUrl,
            slug,
            market,
            upCentsBuy: up,
            downCentsBuy: down,
          };

          const outPath = outPathFor(outFile, tsMs);
          appendLine(outPath, JSON.stringify(row));
          await insertCollectorRow({
            collector: "ui",
            tsUtc: row.tsIsoUtc,
            tsMs: row.tsMs,
            tsLocal: row.tsLocal,
            market: row.market,
            slug: row.slug,
            upCentsBuy: row.upCentsBuy,
            downCentsBuy: row.downCentsBuy,
            payload: row,
          }).catch(() => {});
          console.log(
            `[ui-collect] ${row.tsLocal} ${row.slug} up=${row.upCentsBuy === null ? "na" : `${row.upCentsBuy}c`} down=${row.downCentsBuy === null ? "na" : `${row.downCentsBuy}c`} -> ${outPath}`
          );
        })(),
        tickTimeoutMs,
        "ui-collect tick"
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[ui-collect] tick error: ${msg}; reloading page...`);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

