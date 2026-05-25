/**
 * Extreme-edge paper bot (YES@88c / NO@20c strategy).
 * No Postgres — logs to JSONL only.
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
const logToFile = envString("EXTREME_LOG_TO_FILE", process.env.RAILWAY_ENVIRONMENT ? "false" : "true").toLowerCase() !== "false";
const cfg = loadExtremeConfig();

const telegramToken = envString("TELEGRAM_BOT_TOKEN", "");
const telegramChatId = envString("TELEGRAM_CHAT_ID", "");
const pnlReportEnabled = envBool("EXTREME_PNL_REPORT_ENABLED", true);
const pnlReportIntervalMs = envNumber(
  "EXTREME_PNL_REPORT_INTERVAL_MS",
  envNumber("EXTREME_PNL_REPORT_INTERVAL_HOURS", 4) * 3_600_000,
);

let cashUsd = initialUsd;
let realizedUsd = 0;
let trades = 0;
let wins = 0;
let runtime: SlugRuntime | null = null;
let lastReportMs = Date.now();
let reportSnap = { trades: 0, wins: 0, realizedUsd: 0 };

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
  if (logToFile) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.appendFileSync(out, JSON.stringify(row) + "\n", "utf8");
  }
  if (opts.console !== false && event !== "TICK") {
    console.log(`[extreme] ${message}`);
  }
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

async function maybeSendPnlReport(nowMs: number, posLine: string): Promise<void> {
  if (!pnlReportEnabled || !telegramToken || !telegramChatId) return;
  if (nowMs - lastReportMs < pnlReportIntervalMs) return;

  const hours = pnlReportIntervalMs / 3_600_000;
  const periodTrades = trades - reportSnap.trades;
  const periodRealized = realizedUsd - reportSnap.realizedUsd;
  const winPct = trades > 0 ? ((wins / trades) * 100).toFixed(1) : "—";
  const sessionPnl = cashUsd - initialUsd;
  const sign = (n: number) => (n >= 0 ? "+" : "");

  const text = [
    `📊 Extreme PnL (${hours}ч)`,
    `EXTREME | ${market.toUpperCase()}`,
    "",
    `За ${hours}ч:`,
    `  сделок: ${periodTrades} | realized: ${sign(periodRealized)}$${periodRealized.toFixed(2)}`,
    "",
    `Всего с запуска:`,
    `  сделок: ${trades} | win: ${winPct}%`,
    `  realized: ${sign(realizedUsd)}$${realizedUsd.toFixed(2)}`,
    `  cash: $${cashUsd.toFixed(2)} | session: ${sign(sessionPnl)}$${sessionPnl.toFixed(2)}`,
    "",
    `Позиция: ${posLine}`,
  ].join("\n");

  lastReportMs = nowMs;
  reportSnap = { trades, wins, realizedUsd };
  appendLog("PNL_REPORT", text.replace(/\n/g, " | "));
  await notifyTelegram(text);
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

  await maybeSendPnlReport(now, posLine);
}

async function main(): Promise<void> {
  const reportH = (pnlReportIntervalMs / 3_600_000).toFixed(1);
  const startMsg =
    `Extreme paper | ${market.toUpperCase()} poll=${pollMs}ms | YES ${cfg.yesTriggerCents}c→${cfg.yesExitCents}c (${cfg.yesConfirmTicks} ticks) | NO YES<=${cfg.noYesTriggerCents}c (${cfg.noConfirmTicks} ticks) | size=${cfg.positionPct * 100}% fee=${cfg.feeRate} | $${initialUsd}`;
  appendLog("START", startMsg);
  if (pnlReportEnabled && telegramToken && telegramChatId) {
    await notifyTelegram(`${startMsg}\nTelegram: сводка каждые ${reportH}ч.`);
  }

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
