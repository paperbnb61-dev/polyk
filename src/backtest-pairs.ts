import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config();

type Tick = {
  tsMs: number;
  market: string;
  slug: string;
  upCentsBuy: number;
  downCentsBuy: number;
};

type CompletedTrade = {
  market: string;
  slug: string;
  openedAtMs: number;
  closedAtMs: number;
  firstSide: "UP" | "DOWN"; // the side opened first
  legsPerSide: number;
  avgFirstSideCents: number;
  avgSecondSideCents: number;
  pairSumCents: number; // avgFirst + avgSecond
  pnlUsd: number;
  waitMs: number;
  forcedSecondLeg: boolean; // true if any opposite legs were forced at timeout
};

type Config = {
  source: "auto" | "db" | "files";
  dataDir: string;
  market: string;
  dbCollector: "all" | "api" | "ui";
  dbLimit: number;
  feeRate: number;
  stakeUsdPerPair: number;
  maxPairSumCents: number[];
  firstLegMaxCents: number[];
  secondLegTimeoutSec: number[];
  maxLegsPerSide: number[];
  addStepCents: number[];
  maxEntriesPerSlug: number;
  forceSecondLegAtTimeout: boolean;
  minTicksPerSlug: number;
  topN: number;
  minTrades: number;
  maxForcedRatePct: number;
};

type RunResult = {
  maxPairSumCents: number;
  firstLegMaxCents: number;
  secondLegTimeoutSec: number;
  maxLegsPerSide: number;
  addStepCents: number;
  totalTrades: number;
  forcedSecondLegTrades: number;
  avgLegsPerSide: number;
  avgPairSumCents: number;
  avgWaitSec: number;
  completionRatePct: number;
  pnlUsd: number;
};

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

function parseCsvInts(csv: string): number[] {
  return csv
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n))
    .map((n) => Math.trunc(n));
}

function loadConfig(): Config {
  const sourceRaw = envString("BACKTEST_SOURCE", "auto").toLowerCase();
  const source: "auto" | "db" | "files" = sourceRaw === "db" ? "db" : sourceRaw === "files" ? "files" : "auto";
  const collectorRaw = envString("BACKTEST_DB_COLLECTOR", "all").toLowerCase();
  const dbCollector: "all" | "api" | "ui" = collectorRaw === "api" ? "api" : collectorRaw === "ui" ? "ui" : "all";
  return {
    source,
    dataDir: path.resolve(process.cwd(), envString("BACKTEST_DATA_DIR", "data")),
    market: envString("BACKTEST_MARKET", "btc").toLowerCase(),
    dbCollector,
    dbLimit: Math.max(0, envNumber("BACKTEST_DB_LIMIT", 0)),
    feeRate: Math.max(0, envNumber("BACKTEST_FEE_RATE", 0.00072)),
    stakeUsdPerPair: Math.max(1, envNumber("BACKTEST_STAKE_USD", 100)),
    maxPairSumCents: parseCsvInts(envString("BACKTEST_MAX_PAIR_SUM_CENTS", "97,98,99,100")),
    firstLegMaxCents: parseCsvInts(envString("BACKTEST_FIRST_LEG_MAX_CENTS", "45,55,65,75")),
    secondLegTimeoutSec: parseCsvInts(envString("BACKTEST_SECOND_LEG_TIMEOUT_SEC", "3,5,8,12")),
    maxLegsPerSide: parseCsvInts(envString("BACKTEST_MAX_LEGS_PER_SIDE", "1,2,3,4")),
    addStepCents: parseCsvInts(envString("BACKTEST_ADD_STEP_CENTS", "1,2,3")),
    maxEntriesPerSlug: Math.max(1, envNumber("BACKTEST_MAX_ENTRIES_PER_SLUG", 1)),
    forceSecondLegAtTimeout: envString("BACKTEST_FORCE_SECOND_LEG", "true").toLowerCase() === "true",
    minTicksPerSlug: Math.max(1, envNumber("BACKTEST_MIN_TICKS_PER_SLUG", 3)),
    topN: Math.max(1, envNumber("BACKTEST_TOP_N", 10)),
    minTrades: Math.max(0, envNumber("BACKTEST_MIN_TRADES", 10)),
    maxForcedRatePct: Math.max(0, Math.min(100, envNumber("BACKTEST_MAX_FORCED_RATE_PCT", 60))),
  };
}

function listJsonlFiles(dataDir: string): string[] {
  if (!fs.existsSync(dataDir)) return [];
  const names = fs.readdirSync(dataDir);
  return names
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => path.join(dataDir, n))
    .sort();
}

function toMaybeCents(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.trunc(v);
  if (n < 0 || n > 100) return null;
  return n;
}

function parseLine(line: string, wantedMarket: string): Tick | null {
  if (!line.trim()) return null;
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const market = String(raw.market ?? "").toLowerCase();
    if (market !== wantedMarket) return null;
    const slug = String(raw.slug ?? "");
    const tsMs = Number(raw.tsMs);
    const up = toMaybeCents(raw.upCentsBuy);
    const down = toMaybeCents(raw.downCentsBuy);
    if (!slug || !Number.isFinite(tsMs) || up === null || down === null) return null;
    return { tsMs, market, slug, upCentsBuy: up, downCentsBuy: down };
  } catch {
    return null;
  }
}

function loadTicks(cfg: Config): Tick[] {
  const files = listJsonlFiles(cfg.dataDir);
  const out: Tick[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const tick = parseLine(line, cfg.market);
      if (tick) out.push(tick);
    }
  }
  out.sort((a, b) => a.tsMs - b.tsMs);
  return out;
}

async function loadTicksFromDb(cfg: Config): Promise<Tick[]> {
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set. Cannot read ticks from Postgres.");
  }
  const pool: any = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
    max: 3,
  });
  try {
    const whereParts: string[] = ["market = $1", "up_cents_buy IS NOT NULL", "down_cents_buy IS NOT NULL"];
    const params: Array<string | number> = [cfg.market];
    if (cfg.dbCollector !== "all") {
      params.push(cfg.dbCollector);
      whereParts.push(`collector = $${params.length}`);
    }
    const limitClause = cfg.dbLimit > 0 ? `LIMIT ${Math.trunc(cfg.dbLimit)}` : "";
    const sql = `
      SELECT ts_ms, market, slug, up_cents_buy, down_cents_buy
      FROM collector_rows
      WHERE ${whereParts.join(" AND ")}
      ORDER BY ts_ms ASC
      ${limitClause}
    `;
    const res = await pool.query(sql, params);
    const out: Tick[] = [];
    for (const row of res.rows as Array<Record<string, unknown>>) {
      const tsMs = Number(row.ts_ms);
      const market = String(row.market ?? "").toLowerCase();
      const slug = String(row.slug ?? "");
      const up = toMaybeCents(row.up_cents_buy);
      const down = toMaybeCents(row.down_cents_buy);
      if (!Number.isFinite(tsMs) || !slug || market !== cfg.market || up === null || down === null) continue;
      out.push({ tsMs, market, slug, upCentsBuy: up, downCentsBuy: down });
    }
    return out;
  } finally {
    await pool.end().catch(() => {});
  }
}

function feeUsd(totalCostUsd: number, feeRate: number): number {
  return totalCostUsd * feeRate;
}

function pnlPerPairUsd(pairSumCents: number, stakeUsd: number, feeRate: number): number {
  const cost = pairSumCents / 100;
  const grossPerShare = 1 - cost;
  const feePerShare = feeUsd(cost, feeRate);
  return (grossPerShare - feePerShare) * stakeUsd;
}

function runStrategy(
  ticksBySlug: Map<string, Tick[]>,
  cfg: Config,
  maxPairSumCents: number,
  firstLegMaxCents: number,
  secondLegTimeoutSec: number,
  maxLegsPerSide: number,
  addStepCents: number
): { trades: CompletedTrade[]; totalOpens: number; completed: number } {
  const trades: CompletedTrade[] = [];
  let totalOpens = 0;
  let completed = 0;
  const timeoutMs = secondLegTimeoutSec * 1000;

  for (const [slug, ticks] of ticksBySlug) {
    if (ticks.length < cfg.minTicksPerSlug) continue;
    let entriesInSlug = 0;
    let i = 0;
    while (i < ticks.length && entriesInSlug < cfg.maxEntriesPerSlug) {
      const t0 = ticks[i];
      const up = t0.upCentsBuy;
      const down = t0.downCentsBuy;
      const firstSide: "UP" | "DOWN" = up <= down ? "UP" : "DOWN";
      const firstPrice = firstSide === "UP" ? up : down;
      const secondAtOpen = firstSide === "UP" ? down : up;
      if (firstPrice > firstLegMaxCents || firstPrice + secondAtOpen > maxPairSumCents) {
        i += 1;
        continue;
      }
      totalOpens += 1;
      entriesInSlug += 1;
      const openedAt = t0.tsMs;
      let closedAt = openedAt;
      let forced = false;

      let qFirst = 1;
      let qSecond = 0;
      let spentFirst = firstPrice;
      let spentSecond = 0;
      let lastFirstFill = firstPrice;
      let lastSecondFill: number | null = null;

      let j = i;
      while (j < ticks.length) {
        const tj = ticks[j];
        const firstNow = firstSide === "UP" ? tj.upCentsBuy : tj.downCentsBuy;
        const secondNow = firstSide === "UP" ? tj.downCentsBuy : tj.upCentsBuy;

        // Add to the first side only when price improves by configured step.
        if (qFirst < maxLegsPerSide && firstNow <= firstLegMaxCents && firstNow <= lastFirstFill - addStepCents) {
          qFirst += 1;
          spentFirst += firstNow;
          lastFirstFill = firstNow;
        }

        // Add one opposite leg when resulting average pair sum stays within threshold.
        if (qSecond < qFirst) {
          const nextAvgFirst = spentFirst / qFirst;
          const nextAvgSecond = (spentSecond + secondNow) / (qSecond + 1);
          if (nextAvgFirst + nextAvgSecond <= maxPairSumCents) {
            qSecond += 1;
            spentSecond += secondNow;
            lastSecondFill = secondNow;
            if (qSecond === qFirst) {
              closedAt = tj.tsMs;
            }
          }
        }

        if (tj.tsMs - openedAt >= timeoutMs) {
          if (cfg.forceSecondLegAtTimeout) {
            while (qSecond < qFirst) {
              qSecond += 1;
              spentSecond += secondNow;
              lastSecondFill = secondNow;
              forced = true;
            }
            closedAt = tj.tsMs;
          }
          break;
        }
        if (qFirst >= maxLegsPerSide && qSecond >= qFirst) {
          break;
        }
        j += 1;
      }

      if (qSecond === qFirst && qFirst > 0 && lastSecondFill !== null) {
        const avgFirst = spentFirst / qFirst;
        const avgSecond = spentSecond / qSecond;
        const pairSum = avgFirst + avgSecond;
        const pnl = pnlPerPairUsd(pairSum, cfg.stakeUsdPerPair, cfg.feeRate) * qFirst;
        trades.push({
          market: cfg.market,
          slug,
          openedAtMs: openedAt,
          closedAtMs: closedAt,
          firstSide,
          legsPerSide: qFirst,
          avgFirstSideCents: avgFirst,
          avgSecondSideCents: avgSecond,
          pairSumCents: pairSum,
          pnlUsd: pnl,
          waitMs: Math.max(0, closedAt - openedAt),
          forcedSecondLeg: forced,
        });
        completed += 1;
      }
      i = Math.max(i + 1, j + 1);
    }
  }
  return { trades, totalOpens, completed };
}

function summarizeRun(
  params: {
    maxPairSumCents: number;
    firstLegMaxCents: number;
    secondLegTimeoutSec: number;
    maxLegsPerSide: number;
    addStepCents: number;
  },
  trades: CompletedTrade[],
  totalOpens: number,
  completed: number
): RunResult {
  const totalTrades = trades.length;
  const pnlUsd = trades.reduce((a, t) => a + t.pnlUsd, 0);
  const forcedSecondLegTrades = trades.filter((t) => t.forcedSecondLeg).length;
  const avgLegsPerSide = totalTrades ? trades.reduce((a, t) => a + t.legsPerSide, 0) / totalTrades : 0;
  const avgPairSumCents = totalTrades ? trades.reduce((a, t) => a + t.pairSumCents, 0) / totalTrades : 0;
  const avgWaitSec = totalTrades ? trades.reduce((a, t) => a + t.waitMs, 0) / totalTrades / 1000 : 0;
  const completionRatePct = totalOpens ? (completed / totalOpens) * 100 : 0;
  return {
    ...params,
    totalTrades,
    forcedSecondLegTrades,
    avgLegsPerSide,
    avgPairSumCents,
    avgWaitSec,
    completionRatePct,
    pnlUsd,
  };
}

function printTopRuns(runs: RunResult[], topN: number): void {
  const top = runs.slice().sort((a, b) => b.pnlUsd - a.pnlUsd).slice(0, topN);
  console.log("");
  console.log(`Top ${top.length} configs by PnL:`);
  for (const r of top) {
    console.log(
      [
        `sum<=${r.maxPairSumCents}c`,
        `first<=${r.firstLegMaxCents}c`,
        `timeout=${r.secondLegTimeoutSec}s`,
        `legs<=${r.maxLegsPerSide}`,
        `step=${r.addStepCents}c`,
        `trades=${r.totalTrades}`,
        `forced=${r.forcedSecondLegTrades}`,
        `avgLegs=${r.avgLegsPerSide.toFixed(2)}`,
        `completion=${r.completionRatePct.toFixed(1)}%`,
        `avgSum=${r.avgPairSumCents.toFixed(2)}c`,
        `avgWait=${r.avgWaitSec.toFixed(2)}s`,
        `PnL=$${r.pnlUsd.toFixed(2)}`,
      ].join(" | ")
    );
  }
}

function forcedRatePct(r: RunResult): number {
  if (r.totalTrades <= 0) return 0;
  return (r.forcedSecondLegTrades / r.totalTrades) * 100;
}

function printBestDetailed(
  best: RunResult | null,
  ticksCount: number,
  slugsCount: number,
  cfg: Config,
  trades: CompletedTrade[]
): void {
  console.log("----");
  console.log(`Ticks loaded: ${ticksCount}`);
  console.log(`Slugs loaded: ${slugsCount}`);
  console.log(`Market: ${cfg.market}`);
  console.log(`Stake per pair: $${cfg.stakeUsdPerPair.toFixed(2)}`);
  console.log(`Fee rate: ${cfg.feeRate}`);
  if (!best) {
    console.log("No valid runs. Try wider limits in BACKTEST_* env vars.");
    return;
  }
  console.log(
    `Best config -> sum<=${best.maxPairSumCents}c | first<=${best.firstLegMaxCents}c | timeout=${best.secondLegTimeoutSec}s | legs<=${best.maxLegsPerSide} | step=${best.addStepCents}c`
  );
  console.log(
    `Trades=${best.totalTrades}, forced=${best.forcedSecondLegTrades}, avgLegs=${best.avgLegsPerSide.toFixed(
      2
    )}, completion=${best.completionRatePct.toFixed(1)}%, avgSum=${best.avgPairSumCents.toFixed(
      2
    )}c, avgWait=${best.avgWaitSec.toFixed(2)}s, PnL=$${best.pnlUsd.toFixed(2)}`
  );
  console.log("Sample trades:");
  for (const t of trades.slice(0, 8)) {
    console.log(
      `${new Date(t.openedAtMs).toISOString()} ${t.slug} first=${t.firstSide} legs=${t.legsPerSide} avgFirst=${t.avgFirstSideCents.toFixed(
        2
      )}c avgSecond=${t.avgSecondSideCents.toFixed(2)}c sum=${t.pairSumCents.toFixed(2)}c wait=${(
        t.waitMs / 1000
      ).toFixed(2)}s forced=${t.forcedSecondLeg ? "yes" : "no"} pnl=$${t.pnlUsd.toFixed(3)}`
    );
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  let ticks: Tick[] = [];
  if (cfg.source === "db") {
    ticks = await loadTicksFromDb(cfg);
  } else if (cfg.source === "files") {
    ticks = loadTicks(cfg);
  } else {
    // auto: prefer DB if DATABASE_URL exists, else local files.
    ticks = process.env.DATABASE_URL?.trim() ? await loadTicksFromDb(cfg) : loadTicks(cfg);
  }
  if (!ticks.length) {
    const sourceMsg =
      cfg.source === "files"
        ? `files (${cfg.dataDir})`
        : cfg.source === "db"
        ? "postgres (collector_rows)"
        : process.env.DATABASE_URL?.trim()
        ? "postgres (collector_rows)"
        : `files (${cfg.dataDir})`;
    console.log(`No valid ticks found from ${sourceMsg} for market=${cfg.market}.`);
    return;
  }
  const ticksBySlug = new Map<string, Tick[]>();
  for (const t of ticks) {
    const arr = ticksBySlug.get(t.slug) ?? [];
    arr.push(t);
    ticksBySlug.set(t.slug, arr);
  }
  for (const arr of ticksBySlug.values()) {
    arr.sort((a, b) => a.tsMs - b.tsMs);
  }

  const runs: Array<{ summary: RunResult; trades: CompletedTrade[] }> = [];
  for (const maxPair of cfg.maxPairSumCents) {
    for (const firstMax of cfg.firstLegMaxCents) {
      for (const timeoutSec of cfg.secondLegTimeoutSec) {
        for (const maxLegs of cfg.maxLegsPerSide) {
          for (const addStep of cfg.addStepCents) {
            const result = runStrategy(ticksBySlug, cfg, maxPair, firstMax, timeoutSec, maxLegs, addStep);
            const summary = summarizeRun(
              {
                maxPairSumCents: maxPair,
                firstLegMaxCents: firstMax,
                secondLegTimeoutSec: timeoutSec,
                maxLegsPerSide: maxLegs,
                addStepCents: addStep,
              },
              result.trades,
              result.totalOpens,
              result.completed
            );
            runs.push({ summary, trades: result.trades });
          }
        }
      }
    }
  }

  const sorted = runs.slice().sort((a, b) => b.summary.pnlUsd - a.summary.pnlUsd);
  const eligible = sorted.filter(
    (x) => x.summary.totalTrades >= cfg.minTrades && forcedRatePct(x.summary) <= cfg.maxForcedRatePct
  );
  const bestEligible = eligible[0] ?? null;
  const bestRaw = sorted[0] ?? null;
  if (!eligible.length) {
    console.log("");
    console.log(
      `No configs passed filters: minTrades=${cfg.minTrades}, maxForcedRatePct=${cfg.maxForcedRatePct.toFixed(1)}%. Showing raw top list below.`
    );
  } else {
    console.log("");
    console.log(
      `Eligible configs: ${eligible.length} (filters: minTrades>=${cfg.minTrades}, forcedRate<=${cfg.maxForcedRatePct.toFixed(
        1
      )}%)`
    );
  }
  printTopRuns(
    (eligible.length ? eligible : sorted).map((x) => x.summary),
    cfg.topN
  );
  printBestDetailed(
    (bestEligible ?? bestRaw)?.summary ?? null,
    ticks.length,
    ticksBySlug.size,
    cfg,
    (bestEligible ?? bestRaw)?.trades ?? []
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

