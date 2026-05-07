import type { PaperPortfolio, Side } from "./portfolio.js";
import type { HedgedArbConfig } from "./types.js";

export type BuySignal = {
  side: Side;
  price: number;
  shares: number;
  reason: string;
};

export type StrategyState = {
  slug: string;
  attemptCountYES: number;
  attemptCountNO: number;
  buyCountYES: number;
  buyCountNO: number;
  lastBuySide?: Side;
  lastBuyPriceYES?: number;
  lastBuyPriceNO?: number;
  trackingToken: Side | null;
  tempPrice: number;
  firstBuyOfHedge: boolean;
  initialized: boolean;
  secondSideTimerSessionStart: number | null;
  lastFailedBuyAttempt: number;
  isNewHedge: boolean;
};

export function emptyStrategyState(slug: string): StrategyState {
  return {
    slug,
    attemptCountYES: 0,
    attemptCountNO: 0,
    buyCountYES: 0,
    buyCountNO: 0,
    trackingToken: null,
    tempPrice: 1,
    firstBuyOfHedge: true,
    initialized: false,
    secondSideTimerSessionStart: null,
    lastFailedBuyAttempt: 0,
    isNewHedge: true,
  };
}

function avg(cost: number, qty: number): number {
  return qty > 0 ? cost / qty : 0;
}

export function hedgeComplete(row: StrategyState, cfg: HedgedArbConfig): boolean {
  return row.attemptCountYES >= cfg.maxBuysPerSide && row.attemptCountNO >= cfg.maxBuysPerSide;
}

/**
 * Paper clone of core triggers from github `copytrade.ts` (one buy max per poll).
 */
export function evaluatePaperTick(
  cfg: HedgedArbConfig,
  row: StrategyState,
  portfolio: PaperPortfolio,
  conditionId: string,
  upsertRow: () => void,
  marketKey: string,
  slug: string,
  title: string,
  upMid: number,
  downMid: number,
  now: number
): BuySignal | null {
  void marketKey;
  void title;

  const pos = portfolio.getPosition(conditionId);
  const qtyYES = pos?.qtyYES ?? 0;
  const qtyNO = pos?.qtyNO ?? 0;
  const costYES = pos?.costYES ?? 0;
  const costNO = pos?.costNO ?? 0;

  /* ---- hedge complete → reset ---- */
  if (hedgeComplete(row, cfg)) {
    row.attemptCountYES = 0;
    row.attemptCountNO = 0;
    row.buyCountYES = 0;
    row.buyCountNO = 0;
    row.lastBuySide = undefined;
    row.lastBuyPriceYES = undefined;
    row.lastBuyPriceNO = undefined;
    row.trackingToken = null;
    row.tempPrice = 1;
    row.firstBuyOfHedge = true;
    row.initialized = false;
    row.secondSideTimerSessionStart = null;
    row.lastFailedBuyAttempt = 0;
    row.isNewHedge = true;
    upsertRow();
    return null;
  }

  const currentAvgYES = avg(costYES, qtyYES);
  const currentAvgNO = avg(costNO, qtyNO);

  /* ---- initialization / entry ---- */
  if (!row.initialized) {
    const yesBelow = upMid <= cfg.threshold;
    const noBelow = downMid <= cfg.threshold;

    if (!yesBelow && !noBelow) {
      if (cfg.debug) console.log(`[paper] ${slug} waiting entry YES=${upMid.toFixed(3)} NO=${downMid.toFixed(3)} T=${cfg.threshold}`);
      return null;
    }

    let start: Side;
    const last = row.lastBuySide;
    if (row.isNewHedge) {
      if (last === "YES" && yesBelow) start = "YES";
      else if (last === "NO" && noBelow) start = "NO";
      else if (yesBelow && noBelow) start = "YES";
      else if (yesBelow) start = "YES";
      else start = "NO";

      row.isNewHedge = false;
    } else if (yesBelow && noBelow) start = "YES";
    else if (yesBelow) start = "YES";
    else start = "NO";

    row.trackingToken = start;
    row.tempPrice = start === "YES" ? upMid : downMid;
    row.initialized = true;
    row.secondSideTimerSessionStart = null;
    upsertRow();
    if (cfg.debug) console.log(`[paper] ${slug} init track ${start} temp=${row.tempPrice.toFixed(4)}`);
    return null;
  }

  const currentToken = row.trackingToken;
  if (!currentToken) return null;

  const currentPrice = currentToken === "YES" ? upMid : downMid;
  const oppositeToken = currentToken === "YES" ? ("NO" as const) : ("YES" as const);
  let attemptCount = currentToken === "YES" ? row.attemptCountYES : row.attemptCountNO;

  /* Github-style forced alternation (отключено в celecula-пресете) */
  if (
    cfg.strictAlternation &&
    !cfg.balancePriorityAfterFill &&
    !row.firstBuyOfHedge &&
    row.lastBuySide &&
    row.lastBuySide === currentToken
  ) {
    row.trackingToken = oppositeToken;
    row.tempPrice = oppositeToken === "YES" ? upMid : downMid;
    row.secondSideTimerSessionStart = null;
    attemptCount = row.trackingToken === "YES" ? row.attemptCountYES : row.attemptCountNO;
    upsertRow();
    return null;
  }

  if (cfg.maxSideImbalanceShares > 0) {
    const cap = cfg.maxSideImbalanceShares;
    const wouldSkew =
      currentToken === "YES" ? qtyYES + cfg.sharesPerSide - qtyNO > cap : qtyNO + cfg.sharesPerSide - qtyYES > cap;
    if (wouldSkew) {
      if (cfg.debug) console.log(`[paper] ${slug} skip ${currentToken} — side imbalance cap ${cap}`);
      row.trackingToken = oppositeToken;
      row.tempPrice = oppositeToken === "YES" ? upMid : downMid;
      row.secondSideTimerSessionStart = null;
      upsertRow();
      return null;
    }
  }

  if (attemptCount >= cfg.maxBuysPerSide) {
    row.trackingToken = oppositeToken;
    row.tempPrice = oppositeToken === "YES" ? upMid : downMid;
    row.secondSideTimerSessionStart = null;
    upsertRow();
    return null;
  }

  const currentAvgOtherSide = currentToken === "YES" ? currentAvgNO : currentAvgYES;
  const maxAcceptablePrice = cfg.maxSumAvg - currentAvgOtherSide;

  const recentlyFailed = row.lastFailedBuyAttempt > 0 && now - row.lastFailedBuyAttempt < 5000;

  const isSecondSide = Boolean(row.lastBuySide && row.lastBuySide !== currentToken);

  let timeBelowThreshold = 0;
  let isTimeBasedBuy = false;
  if (isSecondSide) {
    const dynamicThreshold = row.tempPrice;
    if (currentPrice > dynamicThreshold) {
      row.secondSideTimerSessionStart = null;
      timeBelowThreshold = 0;
    } else {
      if (row.secondSideTimerSessionStart === null) row.secondSideTimerSessionStart = now;
      timeBelowThreshold = now - row.secondSideTimerSessionStart;
    }
    isTimeBasedBuy = timeBelowThreshold >= cfg.secondSideTimeThresholdMs;
  }

  if (currentPrice < row.tempPrice) {
    const isAcceptable = currentPrice <= maxAcceptablePrice;
    row.tempPrice = currentPrice;
    upsertRow();
    if (cfg.debug) {
      console.log(
        `[paper] ${slug} drop ${currentToken} temp=${row.tempPrice.toFixed(4)} maxOk=${maxAcceptablePrice.toFixed(4)} ok=${isAcceptable}`
      );
    }
    return null;
  }

  const priceAcceptable = currentPrice <= maxAcceptablePrice;
  if (!priceAcceptable) {
    if (cfg.debug) console.log(`[paper] ${slug} skip ${currentToken} price ${currentPrice.toFixed(4)} > max ${maxAcceptablePrice.toFixed(4)}`);
    return null;
  }

  const depthBuyThreshold = row.tempPrice * (1 - cfg.depthBuyDiscountPercent);
  const isDeepDiscount = currentPrice <= depthBuyThreshold;
  const reversalThreshold = row.tempPrice + cfg.reversalDelta;
  const isReversal = currentPrice > reversalThreshold;

  const recordBuy = (reason: string): BuySignal => ({
    side: currentToken,
    price: currentPrice,
    shares: cfg.sharesPerSide,
    reason,
  });

  if (isTimeBasedBuy && !recentlyFailed) {
    return recordBuy(`Second side time ≥${cfg.secondSideTimeThresholdMs}ms ≤${row.tempPrice.toFixed(4)}`);
  }

  if (isDeepDiscount && !recentlyFailed) {
    return recordBuy(`Depth −${(cfg.depthBuyDiscountPercent * 100).toFixed(1)}% vs temp ${row.tempPrice.toFixed(4)}`);
  }

  if (isReversal && !recentlyFailed) {
    const label = row.firstBuyOfHedge ? "Reversal entry" : "Reversal hedge leg";
    return recordBuy(`${label} Δ+${cfg.reversalDelta}`);
  }

  return null;
}

export function applyAfterBuy(
  cfg: HedgedArbConfig,
  row: StrategyState,
  slug: string,
  side: Side,
  fillPrice: number,
  portfolio: PaperPortfolio,
  conditionId: string,
  skew?: {
    enabled: boolean;
    preferredSide: Side;
    targetShare: number;
  }
): void {
  row.attemptCountYES += side === "YES" ? 1 : 0;
  row.attemptCountNO += side === "NO" ? 1 : 0;
  row.buyCountYES += side === "YES" ? 1 : 0;
  row.buyCountNO += side === "NO" ? 1 : 0;
  row.lastBuySide = side;
  if (side === "YES") row.lastBuyPriceYES = fillPrice;
  else row.lastBuyPriceNO = fillPrice;

  row.secondSideTimerSessionStart = null;

  const oppositeToken: Side = side === "YES" ? "NO" : "YES";
  let dynamicThreshold = 1 - fillPrice + cfg.dynamicThresholdBoost;
  const estimatedPriceBuffer = 0.01;
  const minPriceForOrder = 1 / cfg.sharesPerSide - estimatedPriceBuffer;
  const minAcceptableThreshold = Math.max(0, minPriceForOrder);
  const calculatedTempPrice = Math.max(minAcceptableThreshold, Math.min(1, dynamicThreshold));

  const pos = portfolio.getPosition(conditionId);
  const qy = pos?.qtyYES ?? 0;
  const qn = pos?.qtyNO ?? 0;

  let nextTrack: Side;
  if (skew?.enabled) {
    const totalQty = qy + qn;
    const preferredQty = skew.preferredSide === "YES" ? qy : qn;
    const target = Math.max(0.5, Math.min(0.95, skew.targetShare));
    const currentShare = totalQty > 0 ? preferredQty / totalQty : 0.5;
    nextTrack = currentShare + 1e-6 < target ? skew.preferredSide : skew.preferredSide === "YES" ? "NO" : "YES";
  } else if (!cfg.balancePriorityAfterFill) {
    nextTrack = oppositeToken;
  } else {
    /** celecula-стиль: добирать отстающую сторону; при паритете остаёмся классически на противоложной для следующей покупки */
    if (qn < qy - 1e-6) nextTrack = "NO";
    else if (qy < qn - 1e-6) nextTrack = "YES";
    else nextTrack = oppositeToken;
  }

  row.trackingToken = nextTrack;
  row.tempPrice = nextTrack === oppositeToken ? calculatedTempPrice : Math.max(0.001, Math.min(0.999, fillPrice));
  row.lastFailedBuyAttempt = 0;

  if (row.firstBuyOfHedge) {
    row.firstBuyOfHedge = false;
    if (cfg.debug)
      console.log(
        `[paper] ${slug} first buy done ${side} @${fillPrice.toFixed(4)} → track ${nextTrack} (dyn≤${(
          calculatedTempPrice - cfg.secondSideBuffer
        ).toFixed(4)})`
      );
  }

}

export function markBuyFailed(row: StrategyState, now: number): void {
  row.lastFailedBuyAttempt = now;
  row.secondSideTimerSessionStart = null;
}
