import type { MarketQuote } from "./market-quotes.js";
import { envNumber, envString } from "./env-util.js";

export type ExtremeSide = "YES" | "NO";

export type ExtremeConfig = {
  yesTriggerCents: number;
  yesConfirmCents: number;
  yesConfirmTicks: number;
  yesExitCents: number;
  noYesTriggerCents: number;
  noYesConfirmCents: number;
  noConfirmTicks: number;
  noExitCents: number;
  minRemainingSec: number;
  blockYesHoursUtc: Set<number>;
  positionPct: number;
  feeRate: number;
  windowSec: number;
};

export type ExtremePosition = {
  side: ExtremeSide;
  entryCents: number;
  shares: number;
  costUsd: number;
  feeUsd: number;
  enteredAtMs: number;
};

export type SlugRuntime = {
  slug: string;
  yesConfirmTicks: number;
  noConfirmTicks: number;
  yesArmed: boolean;
  noArmed: boolean;
  position: ExtremePosition | null;
};

export type ExtremeAction =
  | { type: "ENTER"; side: ExtremeSide; cents: number; shares: number; reason: string }
  | { type: "EXIT"; side: ExtremeSide; cents: number; reason: string }
  | { type: "SETTLE"; side: ExtremeSide; payoutUsd: number; reason: string };

export function loadExtremeConfig(): ExtremeConfig {
  const hours = envString("EXTREME_BLOCK_YES_HOURS_UTC", "5,6,7")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  return {
    yesTriggerCents: envNumber("EXTREME_YES_TRIGGER_CENTS", 88),
    yesConfirmCents: envNumber("EXTREME_YES_CONFIRM_CENTS", 85),
    yesConfirmTicks: envNumber("EXTREME_YES_CONFIRM_TICKS", 50),
    yesExitCents: envNumber("EXTREME_YES_EXIT_CENTS", 97),
    noYesTriggerCents: envNumber("EXTREME_NO_YES_TRIGGER_CENTS", 20),
    noYesConfirmCents: envNumber("EXTREME_NO_YES_CONFIRM_CENTS", 23),
    noConfirmTicks: envNumber("EXTREME_NO_CONFIRM_TICKS", 20),
    noExitCents: envNumber("EXTREME_NO_EXIT_CENTS", 97),
    minRemainingSec: envNumber("EXTREME_MIN_REMAINING_SEC", 90),
    blockYesHoursUtc: new Set(hours),
    positionPct: envNumber("EXTREME_POSITION_PCT", 0.15),
    feeRate: Math.max(0, envNumber("EXTREME_FEE_RATE", 0)),
    windowSec: envNumber("EXTREME_WINDOW_SEC", 900),
  };
}

export function slugStartMs(slug: string): number | null {
  const i = slug.lastIndexOf("-");
  if (i < 0) return null;
  const sec = Number(slug.slice(i + 1));
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : null;
}

export function windowElapsedSec(slug: string, nowMs: number): number {
  const start = slugStartMs(slug);
  if (!start) return 0;
  return Math.max(0, (nowMs - start) / 1000);
}

export function windowRemainingSec(slug: string, nowMs: number, windowSec: number): number {
  return Math.max(0, windowSec - windowElapsedSec(slug, nowMs));
}

export function newSlugRuntime(slug: string): SlugRuntime {
  return {
    slug,
    yesConfirmTicks: 0,
    noConfirmTicks: 0,
    yesArmed: false,
    noArmed: false,
    position: null,
  };
}

function entryShares(budgetUsd: number, cents: number): number {
  if (cents <= 0) return 0;
  return Math.max(1, Math.floor(budgetUsd / (cents / 100)));
}

export function decideExtreme(
  cfg: ExtremeConfig,
  q: MarketQuote,
  rt: SlugRuntime,
  nowMs: number,
  cashUsd: number,
): { actions: ExtremeAction[]; rt: SlugRuntime } {
  const actions: ExtremeAction[] = [];
  const yesC = q.upAskCents;
  const noC = q.downAskCents;
  const remain = windowRemainingSec(q.slug, nowMs, cfg.windowSec);
  const hourUtc = new Date(nowMs).getUTCHours();

  let state: SlugRuntime = { ...rt, slug: q.slug };

  // --- exit / settle existing position ---
  if (state.position) {
    const pos = state.position;
    if (pos.side === "YES" && yesC >= cfg.yesExitCents) {
      actions.push({ type: "EXIT", side: "YES", cents: yesC, reason: `YES>=${cfg.yesExitCents}c` });
      state = { ...state, position: null };
    } else if (pos.side === "NO" && noC >= cfg.noExitCents) {
      actions.push({ type: "EXIT", side: "NO", cents: noC, reason: `NO>=${cfg.noExitCents}c` });
      state = { ...state, position: null };
    } else if (remain <= 0) {
      const win = pos.side === "YES" ? yesC >= 50 : noC >= 50;
      const payout = win ? pos.shares : 0;
      actions.push({
        type: "SETTLE",
        side: pos.side,
        payoutUsd: payout,
        reason: win ? "window_end_win" : "window_end_loss",
      });
      state = { ...state, position: null, yesArmed: false, noArmed: false, yesConfirmTicks: 0, noConfirmTicks: 0 };
    }
    return { actions, rt: state };
  }

  // --- no new entries near window end ---
  if (remain <= cfg.minRemainingSec) {
    return { actions, rt: state };
  }

  // --- YES arm / confirm ---
  if (yesC >= cfg.yesTriggerCents) state.yesArmed = true;
  if (state.yesArmed) {
    if (yesC >= cfg.yesConfirmCents) state.yesConfirmTicks += 1;
    else {
      state.yesConfirmTicks = 0;
      if (yesC < cfg.yesTriggerCents - 5) state.yesArmed = false;
    }
  }

  // --- NO arm / confirm (YES price is the signal) ---
  if (yesC <= cfg.noYesTriggerCents) state.noArmed = true;
  if (state.noArmed) {
    if (yesC <= cfg.noYesConfirmCents) state.noConfirmTicks += 1;
    else {
      state.noConfirmTicks = 0;
      if (yesC > cfg.noYesTriggerCents + 5) state.noArmed = false;
    }
  }

  const budget = cashUsd * cfg.positionPct;
  const blockYes = cfg.blockYesHoursUtc.has(hourUtc);

  // NO has priority when both ready
  if (state.noConfirmTicks >= cfg.noConfirmTicks && noC > 0 && noC < 99) {
    const shares = entryShares(budget, noC);
    if (shares > 0) {
      actions.push({
        type: "ENTER",
        side: "NO",
        cents: noC,
        shares,
        reason: `YES<=${cfg.noYesTriggerCents}c confirmed ${cfg.noConfirmTicks} ticks`,
      });
      state.noConfirmTicks = 0;
      state.yesArmed = false;
      state.yesConfirmTicks = 0;
    }
  } else if (!blockYes && state.yesConfirmTicks >= cfg.yesConfirmTicks && yesC > 0 && yesC < 99) {
    const shares = entryShares(budget, yesC);
    if (shares > 0) {
      actions.push({
        type: "ENTER",
        side: "YES",
        cents: yesC,
        shares,
        reason: `YES>=${cfg.yesTriggerCents}c confirmed ${cfg.yesConfirmTicks} ticks`,
      });
      state.yesConfirmTicks = 0;
      state.noArmed = false;
      state.noConfirmTicks = 0;
    }
  }

  return { actions, rt: state };
}

export function applyEnter(
  rt: SlugRuntime,
  side: ExtremeSide,
  cents: number,
  shares: number,
  costUsd: number,
  feeUsd: number,
  nowMs: number,
): SlugRuntime {
  return {
    ...rt,
    position: { side, entryCents: cents, shares, costUsd, feeUsd, enteredAtMs: nowMs },
    yesArmed: false,
    noArmed: false,
    yesConfirmTicks: 0,
    noConfirmTicks: 0,
  };
}
