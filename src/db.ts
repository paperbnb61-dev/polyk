import { Pool } from "pg";

let pool: any = null;
let initDone = false;

function getPool(): any {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
  }
  return pool;
}

export async function ensureDbReady(): Promise<boolean> {
  const p = getPool();
  if (!p) return false;
  if (initDone) return true;
  await p.query(`
    CREATE TABLE IF NOT EXISTS collector_rows (
      id BIGSERIAL PRIMARY KEY,
      collector TEXT NOT NULL,
      ts_utc TIMESTAMPTZ NOT NULL,
      ts_ms BIGINT NOT NULL,
      ts_local TEXT NOT NULL,
      market TEXT NOT NULL,
      slug TEXT NOT NULL,
      up_cents_buy INTEGER,
      down_cents_buy INTEGER,
      payload JSONB NOT NULL
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_collector_rows_ts ON collector_rows (ts_utc DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_collector_rows_slug ON collector_rows (slug);`);
  await p.query(`
    CREATE TABLE IF NOT EXISTS paper_events (
      id BIGSERIAL PRIMARY KEY,
      ts_utc TIMESTAMPTZ NOT NULL,
      ts_ms BIGINT NOT NULL,
      level TEXT NOT NULL,
      market TEXT NOT NULL,
      slug TEXT,
      event_type TEXT,
      message TEXT NOT NULL,
      payload JSONB NOT NULL
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_paper_events_ts ON paper_events (ts_utc DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_paper_events_market ON paper_events (market);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_paper_events_slug ON paper_events (slug);`);
  initDone = true;
  return true;
}

export async function insertCollectorRow(row: {
  collector: string;
  tsUtc: string;
  tsMs: number;
  tsLocal: string;
  market: string;
  slug: string;
  upCentsBuy: number | null;
  downCentsBuy: number | null;
  payload: unknown;
}): Promise<void> {
  const p = getPool();
  if (!p) return;
  await ensureDbReady();
  await p.query(
    `INSERT INTO collector_rows
      (collector, ts_utc, ts_ms, ts_local, market, slug, up_cents_buy, down_cents_buy, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      row.collector,
      row.tsUtc,
      Math.trunc(row.tsMs),
      row.tsLocal,
      row.market,
      row.slug,
      row.upCentsBuy,
      row.downCentsBuy,
      JSON.stringify(row.payload),
    ]
  );
}

export async function insertPaperEvent(row: {
  tsUtc: string;
  tsMs: number;
  level: "info" | "warn" | "error";
  market: string;
  slug?: string | null;
  eventType?: string | null;
  message: string;
  payload: unknown;
}): Promise<void> {
  const p = getPool();
  if (!p) return;
  await ensureDbReady();
  await p.query(
    `INSERT INTO paper_events
      (ts_utc, ts_ms, level, market, slug, event_type, message, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      row.tsUtc,
      Math.trunc(row.tsMs),
      row.level,
      row.market,
      row.slug ?? null,
      row.eventType ?? null,
      row.message,
      JSON.stringify(row.payload),
    ]
  );
}

