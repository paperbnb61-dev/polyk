export type Side = "YES" | "NO";

export type OpenPosition = {
  slug: string;
  conditionId: string;
  title: string;
  qtyYES: number;
  qtyNO: number;
  costYES: number;
  costNO: number;
};

export type PaperBuyEvent = {
  market: string;
  slug: string;
  conditionId: string;
  title: string;
  side: Side;
  price: number;
  shares: number;
  fee: number;
  cashAfter: number;
  equity: number;
  realizedPnlTotal: number;
  sumAvg: number;
  reason: string;
};

function avg(cost: number, qty: number): number {
  return qty > 0 ? cost / qty : 0;
}

export class PaperPortfolio {
  cash: number;
  /** After closed markets */
  realizedPnl = 0;
  positions = new Map<string, OpenPosition>();

  constructor(initialCash: number) {
    this.cash = initialCash;
  }

  getPosition(conditionId: string): OpenPosition | undefined {
    return this.positions.get(conditionId);
  }

  ensurePosition(row: Omit<OpenPosition, "qtyYES" | "qtyNO" | "costYES" | "costNO">): OpenPosition {
    let p = this.positions.get(row.conditionId);
    if (!p) {
      p = {
        slug: row.slug,
        conditionId: row.conditionId,
        title: row.title,
        qtyYES: 0,
        qtyNO: 0,
        costYES: 0,
        costNO: 0,
      };
      this.positions.set(row.conditionId, p);
    }
    return p;
  }

  /** Simulate instant fill at `price`; returns fee charged */
  simulateBuy(
    slug: string,
    conditionId: string,
    title: string,
    side: Side,
    price: number,
    shares: number,
    takerFeeRate: number
  ): { fee: number } {
    const notional = price * shares;
    const fee = notional * takerFeeRate;
    const total = notional + fee;
    if (this.cash < total) {
      throw new Error(`Insufficient paper cash: need ${total.toFixed(4)} have ${this.cash.toFixed(4)}`);
    }
    this.cash -= total;
    const p = this.ensurePosition({ slug, conditionId, title });
    if (side === "YES") {
      p.qtyYES += shares;
      p.costYES += notional;
    } else {
      p.qtyNO += shares;
      p.costNO += notional;
    }
    return { fee };
  }

  sumAvgFor(conditionId: string): number {
    const p = this.positions.get(conditionId);
    if (!p) return 0;
    return avg(p.costYES, p.qtyYES) + avg(p.costNO, p.qtyNO);
  }

  /**
   * Mark-to-market equity = cash + position value at current mids.
   * If a quote is missing (fetch failed), carry position at cost so equity doesn't fake a huge loss.
   */
  equity(mids: Map<string, { up: number; down: number }>): number {
    let eq = this.cash;
    for (const [cid, pos] of this.positions) {
      const m = mids.get(cid);
      if (!m) {
        eq += pos.costYES + pos.costNO;
        continue;
      }
      eq += pos.qtyYES * m.up + pos.qtyNO * m.down;
    }
    return eq;
  }

  /**
   * When Gamma shows market closed, pay $1 per share on winning side.
   * Returns PnL contribution for this settlement.
   */
  settleMarket(
    conditionId: string,
    finalUp: number,
    finalDown: number
  ): number {
    const p = this.positions.get(conditionId);
    if (!p) return 0;
    const proceeds = p.qtyYES * finalUp + p.qtyNO * finalDown;
    const cost = p.costYES + p.costNO;
    const pnl = proceeds - cost;
    this.realizedPnl += pnl;
    this.cash += proceeds;
    this.positions.delete(conditionId);
    return pnl;
  }

  snapshot(): { cash: number; realizedPnl: number; positions: OpenPosition[] } {
    return {
      cash: this.cash,
      realizedPnl: this.realizedPnl,
      positions: [...this.positions.values()],
    };
  }
}

export function buildMidsMap(
  entries: { conditionId: string; up: number; down: number }[]
): Map<string, { up: number; down: number }> {
  const m = new Map<string, { up: number; down: number }>();
  for (const e of entries) m.set(e.conditionId, { up: e.up, down: e.down });
  return m;
}
