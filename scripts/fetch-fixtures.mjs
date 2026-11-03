// Daily fixtures snapshot from API-Football (free plan: yesterday..tomorrow, 100 requests/day).
// One request per date returns every match of that day (no paging). Writes data/fixtures/<UTC date>.json,
// which GitHub Pages serves to the app. Run by .github/workflows/fixtures.yml; locally:
//   API_FOOTBALL_KEY=... node scripts/fetch-fixtures.mjs
import { mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";

const KEY = process.env.API_FOOTBALL_KEY;
if (!KEY) { console.error("API_FOOTBALL_KEY is not set"); process.exit(1); }
const DIR = new URL("../data/fixtures/", import.meta.url);
const KEEP_DAYS = 3;

const iso = d => d.toISOString().slice(0, 10);
const day = (offset) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return iso(d); };

async function fetchDay(date) {
  const r = await fetch("https://v3.football.api-sports.io/fixtures?date=" + date, { headers: { "x-apisports-key": KEY } });
  if (!r.ok) throw new Error(`${date}: HTTP ${r.status}`);
  const j = await r.json();
  const errs = Array.isArray(j.errors) ? j.errors : Object.values(j.errors || {});
  if (errs.length) throw new Error(`${date}: ${errs.join("; ")}`);
  if (j.paging && j.paging.total > 1) console.warn(`${date}: paging.total = ${j.paging.total}, only page 1 kept`);
  // compact tuples: [fixtureId, kickoff (unix s), status, leagueId, league, country, homeId, home, awayId, away]
  const fixtures = (j.response || []).map(x => [
    x.fixture.id, x.fixture.timestamp, x.fixture.status?.short || "NS",
    x.league.id, x.league.name, x.league.country,
    x.teams.home.id, x.teams.home.name, x.teams.away.id, x.teams.away.name,
  ]);
  return { date, updatedAt: new Date().toISOString(), count: fixtures.length, fixtures };
}

mkdirSync(DIR, { recursive: true });
const dates = [day(0), day(1)];
const written = [];
for (const date of dates) {
  const data = await fetchDay(date);
  const file = new URL(date + ".json", DIR);
  const prev = existsSync(file) ? readFileSync(file, "utf8") : null;
  const next = JSON.stringify(data);
  // ignore updatedAt when comparing, so an unchanged day does not create a commit
  if (!prev || JSON.stringify({ ...JSON.parse(prev), updatedAt: 0 }) !== JSON.stringify({ ...data, updatedAt: 0 })) writeFileSync(file, next);
  written.push(`${date}: ${data.count} fixtures`);
}
// keep only the last few days
const cutoff = day(-KEEP_DAYS);
for (const f of readdirSync(DIR)) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < cutoff) rmSync(new URL(f, DIR));
console.log(written.join("\n"));
