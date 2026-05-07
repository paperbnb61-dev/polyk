import dotenv from "dotenv";

dotenv.config();

function envString(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  const t = typeof v === "string" ? v.trim() : "";
  if (t) return t;
  return fallback;
}

function envNumber(name: string, fallback: number): number {
  const raw = envString(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = envString(name);
  if (!raw) return fallback;
  return raw.toLowerCase() === "true";
}

function csv(name: string, fallbackCsv: string): string[] {
  const raw = envString(name, fallbackCsv) ?? fallbackCsv;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const config = {
  telegramBotToken: envString("TELEGRAM_BOT_TOKEN", "") ?? "",
  telegramChatId: envString("TELEGRAM_CHAT_ID", "") ?? "",

  initialUsdc: envNumber("INITIAL_USDC", 15000),
  tradingMarkets: csv("TRADING_MARKETS", "btc"),

  entryThreshold: envNumber("ENTRY_THRESHOLD", 0.55),
  reversalDelta: envNumber("REVERSAL_DELTA", 0.012),
  /** celecula3 API sample: десятки филлов на сторону в одном окне */
  maxBuysPerSide: envNumber("MAX_BUYS_PER_SIDE", 96),
  /** Частые лоты по 17 в публичных трейдах */
  sharesPerOrder: envNumber("SHARES_PER_ORDER", 17),
  maxSumAvg: envNumber("MAX_SUM_AVG", 0.985),
  priceBuffer: envNumber("PRICE_BUFFER", 0.03),
  depthBuyDiscountPercent: envNumber("DEPTH_BUY_DISCOUNT_PERCENT", 0.05),
  secondSideTimeThresholdMs: envNumber("SECOND_SIDE_TIME_THRESHOLD_MS", 120),
  secondSideBuffer: envNumber("SECOND_SIDE_BUFFER", 0.02),
  dynamicThresholdBoost: envNumber("DYNAMIC_THRESHOLD_BOOST", 0.035),

  useClobBooks: envBool("USE_CLOB_BOOKS", true),
  clobApiUrl: envString("CLOB_API_URL", "https://clob.polymarket.com") ?? "https://clob.polymarket.com",
  /** Когда книга не читается: имитация покупки «дороже мид-проекции Gamma» */
  gammaBuySlippage: envNumber("GAMMA_BUY_SLIPPAGE", 0.015),
  priceTick: envNumber("PRICE_TICK", 0.01),

  /** жёсткое чередование как в нашем первом paper-варианте */
  strictAlternation: envBool("STRICT_ALTERNATION", false),
  /**
   * true = после каждого фила переключаем tracking на более «лёгкую» сторону (celecula-стиль перекоса).
   * false = всегда на противоположную ногу к последнему филу как в Github copytrade.
   */
  balancePriorityAfterFill: envBool("BALANCE_PRIORITY_AFTER_FILL", true),
  /** 0 — без лимита на |YES−NO| */
  maxSideImbalanceShares: envNumber("MAX_SIDE_IMBALANCE_SHARES", 0),
  /** CELE V2: burst mode + regime switching */
  enableCeleV2: envBool("ENABLE_CELE_V2", true),
  burstMaxBuysCalm: envNumber("BURST_MAX_BUYS_CALM", 2),
  burstMaxBuysTrend: envNumber("BURST_MAX_BUYS_TREND", 5),
  burstSpacingMs: envNumber("BURST_SPACING_MS", 60),
  trendSideThreshold: envNumber("TREND_SIDE_THRESHOLD", 0.74),
  calmSideThreshold: envNumber("CALM_SIDE_THRESHOLD", 0.58),
  sharesPerOrderCalm: envNumber("SHARES_PER_ORDER_CALM", 12),
  sharesPerOrderTrend: envNumber("SHARES_PER_ORDER_TREND", 17),
  enableAsymmetricSkew: envBool("ENABLE_ASYMMETRIC_SKEW", true),
  skewTargetCalm: envNumber("SKEW_TARGET_CALM", 0.7),
  skewTargetTrend: envNumber("SKEW_TARGET_TREND", 0.8),

  pollIntervalMs: envNumber("POLL_INTERVAL_MS", 140),
  pollSlowMs: envNumber("POLL_SLOW_MS", 620),
  adaptivePolling: envBool("ADAPTIVE_POLLING", true),
  stateFile: envString("STATE_FILE", "paper-state.json") ?? "paper-state.json",
  takerFeeRate: envNumber("TAKER_FEE_RATE", 0.00072),
  debug: envBool("DEBUG", false),
};

export function telegramEnabled(): boolean {
  return Boolean(config.telegramBotToken && config.telegramChatId);
}
