/** Parse resolved binary prices from Gamma (winner ≈ 1) */
export function parseSettlementPayout(upPrice: number, downPrice: number, closed: boolean): { payUp: number; payDown: number } | null {
  if (!closed) return null;
  const hu = Math.abs(upPrice - 1) < 1e-6 || upPrice >= 0.995;
  const hd = Math.abs(downPrice - 1) < 1e-6 || downPrice >= 0.995;
  if (hu && !hd) return { payUp: 1, payDown: 0 };
  if (hd && !hu) return { payUp: 0, payDown: 1 };
  if (hu && hd) return { payUp: 1, payDown: 1 };
  /** Ambiguous closed state — approximate by higher price wins */
  if (upPrice > downPrice && upPrice > 0.5) return { payUp: 1, payDown: 0 };
  if (downPrice > upPrice && downPrice > 0.5) return { payUp: 0, payDown: 1 };
  return null;
}
