// Team list from API-Football: the club leagues and national-team tournaments below -> web/src/data/teams-api.js.
// Curated teams (web/src/data/teams.js, with crest colours) win: an API team that matches one only records its id.
// Free plan: 100 requests/day (fixtures.yml uses 4), ~10/minute, limited seasons -> paced, falls back to the newest
// season the plan allows. Run by .github/workflows/teams.yml (manual + monthly); locally:
//   API_FOOTBALL_KEY=... node scripts/fetch-teams.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { TEAMS } from "../web/src/data/teams.js";
import { nameMatch } from "../web/src/teamkeys.js";
import { isProfane } from "../web/src/profanity.js";

const KEY = process.env.API_FOOTBALL_KEY;
if (!KEY) { console.error("API_FOOTBALL_KEY is not set"); process.exit(1); }
const OUT = new URL("../web/src/data/teams-api.js", import.meta.url);
const PACE_MS = Number(process.env.PACE_MS ?? 6500);
const MIN_TEAMS = Number(process.env.MIN_TEAMS ?? 300); // fewer means something went wrong: keep the old file

// [API country, API league name]; order = search ranking for API teams
const CLUBS = [
  ["England", "Premier League"], ["Spain", "La Liga"], ["Germany", "Bundesliga"], ["Italy", "Serie A"], ["France", "Ligue 1"],
  ["Hungary", "NB I"], ["Portugal", "Primeira Liga"], ["Netherlands", "Eredivisie"], ["Belgium", "Jupiler Pro League"],
  ["Turkey", "Süper Lig"], ["Scotland", "Premiership"], ["Greece", "Super League 1"], ["Austria", "Bundesliga"],
  ["Switzerland", "Super League"], ["Czech-Republic", "Czech Liga"], ["Poland", "Ekstraklasa"], ["Croatia", "HNL"],
  ["Serbia", "Super Liga"], ["Romania", "Liga I"], ["Ukraine", "Premier League"], ["Denmark", "Superliga"],
  ["Sweden", "Allsvenskan"], ["Norway", "Eliteserien"], ["Slovakia", "Super Liga"], ["Slovenia", "1. SNL"],
  ["Bulgaria", "First League"], ["Russia", "Premier League"], ["Israel", "Ligat Ha'al"], ["Cyprus", "1. Division"],
  ["Finland", "Veikkausliiga"], ["Ireland", "Premier Division"],
  ["England", "Championship"], ["England", "League One"], ["England", "League Two"], ["Spain", "Segunda División"],
  ["Germany", "2. Bundesliga"], ["Italy", "Serie B"], ["France", "Ligue 2"], ["Hungary", "NB II"],
  ["Argentina", "Liga Profesional Argentina"], ["Brazil", "Serie A"], ["Brazil", "Serie B"], ["Mexico", "Liga MX"],
  ["USA", "Major League Soccer"], ["Colombia", "Primera A"], ["Chile", "Primera División"], ["Uruguay", "Primera División - Apertura"],
  ["Peru", "Primera División"], ["Ecuador", "Liga Pro"], ["Paraguay", "Division Profesional - Apertura"],
  ["Saudi-Arabia", "Pro League"], ["Japan", "J1 League"], ["South-Korea", "K League 1"], ["China", "Super League"],
  ["Australia", "A-League"], ["India", "Indian Super League"], ["Iran", "Persian Gulf Pro League"],
  ["Egypt", "Premier League"], ["Morocco", "Botola Pro"], ["South-Africa", "Premier Soccer League"], ["Tunisia", "Ligue 1"],
];
const NATIONAL = [
  ["World", "World Cup"], ["World", "Euro Championship"], ["World", "Copa America"],
  ["World", "Africa Cup of Nations"], ["World", "Asian Cup"],
];

// API country -> our 3-letter code (teams.js); anything else: first three letters
const CODE = {
  England: "ENG", Scotland: "SCO", Wales: "WAL", Spain: "ESP", Germany: "GER", Italy: "ITA", France: "FRA", Hungary: "HUN",
  Portugal: "POR", Netherlands: "NED", Belgium: "BEL", Turkey: "TUR", Greece: "GRE", Austria: "AUT", Switzerland: "SUI",
  "Czech-Republic": "CZE", Poland: "POL", Croatia: "CRO", Serbia: "SRB", Romania: "ROU", Ukraine: "UKR", Denmark: "DEN",
  Sweden: "SWE", Norway: "NOR", Slovakia: "SVK", Slovenia: "SVN", Bulgaria: "BUL", Russia: "RUS", Israel: "ISR",
  Cyprus: "CYP", Finland: "FIN", Ireland: "IRL", Monaco: "MON", Argentina: "ARG", Brazil: "BRA", Mexico: "MEX",
  USA: "USA", Canada: "CAN", Colombia: "COL", Chile: "CHI", Uruguay: "URU", Peru: "PER", Ecuador: "ECU", Paraguay: "PAR",
  "Saudi-Arabia": "KSA", Japan: "JPN", "South-Korea": "KOR", China: "CHN", Australia: "AUS", India: "IND", Iran: "IRN",
  Egypt: "EGY", Morocco: "MAR", "South-Africa": "RSA", Tunisia: "TUN",
};
const code = country => CODE[country] || String(country || "").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase();

let calls = 0, remaining = "?";
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(path) {
  if (calls++) await sleep(PACE_MS);
  const r = await fetch("https://v3.football.api-sports.io" + path, { headers: { "x-apisports-key": KEY } });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  remaining = r.headers.get("x-ratelimit-requests-remaining") ?? remaining;
  const j = await r.json();
  const errs = Array.isArray(j.errors) ? j.errors : Object.values(j.errors || {});
  if (errs.length) throw Object.assign(new Error(`${path}: ${errs.join("; ")}`), { plan: errs.join(" ") });
  return j.response || [];
}

// free plan: "... do not have access to this season, try from 2022 to 2024." -> remember the newest allowed season
let maxSeason = Infinity;
async function teamsOf(league, season) {
  const s = Math.min(season, maxSeason);
  try { return await api(`/teams?league=${league}&season=${s}`); }
  catch (e) {
    const m = /(\d{4})\D+(\d{4})/.exec(e.plan || "");
    if (!m || Number(m[2]) >= s) throw e;
    maxSeason = Number(m[2]);
    console.warn(`season ${s} not on this plan, using ${maxSeason}`);
    return api(`/teams?league=${league}&season=${maxSeason}`);
  }
}

const leagues = new Map();
for (const x of await api("/leagues?current=true"))
  leagues.set(`${x.country.name}|${x.league.name}`.toLowerCase(), { id: x.league.id, season: x.seasons?.[0]?.year });

const seen = new Map(); // API id -> { name, country, national }
let failed = 0;
for (const [list, national] of [[CLUBS, false], [NATIONAL, true]]) {
  for (const [country, name] of list) {
    const lg = leagues.get(`${country}|${name}`.toLowerCase());
    if (!lg || !lg.season) { console.warn(`not found: ${country} / ${name}`); failed++; continue; }
    try {
      const got = await teamsOf(lg.id, lg.season);
      for (const { team } of got) if (team && team.national === national && !seen.has(team.id)) seen.set(team.id, { name: team.name.trim(), country: national ? "NAT" : code(team.country), national });
      console.log(`${country} / ${name}: ${got.length}`);
    } catch (e) { console.warn(String(e.message)); failed++; }
  }
}
if (failed > (CLUBS.length + NATIONAL.length) / 2) { console.error(`${failed} lists failed, keeping the old file`); process.exit(1); }

// curated teams take the id of their API twin and are not listed again; youth, reserve and women's sides are left out
const YOUTH = /\s(U\d{2}|W|Women|Reserves?)$/i; // not "II": Willem II is a first-team club
const ids = {}, rest = [], skipped = [];
for (const [id, t] of seen) {
  const twin = TEAMS.find(([n, c]) => (c === "NAT") === t.national && (t.national || c === t.country) && nameMatch(n, t.name));
  if (twin) { if (!(twin[0] in ids)) ids[twin[0]] = id; continue; }
  if (t.name.length > 40 || isProfane(t.name) || YOUTH.test(t.name)) { skipped.push(t.name); continue; }
  rest.push([t.name, t.country, id]);
}
// same name in two countries ("Nacional"), or a curated name: the API team gets the country code, pins store the name only
const count = new Map(TEAMS.map(([n]) => [n.toLowerCase(), 1]));
for (const t of rest) count.set(t[0].toLowerCase(), (count.get(t[0].toLowerCase()) || 0) + 1);
for (const t of rest) if (count.get(t[0].toLowerCase()) > 1) t[0] = `${t[0]} (${t[1]})`;

if (rest.length + Object.keys(ids).length < MIN_TEAMS) { console.error(`only ${rest.length} teams, keeping the old file`); process.exit(1); }

const body = "// Generated by scripts/fetch-teams.mjs from API-Football. Do not edit by hand: curate web/src/data/teams.js instead.\n"
  + "// [name, country, API-Football team id]; colours come from hashColor() in main.js\n"
  + "export const API_TEAMS = [\n" + rest.map(t => JSON.stringify(t)).join(",\n") + "\n];\n"
  + "// curated teams.js name -> API-Football team id\n"
  + "export const API_IDS = {\n" + Object.entries(ids).map(([n, id]) => `${JSON.stringify(n)}: ${id}`).join(",\n") + "\n};\n";
const prev = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
if (prev !== body) writeFileSync(OUT, body);
console.log(`${rest.length} API teams, ${Object.keys(ids).length}/${TEAMS.length} curated teams with an id, ${skipped.length} skipped${skipped.length ? " (" + skipped.join(", ") + ")" : ""}`);
console.log(`curated without id: ${TEAMS.filter(([n]) => !(n in ids)).map(([n]) => n).join(", ") || "none"}`);
console.log(`${calls} requests, ${remaining} left today, ${prev === body ? "no change" : "written"}`);
