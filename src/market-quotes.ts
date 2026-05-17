import { fetchBestAsk, fetchClobBuyPrice } from "./clob-book.js";
import { clampCents } from "./env-util.js";
import { fetchGammaMarket, type ParsedMarket } from "./gamma.js";

export type MarketQuote = {
  slug: string;
  gm: ParsedMarket;
  upAskCents: number;
  downAskCents: number;
  upMidCents: number;
  downMidCents: number;
};

export async function fetchMarketQuote(slug: string): Promise<MarketQuote> {
  const gm = await fetchGammaMarket(slug);
  const [upBook, downBook, upPx, downPx] = await Promise.all([
    fetchBestAsk(gm.upTokenId),
    fetchBestAsk(gm.downTokenId),
    fetchClobBuyPrice(gm.upTokenId),
    fetchClobBuyPrice(gm.downTokenId),
  ]);
  const upAsk = upBook ?? upPx ?? gm.upMid;
  const downAsk = downBook ?? downPx ?? gm.downMid;
  const upMid = upPx ?? gm.upMid;
  const downMid = downPx ?? gm.downMid;
  return {
    slug: gm.slug,
    gm,
    upAskCents: clampCents(upAsk * 100),
    downAskCents: clampCents(downAsk * 100),
    upMidCents: clampCents(upMid * 100),
    downMidCents: clampCents(downMid * 100),
  };
}

/** Skip broken end-of-window ticks (0c / 99c artifacts). */
export function isQuoteTradable(q: MarketQuote): boolean {
  const { upAskCents: u, downAskCents: d } = q;
  if (u <= 0 || d <= 0) return false;
  if (u >= 99 && d >= 99) return false;
  if (u + d > 105) return false;
  return true;
}
