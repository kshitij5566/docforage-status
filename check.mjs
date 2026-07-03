// DocForage external prober — runs on GitHub Actions every 5 minutes.
// Probes the public surface, keeps per-day aggregates (30d), regenerates the
// static status page, and flags DOWN/UP transitions for the workflow to turn
// into GitHub issues. No secrets, no state beyond this repo.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const TIMEOUT = 15000;
const DATA = "docs/data.json";
const PAGE = "docs/index.html";

async function probe(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), redirect: "follow" });
    const ms = Date.now() - started;
    let body = null;
    try { body = await res.json(); } catch { /* HTML pages */ }
    return { ok: res.ok, ms, body };
  } catch {
    return { ok: false, ms: Date.now() - started, body: null };
  }
}

const [site, api, docs] = await Promise.all([
  probe("https://docforage.com/"),
  probe("https://api.docforage.com/health"),
  probe("https://docforage.com/docs"),
]);

// The API health body reports its dependencies — surface them as services.
const services = {
  website: { label: "Website", ok: site.ok, ms: site.ms },
  api: { label: "API", ok: api.ok, ms: api.ms },
  database: { label: "Database", ok: api.ok && api.body?.db === true, ms: api.ms },
  search: { label: "Search", ok: api.ok && api.body?.search === true, ms: api.ms },
  docs: { label: "Documentation", ok: docs.ok, ms: docs.ms },
};

const data = existsSync(DATA)
  ? JSON.parse(readFileSync(DATA, "utf8"))
  : { days: {}, current: {}, incidents: [] };

const now = new Date();
const today = now.toISOString().slice(0, 10);
const hour = now.toISOString().slice(0, 13);

// Per-day aggregates (drop days older than 30).
data.days[today] ??= {};
for (const [id, s] of Object.entries(services)) {
  const d = (data.days[today][id] ??= { up: 0, total: 0, msSum: 0 });
  d.total += 1;
  if (s.ok) { d.up += 1; d.msSum += s.ms; }
}
for (const day of Object.keys(data.days)) {
  if ((now - new Date(day)) / 86400000 > 30) delete data.days[day];
}

// Transitions → incidents + flags for the workflow.
let wentDown = [], wentUp = [];
for (const [id, s] of Object.entries(services)) {
  const prev = data.current[id]?.ok;
  if (prev !== false && !s.ok) {
    wentDown.push(services[id].label);
    data.incidents.unshift({ service: services[id].label, start: now.toISOString(), end: null });
  }
  if (prev === false && s.ok) {
    wentUp.push(services[id].label);
    const open = data.incidents.find((i) => i.service === services[id].label && !i.end);
    if (open) open.end = now.toISOString();
  }
}
data.incidents = data.incidents.slice(0, 20);

const statusChanged = wentDown.length > 0 || wentUp.length > 0;
const hourRolled = data.lastHour !== hour;
data.current = Object.fromEntries(Object.entries(services).map(([id, s]) => [id, { ok: s.ok, ms: s.ms }]));

if (wentDown.length) writeFileSync(".transition-down", wentDown.join(", "));
if (wentUp.length) writeFileSync(".transition-up", wentUp.join(", "));

// Commit budget: persist only on a status change or once per hour.
if (!statusChanged && !hourRolled) process.exit(0);
data.lastHour = hour;
data.updated = now.toISOString();
writeFileSync(DATA, JSON.stringify(data));

// ─── Render the page ─────────────────────────────────────────────────────────
const allOk = Object.values(services).every((s) => s.ok);
const days30 = [...Array(30)].map((_, i) => {
  const d = new Date(now - (29 - i) * 86400000);
  return d.toISOString().slice(0, 10);
});

const pct = (id) => {
  let up = 0, total = 0;
  for (const day of Object.values(data.days)) {
    if (day[id]) { up += day[id].up; total += day[id].total; }
  }
  return total ? ((100 * up) / total).toFixed(2) : "100.00";
};

const cells = (id) =>
  days30
    .map((day) => {
      const d = data.days[day]?.[id];
      const cls = !d ? "nodata" : d.up === d.total ? "up" : d.up === 0 ? "down" : "partial";
      const tip = !d ? `${day}: no data` : `${day}: ${((100 * d.up) / d.total).toFixed(1)}% up`;
      return `<i class="${cls}" title="${tip}"></i>`;
    })
    .join("");

const rows = Object.entries(services)
  .map(
    ([id, s]) => `<div class="svc">
  <div class="svc-head"><b>${s.label}</b><span class="${s.ok ? "ok" : "down"}">${s.ok ? "operational" : "down"}</span><span class="pct">${pct(id)}% · 30d</span></div>
  <div class="bars">${cells(id)}</div>
</div>`,
  )
  .join("\n");

const incidents = data.incidents.length
  ? data.incidents
      .map(
        (i) =>
          `<div class="incident"><b>${i.service}</b> — ${i.start.replace("T", " ").slice(0, 16)} UTC${i.end ? ` → resolved ${i.end.replace("T", " ").slice(0, 16)} UTC` : " · <span class='down'>ongoing</span>"}</div>`,
      )
      .join("\n")
  : `<p class="muted">No incidents recorded in the last 30 days of monitoring.</p>`;

writeFileSync(
  PAGE,
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DocForage status</title>
<meta http-equiv="refresh" content="300" />
<style>
  :root { color-scheme: light; --paper:#f7f9fa; --surface:#fff; --ink:#182430; --muted:#5b6b78; --line:#dde3e8; --seal:#106b54; --seal-dark:#0c5642; --seal-soft:#e3efeb; --danger:#a93226;
    --serif:"Iowan Old Style",Palatino,Georgia,serif; --sans:system-ui,-apple-system,"Segoe UI",sans-serif; --mono:ui-monospace,Menlo,Consolas,monospace; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--paper); color:var(--ink); font:15px/1.6 var(--sans); }
  .wrap { max-width:720px; margin:0 auto; padding:0 1.3rem 3rem; }
  header { display:flex; align-items:baseline; gap:1rem; padding:1rem 0; }
  .wordmark { font:600 1.25rem/1 var(--serif); color:var(--ink); text-decoration:none; }
  header a.back { margin-left:auto; font-size:.85rem; color:var(--seal-dark); }
  .banner { border:1px solid var(--line); border-top:3px double var(--ink); border-radius:0 0 10px 10px; padding:1rem 1.3rem; font-weight:600; background:${allOk ? "var(--seal-soft)" : "#f6e9e7"}; color:${allOk ? "var(--seal-dark)" : "var(--danger)"}; }
  .muted { color:var(--muted); font-size:.85rem; }
  .svc { background:var(--surface); border:1px solid var(--line); border-radius:10px; padding: .9rem 1.1rem; margin:.7rem 0; }
  .svc-head { display:flex; gap:.8rem; align-items:baseline; }
  .svc-head .ok { color:var(--seal-dark); font-size:.85rem; font-weight:600; }
  .svc-head .down, .down { color:var(--danger); font-size:.85rem; font-weight:600; }
  .svc-head .pct { margin-left:auto; font:.78rem var(--mono); color:var(--muted); }
  .bars { display:flex; gap:2px; margin-top:.6rem; }
  .bars i { flex:1; height:22px; border-radius:2px; background:var(--seal); opacity:.85; }
  .bars i.partial { background:#c98a2b; } .bars i.down { background:var(--danger); } .bars i.nodata { background:var(--line); }
  h2 { font:600 .74rem var(--sans); letter-spacing:.12em; text-transform:uppercase; color:var(--seal-dark); margin:2rem 0 .6rem; }
  .incident { background:var(--surface); border:1px solid var(--line); border-radius:8px; padding:.6rem .9rem; margin:.4rem 0; font-size:.9rem; }
  footer { margin-top:2.4rem; font-size:.82rem; color:var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <header><a class="wordmark" href="https://docforage.com">DocForage</a><a class="back" href="https://docforage.com">← docforage.com</a></header>
  <div class="banner">${allOk ? "All systems operational" : "Service disruption — we're on it"}</div>
  <p class="muted">Checked every 5 minutes from GitHub's infrastructure (independent of ours). Page data refreshes hourly or immediately on any status change. Last update: ${now.toISOString().replace("T", " ").slice(0, 16)} UTC.</p>
  ${rows}
  <h2>Incidents (30 days)</h2>
  ${incidents}
  <footer>DocForage — entitlement-aware document infrastructure. Incident history is also public in this page's <a href="https://github.com/kshitij5566/docforage-status">repository</a>.</footer>
</div>
</body>
</html>`,
);
console.log(`updated (changed=${statusChanged}, down=${wentDown}, up=${wentUp})`);
