function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

import { fetchWithRetry } from "./http.js";

export async function sendTelegramMessage(botToken: string, chatId: string, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
    timeoutMs: 45_000,
    retries: 3,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram ${res.status}: ${body}`);
  }
}

import type { HedgeSnapshot } from "./metrics.js";
import type { LiveQuotes } from "./pricing.js";

export function formatBuyAlert(p: {
  mode: string;
  market: string;
  slug: string;
  side: string;
  /** Simulated fill (ask / gamma+slip) */
  price: number;
  stratMid: number;
  quotes: LiveQuotes;
  shares: number;
  fee: number;
  reason: string;
  cash: number;
  equity: number;
  pnlVsInitial: number;
  sumAvg: number;
  realizedPnl: number;
  hedge: HedgeSnapshot;
  buyCountYES: number;
  buyCountNO: number;
}): string {
  const pnlSign = p.pnlVsInitial >= 0 ? "+" : "";
  const totalBuys = p.buyCountYES + p.buyCountNO;
  const fillPct = p.price * 100;
  const midPct = p.stratMid * 100;
  return [
    `<b>BUY ${esc(p.market)} ${esc(p.side)}</b> x${p.shares}`,
    `<b>Price:</b> ${fillPct.toFixed(2)}% (mid ${midPct.toFixed(2)}%)`,
    `<b>Buys:</b> total ${totalBuys} | YES ${p.buyCountYES} | NO ${p.buyCountNO}`,
    `<b>PnL:</b> ${pnlSign}$${p.pnlVsInitial.toFixed(2)} | Realized $${p.realizedPnl.toFixed(2)}`,
    `<code>${esc(p.slug)}</code>`,
  ].join("\n");
}
