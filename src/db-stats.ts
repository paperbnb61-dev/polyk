import dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config();

async function main(): Promise<void> {
  const url = (process.env.DATABASE_URL ?? "").trim();
  if (!url) {
    console.error("DATABASE_URL is not set in .env");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    const r = await pool.query(`
      SELECT COUNT(*)::int AS rows,
             MIN(ts_utc) AS from_ts,
             MAX(ts_utc) AS to_ts,
             COUNT(DISTINCT slug)::int AS slugs
      FROM collector_rows
      WHERE market = 'btc'
        AND up_cents_buy IS NOT NULL
        AND ts_utc >= NOW() - INTERVAL '7 days'
    `);
    console.log("collector_rows (btc, last 7 days):");
    console.log(JSON.stringify(r.rows[0], null, 2));

    const pe = await pool.query(`
      SELECT COUNT(*)::int AS rows
      FROM paper_events
      WHERE ts_utc >= NOW() - INTERVAL '7 days'
    `).catch(() => null);
    if (pe) {
      console.log("paper_events (last 7 days):", pe.rows[0]?.rows ?? 0);
    } else {
      console.log("paper_events: table missing or empty");
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
