import { fetchJson } from "./http.js";

export type ParsedMarket = {
  slug: string;
  conditionId: string;
  title: string;
  closed: boolean;
  /** Mid-like prices from Gamma (Up, Down order) */
  upMid: number;
  downMid: number;
  bestBid?: number;
  bestAsk?: number;
  upTokenId?: string;
  downTokenId?: string;
};

function parseJsonArray(raw: unknown, ctx: string): string[] {
  if (typeof raw === "string") {
    const p = JSON.parse(raw) as unknown;
    if (Array.isArray(p) && p.every((x) => typeof x === "string")) return p;
    throw new Error(`${ctx}: string is not JSON string[]`);
  }
  throw new Error(`${ctx}: expected string`);
}

export async function fetchGammaMarket(slug: string): Promise<ParsedMarket> {
  const url = `https://gamma-api.polymarket.com/markets/slug/${encodeURIComponent(slug)}`;
  const data = (await fetchJson<Record<string, unknown>>(url)) as Record<string, unknown>;

  const outcomes = parseJsonArray(data.outcomes, "outcomes");
  let tokenIds: string[] = [];
  try {
    tokenIds = parseJsonArray(data.clobTokenIds, "clobTokenIds");
  } catch {
    tokenIds = [];
  }

  const pricesRaw = parseJsonArray(data.outcomePrices, "outcomePrices");
  const upIdx = outcomes.indexOf("Up");
  const downIdx = outcomes.indexOf("Down");
  if (upIdx < 0 || downIdx < 0) throw new Error(`${slug}: missing Up/Down`);

  const nums = pricesRaw.map((s) => Number(s));
  if (!nums.every(Number.isFinite)) throw new Error(`${slug}: bad outcomePrices`);

  const conditionId = String(data.conditionId ?? "");
  if (!conditionId.startsWith("0x")) throw new Error(`${slug}: missing conditionId`);

  const bid = typeof data.bestBid === "number" ? data.bestBid : undefined;
  const ask = typeof data.bestAsk === "number" ? data.bestAsk : undefined;

  const upMid = nums[upIdx]!;
  const downMid = nums[downIdx]!;

  const upTok = tokenIds[upIdx];
  const downTok = tokenIds[downIdx];

  return {
    slug,
    conditionId,
    title: String(data.question ?? slug),
    closed: Boolean(data.closed),
    upMid,
    downMid,
    bestBid: bid,
    bestAsk: ask,
    upTokenId: typeof upTok === "string" && upTok.length > 10 ? upTok : undefined,
    downTokenId: typeof downTok === "string" && downTok.length > 10 ? downTok : undefined,
  };
}
