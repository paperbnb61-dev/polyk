import { config } from "./config.js";
import { fetchJson } from "./http.js";

type RawBook = {
  bids?: { price?: string | number }[];
  asks?: { price?: string | number }[];
};

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  }
  return null;
}

/** Best bid/ask + mid from CLOB REST (public). Returns null if book missing or unreachable. */
export async function fetchClobTop(tokenId: string): Promise<{ bid: number; ask: number; mid: number } | null> {
  try {
    const url = `${config.clobApiUrl.replace(/\/$/, "")}/book?token_id=${encodeURIComponent(tokenId)}`;
    const book = await fetchJson<RawBook>(url, { timeoutMs: 22_000, retries: 2 });
    const bidP = book.bids?.length ? num(book.bids[0]?.price) : null;
    const askP = book.asks?.length ? num(book.asks[0]?.price) : null;
    if (bidP === null || askP === null) return null;
    if (!(bidP >= 0 && askP <= 1 && bidP <= askP + 1e-6)) return null;
    const mid = (bidP + askP) / 2;
    return { bid: bidP, ask: askP, mid };
  } catch {
    return null;
  }
}
