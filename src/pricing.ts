import { fetchClobTop } from "./clob.js";
import { config } from "./config.js";
import type { ParsedMarket } from "./gamma.js";

export type LiveQuotes = {
  stratUp: number;
  stratDown: number;
  mtmUp: number;
  mtmDown: number;
  fillYes: number;
  fillNo: number;
  source: "clob" | "gamma_slip";
};

function clamp01(x: number): number {
  return Math.min(0.99, Math.max(0.001, x));
}

function rt(p: number): number {
  const t = config.priceTick;
  if (!(t > 0)) return p;
  return Math.round(p / t) * t;
}

function gammaFallback(gu: number, gd: number): LiveQuotes {
  const s = config.gammaBuySlippage;
  return {
    stratUp: gu,
    stratDown: gd,
    mtmUp: gu,
    mtmDown: gd,
    fillYes: clamp01(rt(gu + s)),
    fillNo: clamp01(rt(gd + s)),
    source: "gamma_slip",
  };
}

/** Strategy uses mid-ish quotes; simulated BUY pays best ask (CLOB) или Gamma+slip. */
export async function hydrateQuotes(mk: ParsedMarket): Promise<LiveQuotes> {
  const gu = mk.upMid;
  const gd = mk.downMid;

  if (!config.useClobBooks || !mk.upTokenId || !mk.downTokenId) {
    return gammaFallback(gu, gd);
  }

  try {
    const [u, d] = await Promise.all([fetchClobTop(mk.upTokenId), fetchClobTop(mk.downTokenId)]);
    if (u && d) {
      return {
        stratUp: u.mid,
        stratDown: d.mid,
        mtmUp: u.mid,
        mtmDown: d.mid,
        fillYes: clamp01(rt(u.ask)),
        fillNo: clamp01(rt(d.ask)),
        source: "clob",
      };
    }
  } catch {
    /* fall through */
  }

  return gammaFallback(gu, gd);
}

export function fillForSide(px: LiveQuotes, side: "YES" | "NO"): number {
  return side === "YES" ? px.fillYes : px.fillNo;
}
