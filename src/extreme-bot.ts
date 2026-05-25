/**
 * Extreme-edge paper bot (YES@88c / NO@20c strategy).
 * No Postgres — logs to JSONL only.
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { envNumber, envString } from "./env-util.js";
import {
  applyEnter,
  decideExtreme,
  loadExtremeConfig,
  newSlugRuntime,
  type SlugRuntime,
  windowRemainingSec,
} from "./extreme-strategy.js";
import { fetchMarketQuote, isQuoteTradable } from "./market-quotes.js";
import { slugForCurrent15m } from "./slug.js";

dotenv.config();

const market = envString("EXTREME_MARKET", "btc");
const pollMs = Math.max(200, envNumber("EXTREME_POLL_MS", 300));
const initialUsd = Math.max(10, envNumber("EXTREME_INITIAL_USD", 1000));
const logFile = envString("EXTREME_LOG_FILE", "data/extreme-paper-logs.jsonl");
const cfg = loadExtremeConfig();

let cashUsd = initialUsd;
let realizedUsd = 0;
let trades = 0;
let wins = 0;
let runtime: SlugRuntime | null = null;

function appendLog(
  event: string,
  message: string,
  extra: Record<string, unknown> = {},
  opts: { console?: boolean } = {},
): void {
  const row = {
    tsIsoUtc: new Date().toISOString(),
    tsMs: Date.now(),
    event,
    market,
    message,
    cashUsd,
    realizedUsd,
    trades,
    wins,
    ...extra,
  };
  const out = path.resolve(process.cwd(), logFile);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.appendFileSync(out, JSON.stringify(row) + "\n", "utf8");
  if (opts.console !== false && event !== "TICK") {
    console.log(`[extreme] ${message}`);
  }
}

async function tick(): Promise<void> {
  const now = Date.now();
  const slug = slugForCurrent15m(market, new Date(now));

  if (runtime && runtime.slug !== slug) {
    if (runtime.position) {
      const oldQ = await fetchMarketQuote(runtime.slug).catch(() => null);
      const pos = runtime.position;
      const yesMid = oldQ?.upMidCents ?? 50;
      const noMid = oldQ?.downMidCents ?? 50;
      const win = pos.side === "YES" ? yesMid >= 50 : noMid >= 50;
      const payout = win ? pos.shares : 0;
      const pnl = payout - pos.costUsd - pos.feeUsd;
      cashUsd += payout;
      realizedUsd += pnl;
      if (pnl > 0) wins += 1;
      appendLog(
        "SETTLE",
        `roll ${runtime.slug} ${pos.side} ${pos.shares}sh ${win ? "win" : "loss"} payout=$${payout.toFixed(2)} pnl=$${pnl.toFixed(2)}`,
        { slug: runtime.slug, side: pos.side, pnl },
      );
    }
    appendLog("WINDOW_ROLL", `new window ${slug} (prev ${runtime.slug})`, { slug });
    runtime = newSlugRuntime(slug);
  }
  if (!runtime) runtime = newSlugRuntime(slug);

  const q = await fetchMarketQuote(slug);
  if (!isQuoteTradable(q)) {
    appendLog("SKIP", `${slug} bad quote up=${q.upAskCents}c down=${q.downAskCents}c`, { slug });
    return;
  }

  const { actions, rt } = decideExtreme(cfg, q, runtime, now, cashUsd);
  runtime = rt;

  for (const a of actions) {
    if (a.type === "ENTER") {
      const cost = (a.cents / 100) * a.shares;
      const fee = cost * cfg.feeRate;
      if (cost + fee > cashUsd) {
        appendLog("SKIP", `insufficient cash for ${a.side} ${a.shares}@${a.cents}c`, { slug });
        continue;
      }
      cashUsd -= cost + fee;
      trades += 1;
      runtime = applyEnter(runtime!, a.side, a.cents, a.shares, cost, fee, now);
      appendLog("ENTER", `BUY ${a.side} ${a.shares}@${a.cents}c | ${a.reason} | cash=$${cashUsd.toFixed(2)}`, {
        slug,
        side: a.side,
        cents: a.cents,
        shares: a.shares,
      });
    } else if (a.type === "EXIT") {
      const pos = runtime!.position!;
      const proceeds = (a.cents / 100) * pos.shares;
      const pnl = proceeds - pos.costUsd - pos.feeUsd;
      cashUsd += proceeds;
      realizedUsd += pnl;
      if (pnl > 0) wins += 1;
      runtime = { ...runtime!, position: null };
      appendLog(
        "EXIT",
        `SELL ${a.side} ${pos.shares}@${a.cents}c | ${a.reason} | pnl=$${pnl.toFixed(2)} realized=$${realizedUsd.toFixed(2)}`,
        { slug, side: a.side, pnl },
      );
    } else if (a.type === "SETTLE") {
      const pos = runtime!.position!;
      const pnl = a.payoutUsd - pos.costUsd - pos.feeUsd;
      cashUsd += a.payoutUsd;
      realizedUsd += pnl;
      if (pnl > 0) wins += 1;
      runtime = { ...runtime!, position: null };
      appendLog(
        "SETTLE",
        `${a.side} ${pos.shares}sh ${a.reason} payout=$${a.payoutUsd.toFixed(2)} pnl=$${pnl.toFixed(2)}`,
        { slug, side: a.side, pnl },
      );
    }
  }

  const pos = runtime.position;
  const remain = windowRemainingSec(slug, now, cfg.windowSec).toFixed(0);
  const posLine = pos
    ? `${pos.side} ${pos.shares}sh@${pos.entryCents}c`
    : `watch y=${runtime.yesConfirmTicks}/${cfg.yesConfirmTicks} n=${runtime.noConfirmTicks}/${cfg.noConfirmTicks}`;
  appendLog(
    "TICK",
    `${slug} YES=${q.upAskCents}c NO=${q.downAskCents}c | ${remain}s left | eq=$${cashUsd.toFixed(2)} | ${posLine}`,
    { slug, yesC: q.upAskCents, downC: q.downAskCents },
    { console: false },
  );
}

async function main(): Promise<void> {
  appendLog(
    "START",
    `Extreme paper | ${market.toUpperCase()} poll=${pollMs}ms | YES ${cfg.yesTriggerCents}c→${cfg.yesExitCents}c (${cfg.yesConfirmTicks} ticks) | NO YES<=${cfg.noYesTriggerCents}c (${cfg.noConfirmTicks} ticks) | size=${cfg.positionPct * 100}% fee=${cfg.feeRate} | $${initialUsd}`,
  );

  for (;;) {
    try {
      await tick();
    } catch (e) {
      appendLog("ERROR", e instanceof Error ? e.message : String(e));
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
