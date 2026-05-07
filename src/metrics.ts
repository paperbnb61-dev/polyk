import type { OpenPosition } from "./portfolio.js";

function avg(cost: number, qty: number): number {
  return qty > 0 ? cost / qty : 0;
}

/** Hedge / skew stats for Telegram (Gamma mids are approximate). */
export function hedgeSnapshot(
  pos: OpenPosition | undefined,
  upMid?: number,
  downMid?: number
): {
  qtyYES: number;
  qtyNO: number;
  paired: number;
  skewYESminusNO: number;
  sumAvg: number;
  pairedResolveEdgeEst: number;
  pairedMtm: number | null;
} {
  if (!pos) {
    return { qtyYES: 0, qtyNO: 0, paired: 0, skewYESminusNO: 0, sumAvg: 0, pairedResolveEdgeEst: 0, pairedMtm: null };
  }
  const qy = pos.qtyYES;
  const qn = pos.qtyNO;
  const ay = avg(pos.costYES, qy);
  const an = avg(pos.costNO, qn);
  const paired = Math.min(qy, qn);
  const sumAvg = ay + an;
  const pairedResolveEdgeEst = paired > 0 && qy > 0 && qn > 0 ? paired * (1 - sumAvg) : 0;
  let pairedMtm: number | null = null;
  if (
    paired > 0 &&
    typeof upMid === "number" &&
    typeof downMid === "number" &&
    Number.isFinite(upMid) &&
    Number.isFinite(downMid)
  ) {
    pairedMtm = paired * (upMid + downMid);
  }
  return {
    qtyYES: qy,
    qtyNO: qn,
    paired,
    skewYESminusNO: qy - qn,
    sumAvg,
    pairedResolveEdgeEst,
    pairedMtm,
  };
}

export type HedgeSnapshot = ReturnType<typeof hedgeSnapshot>;
