/**
 * extreme-strategy.ts — стратегия YES@88c+50ticks / NO@20c+20ticks
 */
import type { MarketQuote } from "./market-quotes.js";
import { envNumber, envString } from "./env-util.js";

export type ExtremeSide = "YES" | "NO";

export type ExtremeConfig = {
  yesTriggerCents: number;
  yesConfirmCents: number;
  yesConfirmTicks: number;
  yesExitCents: number;
  yesStopCents: number;
  noYesTriggerCents: number;
  noYesConfirmCents: number;
  noConfirmTicks: number;
  noExitCents: number;
  noStopYesCents: number;
  minRemainingSec: number;
  entryBlackoutSec: number;
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
  startMs: number;
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
    yesExitCents: envNumber("EXTREME_YES_EXIT_CENTS", 95),
    yesStopCents: envNumber("EXTREME_YES_STOP_CENTS", 60),
    noYesTriggerCents: envNumber("EXTREME_NO_YES_TRIGGER_CENTS", 20),
    noYesConfirmCents: envNumber("EXTREME_NO_YES_CONFIRM_CENTS", 23),
    noConfirmTicks: envNumber("EXTREME_NO_CONFIRM_TICKS", 20),
    noExitCents: envNumber("EXTREME_NO_EXIT_CENTS", 95),
    noStopYesCents: envNumber("EXTREME_NO_STOP_YES_CENTS", 60),
    minRemainingSec: envNumber("EXTREME_MIN_REMAINING_SEC", 90),
    entryBlackoutSec: envNumber("EXTREME_ENTRY_BLACKOUT_SEC", 30),
    blockYesHoursUtc: new Set(hours),
    positionPct: envNumber("EXTREME_POSITION_PCT", 0.15),
    feeRate: Math.max(0, envNumber("EXTREME_FEE_RATE", 0.02)),
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

export function newSlugRuntime(slug: string, nowMs: number): SlugRuntime {
  return {
    slug,
    startMs: nowMs,
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

  let state: SlugRuntime = { ...rt, slug: q.slug };

  if (state.position) {
    const pos = state.position;

    if (pos.side === "YES") {
      if (yesC >= cfg.yesExitCents) {
        actions.push({ type: "EXIT", side: "YES", cents: yesC, reason: `YES>=${cfg.yesExitCents}c` });
        state = { ...state, position: null };
      } else if (yesC <= cfg.yesStopCents) {
        actions.push({ type: "EXIT", side: "YES", cents: yesC, reason: `stop:YES<=${cfg.yesStopCents}c` });
        state = { ...state, position: null };
      } else if (remain <= 0) {
        const win = yesC >= 50;
        const payout = win ? pos.shares : 0;
        actions.push({
          type: "SETTLE",
          side: "YES",
          payoutUsd: payout,
          reason: win ? "window_end_win" : "window_end_loss",
        });
        state = {
          ...state,
          position: null,
          yesArmed: false,
          noArmed: false,
          yesConfirmTicks: 0,
          noConfirmTicks: 0,
        };
      }
    } else {
      if (noC >= cfg.noExitCents) {
        actions.push({ type: "EXIT", side: "NO", cents: noC, reason: `NO>=${cfg.noExitCents}c` });
        state = { ...state, position: null };
      } else if (yesC >= cfg.noStopYesCents) {
        actions.push({ type: "EXIT", side: "NO", cents: noC, reason: `stop:YES>=${cfg.noStopYesCents}c` });
        state = { ...state, position: null };
      } else if (remain <= 0) {
        const win = noC >= 50;
        const payout = win ? pos.shares : 0;
        actions.push({
          type: "SETTLE",
          side: "NO",
          payoutUsd: payout,
          reason: win ? "window_end_win" : "window_end_loss",
        });
        state = {
          ...state,
          position: null,
          yesArmed: false,
          noArmed: false,
          yesConfirmTicks: 0,
          noConfirmTicks: 0,
        };
      }
    }

    return { actions, rt: state };
  }

  if (remain <= cfg.minRemainingSec) {
    return { actions, rt: state };
  }

  const elapsed = (nowMs - state.startMs) / 1000;
  if (elapsed < cfg.entryBlackoutSec) {
    return { actions, rt: state };
  }

  const hourUtc = new Date(nowMs).getUTCHours();
  const blockYes = cfg.blockYesHoursUtc.has(hourUtc);

  if (yesC <= cfg.noYesTriggerCents) {
    state.noArmed = true;
  }
  if (state.noArmed) {
    if (yesC <= cfg.noYesConfirmCents) {
      state.noConfirmTicks += 1;
    } else {
      state.noConfirmTicks = 0;
      if (yesC > cfg.noYesTriggerCents + 8) {
        state.noArmed = false;
      }
    }
  }

  if (yesC >= cfg.yesTriggerCents) {
    state.yesArmed = true;
  }
  if (state.yesArmed) {
    if (yesC >= cfg.yesConfirmCents) {
      state.yesConfirmTicks += 1;
    } else {
      state.yesConfirmTicks = 0;
      if (yesC < cfg.yesTriggerCents - 8) {
        state.yesArmed = false;
      }
    }
  }

  const budget = cashUsd * cfg.positionPct;

  if (state.noConfirmTicks >= cfg.noConfirmTicks && noC > 1 && noC < 99) {
    const shares = entryShares(budget, noC);
    if (shares > 0) {
      actions.push({
        type: "ENTER",
        side: "NO",
        cents: noC,
        shares,
        reason: `YES<=${cfg.noYesTriggerCents}c x${cfg.noConfirmTicks}ticks`,
      });
      state = { ...state, noConfirmTicks: 0, noArmed: false, yesArmed: false, yesConfirmTicks: 0 };
    }
  } else if (!blockYes && state.yesConfirmTicks >= cfg.yesConfirmTicks && yesC > 1 && yesC < 99) {
    const shares = entryShares(budget, yesC);
    if (shares > 0) {
      actions.push({
        type: "ENTER",
        side: "YES",
        cents: yesC,
        shares,
        reason: `YES>=${cfg.yesTriggerCents}c x${cfg.yesConfirmTicks}ticks`,
      });
      state = { ...state, yesConfirmTicks: 0, yesArmed: false, noArmed: false, noConfirmTicks: 0 };
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
