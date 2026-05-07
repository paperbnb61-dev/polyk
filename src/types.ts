export type HedgedArbConfig = {
  threshold: number;
  reversalDelta: number;
  maxBuysPerSide: number;
  sharesPerSide: number;
  maxSumAvg: number;
  depthBuyDiscountPercent: number;
  secondSideTimeThresholdMs: number;
  secondSideBuffer: number;
  dynamicThresholdBoost: number;
  debug: boolean;
  /** Github-style flip when same-side tick appears after hedge started */
  strictAlternation: boolean;
  /**
   * Next side after fill biased to reduce |YES−NO| (celecula-style skew allowed).
   * When false — always flip to complementary side like original arb bot.
   */
  balancePriorityAfterFill: boolean;
  /** 0 = no cap on |YES−NO| */
  maxSideImbalanceShares: number;
};
