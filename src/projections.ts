import type { OpenPosition } from "./portfolio.js";
import type { Side } from "./portfolio.js";

function avg(cost: number, qty: number): number {
  return qty > 0 ? cost / qty : 0;
}

export function projectedSumAvg(
  pos: OpenPosition | undefined,
  side: Side,
  price: number,
  shares: number
): number {
  let qtyYES = pos?.qtyYES ?? 0;
  let qtyNO = pos?.qtyNO ?? 0;
  let costYES = pos?.costYES ?? 0;
  let costNO = pos?.costNO ?? 0;
  if (side === "YES") {
    qtyYES += shares;
    costYES += price * shares;
  } else {
    qtyNO += shares;
    costNO += price * shares;
  }
  return avg(costYES, qtyYES) + avg(costNO, qtyNO);
}
