import { envString } from "./env-util.js";
import { fetchJson } from "./http.js";

type BookLevel = { price?: string | number; size?: string | number };
type OrderBook = { asks?: BookLevel[]; bids?: BookLevel[] };

const clobApiUrl = envString("CLOB_API_URL", "https://clob.polymarket.com").replace(/\/$/, "");

export async function fetchBestAsk(tokenId?: string): Promise<number | null> {
  if (!tokenId) return null;
  const url = `${clobApiUrl}/book?token_id=${encodeURIComponent(tokenId)}`;
  try {
    const book = await fetchJson<OrderBook>(url, { timeoutMs: 4000, retries: 1 });
    const asks = book.asks ?? [];
    if (!asks.length) return null;
    let best = Infinity;
    for (const lvl of asks) {
      const p = typeof lvl.price === "string" ? Number(lvl.price) : typeof lvl.price === "number" ? lvl.price : NaN;
      if (Number.isFinite(p) && p > 0 && p < best) best = p;
    }
    if (!Number.isFinite(best) || best === Infinity) return null;
    return Math.max(0.001, Math.min(0.999, best));
  } catch {
    return null;
  }
}

export async function fetchClobBuyPrice(tokenId?: string): Promise<number | null> {
  if (!tokenId) return null;
  const url = `${clobApiUrl}/price?token_id=${encodeURIComponent(tokenId)}&side=BUY`;
  try {
    const j = await fetchJson<{ price?: string | number }>(url, { timeoutMs: 3500, retries: 1 });
    const px = typeof j.price === "string" ? Number(j.price) : typeof j.price === "number" ? j.price : NaN;
    if (!Number.isFinite(px)) return null;
    return Math.max(0.001, Math.min(0.999, px));
  } catch {
    return null;
  }
}
