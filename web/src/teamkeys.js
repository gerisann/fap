/* Team-name matching between our names (teams.js, typed pins) and API-Football spellings.
   Pure module: used by the app (fixtures.js) and by scripts/fetch-teams.mjs in Node. */

// our team name (teams.js) -> API-Football spellings, where normalising alone is not enough
export const ALIASES = {
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
  // from the first teams.yml run (2026-11-03)
  "Leeds United": ["Leeds"], "LOSC Lille": ["Lille"], "PSV": ["PSV Eindhoven"], "Olympiacos": ["Olympiakos Piraeus"],
  "Rapid Wien": ["Rapid Vienna"], "Hajduk Split": ["HNK Hajduk Split"], "Steaua București": ["FCSB"],
  "Young Boys": ["BSC Young Boys"], "Basel": ["FC Basel 1893"], "ZTE": ["Zalaegerszeg", "Zalaegerszegi TE"],
  "Chivas Guadalajara": ["Guadalajara Chivas"], "LAFC": ["Los Angeles FC"], "Wydad Casablanca": ["Wydad AC"],
  "Esperance": ["ES Tunis"], "Urawa Red Diamonds": ["Urawa"], "Mohun Bagan": ["ATK Mohun Bagan"],
};
// club-form words that one side writes and the other drops (checked on 931 real API names, 2026-11-03/04)
const NOISE = new Set(["fc", "cf", "ac", "afc", "sc", "cd", "sd", "ud", "rc", "rcd", "fk", "sk", "tc", "sv", "vfb", "vfl", "kv", "club", "de", "the", "as", "ss", "ssc", "calcio", "futbol", "football", "1"]);

export function norm(name) {
  return String(name).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").split(" ").filter(w => w && !NOISE.has(w)).join(" ");
}
const keysFor = team => new Set([team, ...(ALIASES[team] || [])].map(norm));
export const nameMatch = (team, apiName) => keysFor(team).has(norm(apiName));
