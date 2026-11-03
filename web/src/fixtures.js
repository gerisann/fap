/* Match days. data/fixtures/<UTC date>.json is written twice a day by .github/workflows/fixtures.yml
   (API-Football, one request per date) and served by GitHub Pages. Tuples:
   [fixtureId, kickoff (unix s), status, leagueId, league, country, homeId, home, awayId, away] */

// dev only: localStorage "tm.fxbase" = "/fixtures-dev/" reads hand-made test files from web/public instead
const BASE = (import.meta.env.DEV && (() => { try { return localStorage.getItem("tm.fxbase"); } catch (_) { return null; } })()) || "https://gerisann.github.io/fap/data/fixtures/";
const MATCH_MS = 2.5 * 3600 * 1000; // a match is over ~2.5 h after kick-off (extra time included)
const DONE = new Set(["FT", "AET", "PEN", "CANC", "ABD", "AWD", "WO", "PST"]);

// our team name (teams.js) -> API-Football spellings, where normalising alone is not enough
const ALIASES = {
  "Magyarország": ["Hungary"],
  "Ferencváros": ["Ferencvarosi TC"], "Újpest": ["Ujpest"], "Puskás Akadémia": ["Puskas Academy"],
  "Debreceni VSC": ["Debrecen"], "Videoton / MOL Fehérvár": ["Fehervar", "MOL Fehervar", "Videoton"],
  "Honvéd": ["Budapest Honved", "Honved"], "Diósgyőr": ["Diosgyori VTK", "Diosgyor"], "Paksi FC": ["Paks"],
  "ETO Győr": ["Gyori ETO", "Gyor"], "ZTE": ["Zalaegerszeg"], "MTK Budapest": ["MTK"],
  "Bayern München": ["Bayern Munich"], "Tottenham Hotspur": ["Tottenham"], "Newcastle United": ["Newcastle"],
  "Wolverhampton Wanderers": ["Wolves"], "Brighton & Hove Albion": ["Brighton"], "West Ham United": ["West Ham"],
  "Internazionale": ["Inter"], "Inter": ["Inter"], "Atlético Madrid": ["Atletico Madrid"], "Athletic Bilbao": ["Athletic Club"],
  "Bayer Leverkusen": ["Bayer Leverkusen"], "Borussia Mönchengladbach": ["Borussia Monchengladbach"],
  "Olympique de Marseille": ["Marseille"], "Olympique Lyonnais": ["Lyon"], "Sporting CP": ["Sporting CP"],
  "Inter Miami": ["Inter Miami"], "LA Galaxy": ["Los Angeles Galaxy"], "Al Nassr": ["Al-Nassr"], "Al Hilal": ["Al-Hilal Saudi FC"],
  "Kashima Antlers": ["Kashima"], "Shanghai Port": ["Shanghai SIPG"],
};
// club-form words that one side writes and the other drops (checked on 931 real API names, 2026-11-03/04)
const NOISE = new Set(["fc", "cf", "ac", "afc", "sc", "cd", "sd", "ud", "rc", "rcd", "fk", "sk", "tc", "sv", "vfb", "vfl", "kv", "club", "de", "the", "as", "ss", "ssc", "calcio", "futbol", "football", "1"]);

export function norm(name) {
  return String(name).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").split(" ").filter(w => w && !NOISE.has(w)).join(" ");
}
const keysFor = team => new Set([team, ...(ALIASES[team] || [])].map(norm));
export const isTeam = (team, apiName) => keysFor(team).has(norm(apiName));

/* ---------- loading ---------- */
const cache = new Map(); // UTC date -> Promise<tuples[]>
const utcDate = ms => new Date(ms).toISOString().slice(0, 10);
function loadDay(date) {
  if (!cache.has(date)) cache.set(date, fetch(BASE + date + ".json", { cache: "no-cache" }).then(r => r.ok ? r.json() : { fixtures: [] }).then(j => j.fixtures || []).catch(() => []));
  return cache.get(date);
}
const toFixture = x => ({ id: x[0], kickoff: x[1] * 1000, status: x[2], league: x[4], country: x[5], home: x[7], away: x[9] });

/* Today's (local day) fixtures of a team that are not over yet. Local "today" can span two UTC files. */
export async function todaysMatches(team, now = Date.now()) {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const dates = [...new Set([utcDate(start.getTime()), utcDate(end.getTime() - 1)])];
  const all = (await Promise.all(dates.map(loadDay))).flat().map(toFixture);
  const seen = new Set();
  return all.filter(f => f.kickoff >= start.getTime() && f.kickoff < end.getTime() && !seen.has(f.id) && seen.add(f.id))
    .filter(f => isTeam(team, f.home) || isTeam(team, f.away))
    .map(f => ({ ...f, side: isTeam(team, f.home) ? "h" : "a", over: DONE.has(f.status) || now > f.kickoff + MATCH_MS }))
    .sort((a, b) => a.kickoff - b.kickoff);
}
// "cheering is open all day long until the match is over"
export const cheerOpen = f => !!f && !f.over;
