import { envBool, envNumber, envString } from "./env-util.js";
import type { MarketQuote } from "./market-quotes.js";

export type Side = "UP" | "DOWN";

export type CeleConfig = {
  sharesPerOrder: number;
  maxBuysPerSide: number;
  maxSumAvg: number;
  maxInstantSumCents: number;
  balancePriority: boolean;
  maxSideImbalanceShares: number;
  secondSideTimeThresholdMs: number;
  reversalDeltaCents: number;
  minPriceCents: number;
  maxPriceCents: number;
  buyCooldownMs: number;
  entryEitherSideMaxCents: number;
  chaseExpensiveSide: boolean;
};

export type SlugPosition = {
  slug: string;
  openedAtMs: number;
  upQty: number;
  downQty: number;
  upCostUsd: number;
  downCostUsd: number;
  upBuys: number;
  downBuys: number;
  lastBuyMs: number;
  lastUpCents: number | null;
  lastDownCents: number | null;
};

export type BuyIntent = {
  side: Side;
  cents: number;
  reason: string;
};

export function loadCeleConfig(prefix: "" | "LIVE_" | "PAPER_"): CeleConfig {
  const p = (k: string, fb: string) => envString(`${prefix}${k}`, envString(k, fb));
  const n = (k: string, fb: number) => envNumber(`${prefix}${k}`, envNumber(k, fb));
  const b = (k: string, fb: boolean) => envBool(`${prefix}${k}`, envBool(k, fb));

  return {
    sharesPerOrder: Math.max(0.01, n("CELE_SHARES_PER_ORDER", n("SHARES_PER_ORDER", 12))),
    maxBuysPerSide: Math.max(1, n("CELE_MAX_BUYS_PER_SIDE", 64)),
    maxSumAvg: Math.max(0.9, Math.min(1.05, n("CELE_MAX_SUM_AVG", 0.985))),
    maxInstantSumCents: Math.max(90, Math.min(110, n("CELE_MAX_INSTANT_SUM_CENTS", 103))),
    balancePriority: b("CELE_BALANCE_PRIORITY", true),
    maxSideImbalanceShares: Math.max(0, n("CELE_MAX_SIDE_IMBALANCE_SHARES", 144)),
    secondSideTimeThresholdMs: Math.max(0, n("CELE_SECOND_SIDE_MS", 280)),
    reversalDeltaCents: Math.max(0, n("CELE_REVERSAL_DELTA_CENTS", 2)),
    minPriceCents: Math.max(1, n("CELE_MIN_PRICE_CENTS", 2)),
    maxPriceCents: Math.min(99, n("CELE_MAX_PRICE_CENTS", 95)),
    buyCooldownMs: Math.max(0, n("CELE_BUY_COOLDOWN_MS", 80)),
    entryEitherSideMaxCents: Math.max(40, n("CELE_ENTRY_EITHER_SIDE_MAX_CENTS", 58)),
    chaseExpensiveSide: b("CELE_CHASE_EXPENSIVE_SIDE", true),
  };
}

function avgCents(costUsd: number, qty: number): number {
  if (qty <= 0) return 0;
  return (costUsd / qty) * 100;
}

export function positionSumAvgCents(pos: SlugPosition): number {
  if (pos.upQty <= 0 || pos.downQty <= 0) return 0;
  return avgCents(pos.upCostUsd, pos.upQty) + avgCents(pos.downCostUsd, pos.downQty);
}

export function pairedShares(pos: SlugPosition): number {
  return Math.min(pos.upQty, pos.downQty);
}

export function projectedSumAvgAfterBuy(
  pos: SlugPosition,
  side: Side,
  cents: number,
  shares: number,
): number {
  const px = cents / 100;
  const addCost = px * shares;
  let upQty = pos.upQty;
  let downQty = pos.downQty;
  let upCost = pos.upCostUsd;
  let downCost = pos.downCostUsd;
  if (side === "UP") {
    upQty += shares;
    upCost += addCost;
  } else {
    downQty += shares;
    downCost += addCost;
  }
  if (upQty <= 0 || downQty <= 0) return 0;
  return avgCents(upCost, upQty) + avgCents(downCost, downQty);
}

function sideQty(pos: SlugPosition, side: Side): number {
  return side === "UP" ? pos.upQty : pos.downQty;
}

function sideBuys(pos: SlugPosition, side: Side): number {
  return side === "UP" ? pos.upBuys : pos.downBuys;
}

function priceOk(cfg: CeleConfig, cents: number): boolean {
  return cents >= cfg.minPriceCents && cents <= cfg.maxPriceCents;
}

function imbalance(pos: SlugPosition): number {
  return Math.abs(pos.upQty - pos.downQty);
}

function lighterSide(pos: SlugPosition): Side {
  return pos.upQty <= pos.downQty ? "UP" : "DOWN";
}

function needsSecondSideUrgent(cfg: CeleConfig, pos: SlugPosition, nowMs: number): Side | null {
  if (pos.upQty > 0 && pos.downQty > 0) return null;
  if (nowMs - pos.openedAtMs < cfg.secondSideTimeThresholdMs) return null;
  if (pos.upQty > 0 && pos.downQty <= 0) return "DOWN";
  if (pos.downQty > 0 && pos.upQty <= 0) return "UP";
  return null;
}

function reversalOk(cfg: CeleConfig, pos: SlugPosition, side: Side, cents: number): boolean {
  const last = side === "UP" ? pos.lastUpCents : pos.lastDownCents;
  if (last === null) return true;
  return cents <= last - cfg.reversalDeltaCents;
}

function canAddSide(cfg: CeleConfig, pos: SlugPosition, side: Side, cents: number, shares: number): boolean {
  if (!priceOk(cfg, cents)) return false;
  if (sideBuys(pos, side) >= cfg.maxBuysPerSide) return false;
  if (cfg.maxSideImbalanceShares > 0) {
    const other = side === "UP" ? pos.downQty : pos.upQty;
    const mine = sideQty(pos, side);
    if (mine + shares - other > cfg.maxSideImbalanceShares) return false;
  }
  const projected = projectedSumAvgAfterBuy(pos, side, cents, shares);
  if (pos.upQty > 0 && pos.downQty > 0 && projected > cfg.maxSumAvg * 100) return false;
  return true;
}

function hasPosition(pos: SlugPosition | null): boolean {
  return Boolean(pos && (pos.upQty > 0 || pos.downQty > 0));
}

function entryAllowed(cfg: CeleConfig, q: MarketQuote): boolean {
  const sum = q.upAskCents + q.downAskCents;
  if (sum <= cfg.maxInstantSumCents) return true;
  if (q.upAskCents <= cfg.entryEitherSideMaxCents) return true;
  if (q.downAskCents <= cfg.entryEitherSideMaxCents) return true;
  return false;
}

function pickCheaperSide(q: MarketQuote): Side {
  return q.upAskCents <= q.downAskCents ? "UP" : "DOWN";
}

function pickChaseSide(cfg: CeleConfig, q: MarketQuote, pos: SlugPosition): Side | null {
  if (!cfg.chaseExpensiveSide) return null;
  const heavy = pos.upQty >= pos.downQty ? "UP" : "DOWN";
  const expensive: Side = q.upAskCents >= q.downAskCents ? "UP" : "DOWN";
  if (heavy === expensive) return null;
  return expensive;
}

export function decideBuy(
  cfg: CeleConfig,
  q: MarketQuote,
  pos: SlugPosition | null,
  nowMs: number,
): BuyIntent | null {
  if (!hasPosition(pos) && !entryAllowed(cfg, q)) return null;

  const active: SlugPosition =
    pos ??
    ({
      slug: q.slug,
      openedAtMs: nowMs,
      upQty: 0,
      downQty: 0,
      upCostUsd: 0,
      downCostUsd: 0,
      upBuys: 0,
      downBuys: 0,
      lastBuyMs: 0,
      lastUpCents: null,
      lastDownCents: null,
    } satisfies SlugPosition);

  if (active.lastBuyMs > 0 && nowMs - active.lastBuyMs < cfg.buyCooldownMs) return null;

  const urgent = needsSecondSideUrgent(cfg, active, nowMs);
  const candidates: Array<{ side: Side; cents: number; reason: string; priority: number }> = [];

  const trySide = (side: Side, reason: string, priority: number) => {
    const cents = side === "UP" ? q.upAskCents : q.downAskCents;
    if (!canAddSide(cfg, active, side, cents, cfg.sharesPerOrder)) return;
    if (!reversalOk(cfg, active, side, cents) && sideBuys(active, side) > 0) return;
    candidates.push({ side, cents, reason, priority });
  };

  if (urgent) {
    trySide(urgent, "second-side-urgent", 100);
  }

  if (cfg.balancePriority && active.upQty > 0 && active.downQty > 0 && imbalance(active) >= cfg.sharesPerOrder) {
    trySide(lighterSide(active), "balance", 80);
  }

  const chase = pickChaseSide(cfg, q, active);
  if (chase) trySide(chase, "chase-winner", 60);

  trySide(pickCheaperSide(q), "cheaper", 40);
  trySide(pickCheaperSide(q) === "UP" ? "DOWN" : "UP", "other", 30);

  if (!candidates.length) {
    if (!hasPosition(pos)) return null;
    trySide(pickCheaperSide(q), "bootstrap", 50);
    if (!candidates.length) return null;
  }

  candidates.sort((a, b) => b.priority - a.priority);
  const pick = candidates[0]!;
  return { side: pick.side, cents: pick.cents, reason: pick.reason };
}

export function applyBuy(pos: SlugPosition, side: Side, cents: number, shares: number, nowMs: number): void {
  const cost = (cents / 100) * shares;
  if (side === "UP") {
    pos.upQty += shares;
    pos.upCostUsd += cost;
    pos.upBuys += 1;
    pos.lastUpCents = cents;
  } else {
    pos.downQty += shares;
    pos.downCostUsd += cost;
    pos.downBuys += 1;
    pos.lastDownCents = cents;
  }
  pos.lastBuyMs = nowMs;
}

export function formatPositionLine(pos: SlugPosition): string {
  const sum = positionSumAvgCents(pos);
  const paired = pairedShares(pos);
  return (
    `up=${pos.upQty.toFixed(1)}sh@${avgCents(pos.upCostUsd, pos.upQty).toFixed(1)}c ` +
    `down=${pos.downQty.toFixed(1)}sh@${avgCents(pos.downCostUsd, pos.downQty).toFixed(1)}c ` +
    `paired=${paired.toFixed(1)} sumAvg=${sum > 0 ? sum.toFixed(1) : "—"}c ` +
    `buys=${pos.upBuys}/${pos.downBuys}`
  );
}

export type WindowSettle = {
  slug: string;
  pairedShares: number;
  sumAvgCents: number;
  upQty: number;
  downQty: number;
  buyUsd: number;
  pairedRedeemUsd: number;
  unpairedUpUsd: number;
  unpairedDownUsd: number;
};

export function settleWindow(
  pos: SlugPosition,
  upMarkCents: number,
  downMarkCents: number,
): WindowSettle {
  const paired = pairedShares(pos);
  const sum = positionSumAvgCents(pos);
  const buyUsd = pos.upCostUsd + pos.downCostUsd;
  const pairedRedeemUsd = paired * 1.0;
  const unpairedUp = Math.max(0, pos.upQty - paired);
  const unpairedDown = Math.max(0, pos.downQty - paired);
  return {
    slug: pos.slug,
    pairedShares: paired,
    sumAvgCents: sum,
    upQty: pos.upQty,
    downQty: pos.downQty,
    buyUsd,
    pairedRedeemUsd,
    unpairedUpUsd: (unpairedUp * upMarkCents) / 100,
    unpairedDownUsd: (unpairedDown * downMarkCents) / 100,
  };
}
