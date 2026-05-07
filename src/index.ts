import { config, telegramEnabled } from "./config.js";
import { fetchGammaMarket } from "./gamma.js";
import { slugForCurrent15m } from "./slug.js";
import { PaperPortfolio, buildMidsMap } from "./portfolio.js";
import {
  applyAfterBuy,
  emptyStrategyState,
  evaluatePaperTick,
  hedgeComplete,
  markBuyFailed,
  type StrategyState,
} from "./strategy.js";
import type { HedgedArbConfig } from "./types.js";
import { hedgeSnapshot } from "./metrics.js";
import { formatBuyAlert, sendTelegramMessage } from "./telegram.js";
import { defaultPersisted, loadState, saveState, type Persisted } from "./state.js";
import { parseSettlementPayout } from "./settlement.js";
import { projectedSumAvg } from "./projections.js";
import { fillForSide, hydrateQuotes } from "./pricing.js";

const arbCfg: HedgedArbConfig = {
  threshold: config.entryThreshold,
  reversalDelta: config.reversalDelta,
  maxBuysPerSide: config.maxBuysPerSide,
  sharesPerSide: config.sharesPerOrder,
  maxSumAvg: config.maxSumAvg,
  depthBuyDiscountPercent: config.depthBuyDiscountPercent,
  secondSideTimeThresholdMs: config.secondSideTimeThresholdMs,
  secondSideBuffer: config.secondSideBuffer,
  dynamicThresholdBoost: config.dynamicThresholdBoost,
  debug: config.debug,
  strictAlternation: config.strictAlternation,
  balancePriorityAfterFill: config.balancePriorityAfterFill,
  maxSideImbalanceShares: config.maxSideImbalanceShares,
};

let persisted = loadState(config.stateFile, config.initialUsdc);

/** Migrate if initial deposit changed intentionally (user bumped INITIAL_USDC) */
if (
  persisted.initialUsdc !== config.initialUsdc &&
  persisted.positions.length === 0 &&
  persisted.cash === persisted.initialUsdc &&
  persisted.realizedPnl === 0
) {
  persisted = defaultPersisted(config.initialUsdc);
}

const portfolio = new PaperPortfolio(persisted.cash);
portfolio.realizedPnl = persisted.realizedPnl;
for (const p of persisted.positions) {
  portfolio.positions.set(p.conditionId, { ...p });
}

function persistFlush(): void {
  const snapshot: Persisted = {
    version: 1,
    initialUsdc: persisted.initialUsdc,
    cash: portfolio.cash,
    realizedPnl: portfolio.realizedPnl,
    positions: [...portfolio.positions.values()],
    strategies: { ...persisted.strategies },
    lastSlugByMarket: { ...persisted.lastSlugByMarket },
  };
  saveState(config.stateFile, snapshot);
  persisted = snapshot;
}

async function maybeSettleOldMarket(market: string, newSlug: string): Promise<void> {
  const prevSlug = persisted.lastSlugByMarket[market];
  if (!prevSlug || prevSlug === newSlug) return;

  try {
    const old = await fetchGammaMarket(prevSlug);
    const pay = parseSettlementPayout(old.upMid, old.downMid, old.closed);
    if (!pay) {
      console.log(`[paper] prior ${market} ${prevSlug} not settled yet → keep MTM`);
      return;
    }
    const cid = old.conditionId;
    if (!portfolio.positions.has(cid)) return;
    const pnl = portfolio.settleMarket(cid, pay.payUp, pay.payDown);
    console.log(`[paper] SETTLE ${old.title.slice(0, 48)} PnL $${pnl.toFixed(4)}`);

    const settleMsg = `<b>PAPER MARKET SETTLED</b>\n<code>${market}</code> ${escapeHtml(prevSlug)}\nPnL this market: <b>${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}</b>\nCash: $${portfolio.cash.toFixed(2)}`;
    if (telegramEnabled()) await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, settleMsg);
    else console.log("[paper telegram disabled]", settleMsg.replace(/<[^>]+>/g, ""));
    persistFlush();
  } catch (e) {
    console.warn(`[paper] settle check failed for ${prevSlug}:`, e);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function notifyStartup(): Promise<void> {
  const mids: { conditionId: string; up: number; down: number }[] = [];
  for (const m of config.tradingMarkets) {
    const slug = slugForCurrent15m(m);
    try {
      const mk = await fetchGammaMarket(slug);
      mids.push({ conditionId: mk.conditionId, up: mk.upMid, down: mk.downMid });
    } catch {
      /* skip */
    }
  }
  const eq = portfolio.equity(buildMidsMap(mids));
  const startMsg = `<b>Paper bot started</b> (celecula-like preset)
<b>Δ</b> size calm/trend: ${config.sharesPerOrderCalm}/${config.sharesPerOrderTrend} (base ${config.sharesPerOrder}) | max ${arbCfg.maxBuysPerSide} legs/side | poll ${config.pollIntervalMs}/${config.pollSlowMs} ms
<b>Δ</b> asymSkew=${config.enableAsymmetricSkew ? "ON" : "OFF"} target calm/trend: ${(config.skewTargetCalm * 100).toFixed(0)}%/${(config.skewTargetTrend * 100).toFixed(0)}%
<b>Δ</b> CLOB books: ${config.useClobBooks ? "ON" : "OFF"} | Γ buy slip: ${config.gammaBuySlippage}
<b>Δ</b> balancePriority=${arbCfg.balancePriorityAfterFill ? "ON" : "OFF"} strictAlt=${arbCfg.strictAlternation ? "ON" : "OFF"} imbalanceCap=${config.maxSideImbalanceShares || "∞"}
Deposit: $${persisted.initialUsdc.toFixed(2)}
Cash: $${portfolio.cash.toFixed(2)}
Equity: $${eq.toFixed(2)}
Markets: ${config.tradingMarkets.join(", ")}`;
  if (telegramEnabled()) await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, startMsg);
  else {
    console.log("Telegram not configured — printing alerts to console only.");
    console.log(startMsg.replace(/<[^>]+>/g, ""));
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    persistFlush();
    saveTimer = null;
  }, 100);
}

async function midsMapForEquity(current: { conditionId: string; up: number; down: number }[]): Promise<
  Map<string, { up: number; down: number }>
> {
  const list = [...current];
  const have = new Set(list.map((x) => x.conditionId));
  for (const pos of portfolio.positions.values()) {
    if (have.has(pos.conditionId)) continue;
    try {
      const m = await fetchGammaMarket(pos.slug);
      list.push({ conditionId: m.conditionId, up: m.upMid, down: m.downMid });
      have.add(pos.conditionId);
    } catch {
      /* ignore MTM gap */
    }
  }
  return buildMidsMap(list);
}

function regimeFromQuotes(up: number, down: number): "trend" | "calm" {
  const hi = Math.max(up, down);
  if (hi >= config.trendSideThreshold) return "trend";
  if (hi >= config.calmSideThreshold) return "calm";
  return "calm";
}

function sharesForRegime(regime: "trend" | "calm"): number {
  if (!config.enableCeleV2) return config.sharesPerOrder;
  return regime === "trend" ? Math.max(1, config.sharesPerOrderTrend) : Math.max(1, config.sharesPerOrderCalm);
}

function skewTargetForRegime(regime: "trend" | "calm"): number {
  return regime === "trend" ? config.skewTargetTrend : config.skewTargetCalm;
}

async function main(): Promise<void> {
  console.log("Polymarket paper bot — Ctrl+C to stop");
  await notifyStartup().catch((e) => console.error("Telegram startup failed:", e));

  for (;;) {
    const now = Date.now();
    const midsList: { conditionId: string; up: number; down: number }[] = [];
    let hadBuyThisLoop = false;
    let hadNearOpportunity = false;

    for (const market of config.tradingMarkets) {
      const slug = slugForCurrent15m(market);
      await maybeSettleOldMarket(market, slug);
      persisted.lastSlugByMarket[market] = slug;

      let mk: Awaited<ReturnType<typeof fetchGammaMarket>>;
      try {
        mk = await fetchGammaMarket(slug);
      } catch (e) {
        console.warn(`[paper] ${market} gamma ${slug}:`, e);
        continue;
      }

      const px = await hydrateQuotes(mk);
      midsList.push({ conditionId: mk.conditionId, up: px.mtmUp, down: px.mtmDown });

      if (!persisted.strategies[market] || persisted.strategies[market].slug !== slug) {
        persisted.strategies[market] = emptyStrategyState(slug);
      }
      const row: StrategyState = persisted.strategies[market]!;
      const upsertRow = (): void => {
        persisted.strategies[market] = row;
        scheduleSave();
      };

      const regime = regimeFromQuotes(px.stratUp, px.stratDown);
      const burstMax = !config.enableCeleV2
        ? 1
        : regime === "trend"
          ? Math.max(1, config.burstMaxBuysTrend)
          : Math.max(1, config.burstMaxBuysCalm);

      for (let burst = 0; burst < burstMax; burst++) {
        const signal = evaluatePaperTick(
          arbCfg,
          row,
          portfolio,
          mk.conditionId,
          upsertRow,
          market,
          slug,
          mk.title,
          px.stratUp,
          px.stratDown,
          now + burst * config.burstSpacingMs
        );

        const nearCheap = px.stratUp <= config.entryThreshold + 0.04 || px.stratDown <= config.entryThreshold + 0.04;
        if (!signal) {
          if (
            nearCheap &&
            row.initialized &&
            (row.buyCountYES < arbCfg.maxBuysPerSide || row.buyCountNO < arbCfg.maxBuysPerSide)
          ) {
            hadNearOpportunity = true;
          }
          break;
        }

        const fillPx = fillForSide(px, signal.side);
        const stratMidPx = signal.side === "YES" ? px.stratUp : px.stratDown;
        const orderShares = sharesForRegime(regime);
        const pos = portfolio.getPosition(mk.conditionId);
        const proj = projectedSumAvg(pos, signal.side, fillPx, orderShares);
        if (proj > config.maxSumAvg + 1e-9) {
          if (config.debug) console.log(`[paper] skip sumAvg would be ${proj.toFixed(4)}`);
          markBuyFailed(row, now);
          upsertRow();
          break;
        }

        try {
          const { fee } = portfolio.simulateBuy(
            slug,
            mk.conditionId,
            mk.title,
            signal.side,
            fillPx,
            orderShares,
            config.takerFeeRate
          );
          if (config.enableAsymmetricSkew) {
            applyAfterBuy(arbCfg, row, slug, signal.side, fillPx, portfolio, mk.conditionId, {
              enabled: true,
              preferredSide: signal.side,
              targetShare: skewTargetForRegime(regime),
            });
          } else {
            applyAfterBuy(arbCfg, row, slug, signal.side, fillPx, portfolio, mk.conditionId);
          }
          upsertRow();
          hadBuyThisLoop = true;

          const equity = portfolio.equity(await midsMapForEquity(midsList));
          const pnlVs = equity - persisted.initialUsdc;
          const sumAvg = portfolio.sumAvgFor(mk.conditionId);
          const hedge = hedgeSnapshot(portfolio.getPosition(mk.conditionId), px.mtmUp, px.mtmDown);

          const msg = formatBuyAlert({
            mode: `${arbCfg.balancePriorityAfterFill ? "cele / balance priority" : "classic flip"} | ${regime} burst ${burst + 1}/${burstMax} | size ${orderShares} | skew ${(skewTargetForRegime(regime) * 100).toFixed(0)}/${(100 - skewTargetForRegime(regime) * 100).toFixed(0)}`,
            market,
            slug,
            side: signal.side,
            price: fillPx,
            stratMid: stratMidPx,
            quotes: px,
            shares: orderShares,
            fee,
            reason: signal.reason,
            cash: portfolio.cash,
            equity,
            pnlVsInitial: pnlVs,
            sumAvg,
            realizedPnl: portfolio.realizedPnl,
            hedge,
            buyCountYES: row.buyCountYES,
            buyCountNO: row.buyCountNO,
          });

          if (telegramEnabled()) await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, msg);
          else console.log("\n--- PAPER BUY ---\n" + msg.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") + "\n");
          persistFlush();

          if (hedgeComplete(row, arbCfg)) {
            const hmsg = `<b>PAPER hedge round done</b> <code>${market}</code>\n<code>${escapeHtml(slug)}</code>\nEquity: $${equity.toFixed(2)}`;
            if (telegramEnabled()) await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, hmsg).catch(() => {});
            else console.log("[hedge complete]", hmsg.replace(/<[^>]+>/g, ""));
            break;
          }

          if (config.enableCeleV2 && burst + 1 < burstMax && config.burstSpacingMs > 0) {
            await new Promise((r) => setTimeout(r, config.burstSpacingMs));
          }
        } catch (e) {
          console.error("[paper] buy failed:", e);
          markBuyFailed(row, now);
          upsertRow();
          break;
        }
      }
    }

    let pause = config.pollIntervalMs;
    if (config.adaptivePolling) pause = hadBuyThisLoop || hadNearOpportunity ? config.pollIntervalMs : config.pollSlowMs;
    await new Promise((r) => setTimeout(r, pause));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
