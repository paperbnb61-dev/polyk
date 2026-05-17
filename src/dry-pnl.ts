import fs from "fs";
import path from "path";

export type DryPnlState = {
  updatedAt: string;
  sessionStartedAt: string;
  lastReportAt: string;
  windows: number;
  wins: number;
  totalBuyUsd: number;
  totalEstReturnUsd: number;
  totalEstPnlUsd: number;
  totalBuys: number;
  atLastReport: {
    windows: number;
    wins: number;
    totalEstPnlUsd: number;
    totalBuys: number;
    totalBuyUsd: number;
  };
  lastSlug: string;
};

export function loadDryPnl(filePath: string): DryPnlState {
  const now = new Date().toISOString();
  try {
    const p = path.resolve(process.cwd(), filePath);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")) as DryPnlState;
  } catch {
    /* ignore */
  }
  return {
    updatedAt: now,
    sessionStartedAt: now,
    lastReportAt: now,
    windows: 0,
    wins: 0,
    totalBuyUsd: 0,
    totalEstReturnUsd: 0,
    totalEstPnlUsd: 0,
    totalBuys: 0,
    atLastReport: { windows: 0, wins: 0, totalEstPnlUsd: 0, totalBuys: 0, totalBuyUsd: 0 },
    lastSlug: "",
  };
}

export function saveDryPnl(filePath: string, state: DryPnlState): void {
  try {
    const p = path.resolve(process.cwd(), filePath);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state, null, 2), "utf8");
  } catch {
    /* ignore */
  }
}

export function recordWindowEnd(
  state: DryPnlState,
  window: { slug: string; buyUsd: number; estReturn: number; estPnl: number },
): void {
  state.updatedAt = new Date().toISOString();
  state.windows += 1;
  if (window.estPnl > 0) state.wins += 1;
  state.totalBuyUsd += window.buyUsd;
  state.totalEstReturnUsd += window.estReturn;
  state.totalEstPnlUsd += window.estPnl;
  state.lastSlug = window.slug;
}

export function recordBuy(state: DryPnlState): void {
  state.totalBuys += 1;
  state.updatedAt = new Date().toISOString();
}

export function formatPnlReport(opts: {
  modeLabel: string;
  market: string;
  intervalHours: number;
  state: DryPnlState;
  buyUsdToday: number;
  openPositionLine: string;
}): string {
  const { state, intervalHours, modeLabel, market, buyUsdToday, openPositionLine } = opts;
  const periodWindows = state.windows - state.atLastReport.windows;
  const periodPnl = state.totalEstPnlUsd - state.atLastReport.totalEstPnlUsd;
  const periodBuys = state.totalBuys - state.atLastReport.totalBuys;
  const periodBuyUsd = state.totalBuyUsd - state.atLastReport.totalBuyUsd;
  const winPct = state.windows > 0 ? ((state.wins / state.windows) * 100).toFixed(0) : "—";
  const sign = (n: number) => (n >= 0 ? "+" : "");

  return [
    `📊 PnL сводка (${intervalHours}ч)`,
    `${modeLabel} | ${market.toUpperCase()}`,
    "",
    `За ${intervalHours}ч:`,
    `  окон: ${periodWindows} | est PnL: ${sign(periodPnl)}$${periodPnl.toFixed(2)}`,
    `  BUY: ${periodBuys} | объём ~$${periodBuyUsd.toFixed(2)}`,
    "",
    `Всего с запуска:`,
    `  окон: ${state.windows} | win: ${winPct}%`,
    `  est PnL: ${sign(state.totalEstPnlUsd)}$${state.totalEstPnlUsd.toFixed(2)}`,
    `  buy $${state.totalBuyUsd.toFixed(2)} → est return $${state.totalEstReturnUsd.toFixed(2)}`,
    `  BUY: ${state.totalBuys}`,
    "",
    `Сегодня куплено: $${buyUsdToday.toFixed(2)}`,
    `Позиция: ${openPositionLine}`,
    "",
    `⚠️ est PnL = оценка по WINDOW END (не REDEEM).`,
  ].join("\n");
}

export function markReportSent(state: DryPnlState): void {
  const now = new Date().toISOString();
  state.lastReportAt = now;
  state.atLastReport = {
    windows: state.windows,
    wins: state.wins,
    totalEstPnlUsd: state.totalEstPnlUsd,
    totalBuys: state.totalBuys,
    totalBuyUsd: state.totalBuyUsd,
  };
  state.updatedAt = now;
}

export function shouldSendReport(state: DryPnlState, intervalMs: number, nowMs: number): boolean {
  const last = Date.parse(state.lastReportAt);
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= intervalMs;
}
