import fs from "fs";
import path from "path";
import type { OpenPosition } from "./portfolio.js";
import type { StrategyState } from "./strategy.js";

export type Persisted = {
  version: 1;
  initialUsdc: number;
  cash: number;
  realizedPnl: number;
  positions: OpenPosition[];
  /** key: market symbol (btc, eth, …) — one active 15m slug at a time */
  strategies: Record<string, StrategyState>;
  lastSlugByMarket: Record<string, string>;
};

export function defaultPersisted(initialUsdc: number): Persisted {
  return {
    version: 1,
    initialUsdc,
    cash: initialUsdc,
    realizedPnl: 0,
    positions: [],
    strategies: {},
    lastSlugByMarket: {},
  };
}

export function loadState(file: string, initialUsdc: number): Persisted {
  const p = path.resolve(process.cwd(), file);
  try {
    const raw = fs.readFileSync(p, "utf8").trim();
    if (!raw) return defaultPersisted(initialUsdc);
    const j = JSON.parse(raw) as Persisted;
    if (j.version !== 1 || typeof j.cash !== "number") return defaultPersisted(initialUsdc);
    return j;
  } catch {
    return defaultPersisted(initialUsdc);
  }
}

export function saveState(file: string, data: Persisted): void {
  const p = path.resolve(process.cwd(), file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}
