const fs = require("fs");
const wallet = "0x518705eeeddae350ca09a0af8e9f50bdc42ad7ec";

async function main() {
  const url = `https://data-api.polymarket.com/trades?user=${wallet}&limit=500`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(String(res.status));
  const trades = await res.json();
  const out = [];
  const now = Math.floor(Date.now() / 1000);
  const dayAgo = now - 86400;
  const recent = trades.filter((t) => t.timestamp >= dayAgo);
  let buyNotional = 0;
  const bySlug = {};
  for (const t of recent) {
    if (t.side !== "BUY") continue;
    const slug = t.slug || "unknown";
    if (!bySlug[slug]) bySlug[slug] = { n: 0, up$: 0, down$: 0, upSz: 0, downSz: 0 };
    const cost = t.size * t.price;
    buyNotional += cost;
    bySlug[slug].n++;
    if (t.outcome === "Up") {
      bySlug[slug].up$ += cost;
      bySlug[slug].upSz += t.size;
    } else {
      bySlug[slug].down$ += cost;
      bySlug[slug].downSz += t.size;
    }
  }
  out.push(`API trades=${trades.length} last24h_all=${recent.length} last24h_BUY=${recent.filter((t) => t.side === "BUY").length}`);
  out.push(`24h BUY notional $${buyNotional.toFixed(2)}`);
  out.push("--- per slug (BUY) ---");
  const slugs = Object.entries(bySlug).sort((a, b) => b[1].n - a[1].n);
  for (const [slug, s] of slugs.slice(0, 25)) {
    const au = s.upSz > 0 ? s.up$ / s.upSz : 0;
    const ad = s.downSz > 0 ? s.down$ / s.downSz : 0;
    const imb = s.upSz - s.downSz;
    out.push(
      `${slug} | n=${s.n} avgUp=${au.toFixed(4)} avgDn=${ad.toFixed(4)} sum=${(au + ad).toFixed(4)} upVol=${s.upSz.toFixed(0)} dnVol=${s.downSz.toFixed(0)} imb=${imb.toFixed(0)}`
    );
  }
  const sizes = {};
  for (const t of recent) {
    if (t.side !== "BUY") continue;
    const k = String(t.size);
    sizes[k] = (sizes[k] || 0) + 1;
  }
  out.push("--- buy size histogram ---");
  out.push(JSON.stringify(Object.entries(sizes).sort((a, b) => b[1] - a[1]).slice(0, 15)));
  const text = out.join("\n");
  fs.writeFileSync(require("path").join(__dirname, "cele-out.txt"), text, "utf8");
  console.log(text);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
