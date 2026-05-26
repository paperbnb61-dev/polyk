/**
 * extreme-bot.ts — paper bot, стратегия YES@88c / NO@20c
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { envBool, envNumber, envString } from "./env-util.js";
import {
  applyEnter,
  decideExtreme,
  loadExtremeConfig,
  newSlugRuntime,
  windowRemainingSec,
  type SlugRuntime,
} from "./extreme-strategy.js";
import { fetchMarketQuote, isQuoteTradable } from "./market-quotes.js";
import { slugForCurrent15m } from "./slug.js";

dotenv.config();

const market = envString("EXTREME_MARKET", "btc");
const pollMs = Math.max(200, envNumber("EXTREME_POLL_MS", 300));
const initialUsd = Math.max(10, envNumber("EXTREME_INITIAL_USD", 1000));
const logFile = envString("EXTREME_LOG_FILE", "data/extreme-paper-logs.jsonl");
const logToFile =
  envString("EXTREME_LOG_TO_FILE", process.env.RAILWAY_ENVIRONMENT ? "false" : "true").toLowerCase() !== "false";

const telegramToken = envString("TELEGRAM_BOT_TOKEN", "");
const telegramChatId = envString("TELEGRAM_CHAT_ID", "");
const pnlEnabled = envBool("EXTREME_PNL_REPORT_ENABLED", true);
const pnlIntervalMs = envNumber(
  "EXTREME_PNL_REPORT_INTERVAL_MS",
  envNumber("EXTREME_PNL_REPORT_INTERVAL_HOURS", 4) * 3_600_000,
);

const cfg = loadExtremeConfig();

let cashUsd = initialUsd;
let realizedUsd = 0;
let trades = 0;
let wins = 0;
let losses = 0;
let runtime: SlugRuntime | null = null;

let lastYesC = 50;
let lastNoC = 50;

let lastReportMs = Date.now();
let reportSnap = { trades: 0, wins: 0, losses: 0, realizedUsd: 0 };

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
    losses,
    ...extra,
  };
  const out = path.resolve(process.cwd(), logFile);
  if (logToFile) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.appendFileSync(out, JSON.stringify(row) + "\n", "utf8");
  }
  if (opts.console !== false && event !== "TICK") {
    console.log(`[extreme] ${message}`);
  }
}

async function notify(text: string): Promise<void> {
  if (!telegramToken || !telegramChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text,
        disable_web_page_preview: true,
      }),
    });
  } catch {
    /* ignore */
  }
}

async function maybeSendPnlReport(nowMs: number, posLine: string): Promise<void> {
  if (!pnlEnabled || !telegramToken || !telegramChatId) return;
  if (nowMs - lastReportMs < pnlIntervalMs) return;

  const hours = (pnlIntervalMs / 3_600_000).toFixed(1);
  const periodTrades = trades - reportSnap.trades;
  const periodPnl = realizedUsd - reportSnap.realizedUsd;
  const winPct = trades > 0 ? ((wins / trades) * 100).toFixed(1) : "—";
  const sessionPnl = cashUsd - initialUsd;
  const sign = (n: number) => (n >= 0 ? "+" : "");

  const text = [
    `📊 Extreme PnL (${hours}ч)`,
    `EXTREME | ${market.toUpperCase()}`,
    "",
    `За ${hours}ч:`,
    `  сделок: ${periodTrades} | pnl: ${sign(periodPnl)}$${periodPnl.toFixed(2)}`,
    "",
    `Всего с запуска:`,
    `  сделок: ${trades} | ✅${wins} ❌${losses} | win: ${winPct}%`,
    `  realized: ${sign(realizedUsd)}$${realizedUsd.toFixed(2)}`,
    `  cash: $${cashUsd.toFixed(2)} | session: ${sign(sessionPnl)}$${sessionPnl.toFixed(2)}`,
    "",
    `Позиция: ${posLine}`,
  ].join("\n");

  lastReportMs = nowMs;
  reportSnap = { trades, wins, losses, realizedUsd };
  appendLog("PNL_REPORT", text.replace(/\n/g, " | "));
  await notify(text);
}

function settleOnWindowRoll(oldRuntime: SlugRuntime): void {
  if (!oldRuntime.position) return;
  const pos = oldRuntime.position;

  const yesAtRoll = lastYesC || 50;
  const noAtRoll = lastNoC || 50;

  const win = pos.side === "YES" ? yesAtRoll >= 50 : noAtRoll >= 50;
  const payout = win ? pos.shares : 0;
  const pnl = payout - pos.costUsd - pos.feeUsd;

  cashUsd += payout;
  realizedUsd += pnl;
  trades += 1;
  if (pnl > 0) wins += 1;
  else losses += 1;

  appendLog(
    "SETTLE_ROLL",
    `settle ${oldRuntime.slug} ${pos.side} ${pos.shares}sh ${win ? "WIN" : "LOSS"} yesC=${yesAtRoll}c noC=${noAtRoll}c payout=$${payout.toFixed(2)} pnl=$${pnl.toFixed(2)}`,
    { slug: oldRuntime.slug, side: pos.side, pnl, yesAtRoll, noAtRoll },
  );
}

async function tick(): Promise<void> {
  const now = Date.now();
  const slug = slugForCurrent15m(market, new Date(now));

  if (runtime && runtime.slug !== slug) {
    settleOnWindowRoll(runtime);
    appendLog("WINDOW_ROLL", `new window ${slug} (prev ${runtime.slug})`, { slug });
    runtime = newSlugRuntime(slug, now);
    lastYesC = 50;
    lastNoC = 50;
  }
  if (!runtime) runtime = newSlugRuntime(slug, now);

  const q = await fetchMarketQuote(slug);
  if (!isQuoteTradable(q)) {
    appendLog("SKIP", `${slug} untradable up=${q.upAskCents}c down=${q.downAskCents}c`, { slug }, { console: false });
    return;
  }

  lastYesC = q.upAskCents;
  lastNoC = q.downAskCents;

  const { actions, rt } = decideExtreme(cfg, q, runtime, now, cashUsd);
  runtime = rt;

  for (const a of actions) {
    if (a.type === "ENTER") {
      const cost = (a.cents / 100) * a.shares;
      const fee = cost * cfg.feeRate;

      if (cost + fee > cashUsd) {
        appendLog("SKIP", `no cash: need $${(cost + fee).toFixed(2)} have $${cashUsd.toFixed(2)}`, { slug }, { console: true });
        continue;
      }

      cashUsd -= cost + fee;
      runtime = applyEnter(runtime!, a.side, a.cents, a.shares, cost, fee, now);
      appendLog(
        "ENTER",
        `BUY ${a.side} ${a.shares}sh@${a.cents}c | ${a.reason} | cost=$${cost.toFixed(2)} fee=$${fee.toFixed(2)} cash=$${cashUsd.toFixed(2)}`,
        { slug, side: a.side, cents: a.cents, shares: a.shares, cost, fee },
      );
    } else if (a.type === "EXIT") {
      const pos = runtime!.position!;
      const proceeds = (a.cents / 100) * pos.shares;
      const pnl = proceeds - pos.costUsd - pos.feeUsd;

      cashUsd += proceeds;
      realizedUsd += pnl;
      trades += 1;
      if (pnl > 0) wins += 1;
      else losses += 1;

      runtime = { ...runtime!, position: null };
      appendLog(
        "EXIT",
        `SELL ${a.side} ${pos.shares}sh@${a.cents}c | ${a.reason} | pnl=$${pnl.toFixed(2)} realized=$${realizedUsd.toFixed(2)} cash=$${cashUsd.toFixed(2)}`,
        { slug, side: a.side, cents: a.cents, pnl },
      );
      await notify(
        `${pnl >= 0 ? "✅" : "❌"} ${a.side} ${pnl >= 0 ? "WIN" : "LOSS"} pnl=$${pnl.toFixed(2)} | ${a.reason} | cash=$${cashUsd.toFixed(2)}`,
      );
    } else if (a.type === "SETTLE") {
      const pos = runtime!.position!;
      const pnl = a.payoutUsd - pos.costUsd - pos.feeUsd;

      cashUsd += a.payoutUsd;
      realizedUsd += pnl;
      trades += 1;
      if (pnl > 0) wins += 1;
      else losses += 1;

      runtime = { ...runtime!, position: null };
      appendLog(
        "SETTLE",
        `${a.side} ${pos.shares}sh | ${a.reason} | payout=$${a.payoutUsd.toFixed(2)} pnl=$${pnl.toFixed(2)} cash=$${cashUsd.toFixed(2)}`,
        { slug, side: a.side, pnl },
      );
    }
  }

  const pos = runtime.position;
  const remain = windowRemainingSec(slug, now, cfg.windowSec).toFixed(0);
  const posLine = pos
    ? `${pos.side} ${pos.shares}sh@${pos.entryCents}c (entry $${pos.costUsd.toFixed(2)})`
    : `watch y=${runtime.yesConfirmTicks}/${cfg.yesConfirmTicks} n=${runtime.noConfirmTicks}/${cfg.noConfirmTicks}`;

  appendLog(
    "TICK",
    `${slug} YES=${q.upAskCents}c NO=${q.downAskCents}c | ${remain}s left | cash=$${cashUsd.toFixed(2)} | ${posLine}`,
    { slug, yesC: q.upAskCents, noC: q.downAskCents },
    { console: false },
  );

  await maybeSendPnlReport(now, posLine);
}

async function main(): Promise<void> {
  const startMsg = [
    `🚀 Extreme bot START | ${market.toUpperCase()}`,
    `poll=${pollMs}ms | $${initialUsd}`,
    `YES: >=${cfg.yesTriggerCents}c → ${cfg.yesConfirmTicks}ticks → exit@${cfg.yesExitCents}c | stop@${cfg.yesStopCents}c`,
    `NO:  YES<=${cfg.noYesTriggerCents}c → ${cfg.noConfirmTicks}ticks → exit@${cfg.noExitCents}c | stop YES>=${cfg.noStopYesCents}c`,
    `size=${cfg.positionPct * 100}% | fee=${cfg.feeRate * 100}% | blackout=${cfg.entryBlackoutSec}s | minRemain=${cfg.minRemainingSec}s`,
    `blockYesUTC: [${[...cfg.blockYesHoursUtc].join(",")}]`,
  ].join("\n");

  appendLog("START", startMsg.replace(/\n/g, " | "));
  console.log(startMsg);

  if (pnlEnabled && telegramToken && telegramChatId) {
    await notify(startMsg);
  }

  for (;;) {
    try {
      await tick();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      appendLog("ERROR", msg);
      console.error(`[extreme] ERROR: ${msg}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
