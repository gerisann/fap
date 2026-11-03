/* Match days. data/fixtures/<UTC date>.json is written twice a day by .github/workflows/fixtures.yml
   (API-Football, one request per date) and served by GitHub Pages. Tuples:
   [fixtureId, kickoff (unix s), status, leagueId, league, country, homeId, home, awayId, away] */
import { API_TEAMS, API_IDS } from "./data/teams-api.js";
import { nameMatch } from "./teamkeys.js";

// dev only: localStorage "tm.fxbase" = "/fixtures-dev/" reads hand-made test files from web/public instead
const BASE = (import.meta.env.DEV && (() => { try { return localStorage.getItem("tm.fxbase"); } catch (_) { return null; } })()) || "https://gerisann.github.io/fap/data/fixtures/";
const MATCH_MS = 2.5 * 3600 * 1000; // a match is over ~2.5 h after kick-off (extra time included)
const DONE = new Set(["FT", "AET", "PEN", "CANC", "ABD", "AWD", "WO", "PST"]);

// a team with a known API-Football id (teams-api.js) is matched by id, any other (typed) name by spelling
const ID_OF = new Map([...API_TEAMS.map(([n, , id]) => [n, id]), ...Object.entries(API_IDS)]);
export const isTeam = (team, apiName, apiId) => ID_OF.has(team) ? ID_OF.get(team) === apiId : nameMatch(team, apiName);

/* ---------- loading ---------- */
const cache = new Map(); // UTC date -> Promise<tuples[]>
const utcDate = ms => new Date(ms).toISOString().slice(0, 10);
function loadDay(date) {
  if (!cache.has(date)) cache.set(date, fetch(BASE + date + ".json", { cache: "no-cache" }).then(r => r.ok ? r.json() : { fixtures: [] }).then(j => j.fixtures || []).catch(() => []));
  return cache.get(date);
}
const toFixture = x => ({ id: x[0], kickoff: x[1] * 1000, status: x[2], league: x[4], country: x[5], homeId: x[6], home: x[7], awayId: x[8], away: x[9] });

/* A team's fixtures over `days` local days from today (2 = today + tomorrow, as far as the free plan sees).
   Local days can span one more UTC file than there are days; a file not written yet just reads as empty. */
export async function matchesOf(team, days = 1, now = Date.now()) {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + days);
  const dates = [...new Set([...Array(days + 1)].map((_, i) => utcDate(Math.min(start.getTime() + i * 86400000, end.getTime() - 1))))];
  const all = (await Promise.all(dates.map(loadDay))).flat().map(toFixture);
  const seen = new Set();
  return all.filter(f => f.kickoff >= start.getTime() && f.kickoff < end.getTime() && !seen.has(f.id) && seen.add(f.id))
    .filter(f => isTeam(team, f.home, f.homeId) || isTeam(team, f.away, f.awayId))
    .map(f => ({ ...f, side: isTeam(team, f.home, f.homeId) ? "h" : "a", over: DONE.has(f.status) || now > f.kickoff + MATCH_MS }))
    .sort((a, b) => a.kickoff - b.kickoff);
}
export const todaysMatches = (team, now = Date.now()) => matchesOf(team, 1, now);
// "cheering is open all day long until the match is over"
export const cheerOpen = f => !!f && !f.over;
