import { CITIES, GLOBAL } from "./cities.js";
import { TEAMS } from "./teams.js";
import { API_TEAMS } from "./teams-api.js";

// home of a team that has no demo city of its own: clubs by country code (when cities.js has no city there),
// national teams by name
const CAPITAL = {
  NOR: [59.913, 10.752], SVK: [48.148, 17.107], SVN: [46.056, 14.506], BUL: [42.698, 23.322], RUS: [55.756, 37.617],
  ISR: [32.085, 34.782], CYP: [35.185, 33.382], FIN: [60.17, 24.938], IRL: [53.35, -6.26], WAL: [51.481, -3.179],
  PER: [-12.046, -77.043], ECU: [-2.17, -79.922], PAR: [-25.264, -57.576], KOR: [37.566, 126.978], NEW: [-41.287, 174.776],
  England: [51.507, -0.128], Germany: [52.52, 13.405], Spain: [40.417, -3.704], Italy: [41.903, 12.496], Portugal: [38.722, -9.139],
  Netherlands: [52.368, 4.904], Croatia: [45.815, 15.982], Morocco: [34.02, -6.841], Belgium: [50.85, 4.352], Serbia: [44.787, 20.457],
  Switzerland: [46.948, 7.447], Denmark: [55.676, 12.568], Poland: [52.23, 21.012], Czechia: [50.075, 14.437], Ukraine: [50.45, 30.523],
  Slovakia: [48.148, 17.107], Romania: [44.426, 26.102], Austria: [48.208, 16.373], "Türkiye": [39.933, 32.86], Albania: [41.327, 19.819],
  Slovenia: [46.056, 14.506], Georgia: [41.715, 44.827], Scotland: [55.864, -4.252], Uruguay: [-34.901, -56.164], Colombia: [4.711, -74.072],
  Panama: [8.983, -79.517], "Costa Rica": [9.928, -84.09], Peru: [-12.046, -77.043], Venezuela: [10.48, -66.903], Paraguay: [-25.264, -57.576],
  Bolivia: [-16.49, -68.119], Ecuador: [-0.18, -78.468], Chile: [-33.448, -70.669], Jamaica: [17.971, -76.793], Canada: [43.653, -79.383],
};

/* privacy: blur before anything is stored */
export function blur(lat, lng, prec, rnd = Math.random) {
  if (prec === "exact") return [lat, lng];
  if (prec === "city") { const g = 0.05, gx = g / Math.cos(lat * Math.PI / 180); return [Math.round(lat / g) * g, Math.round(lng / gx) * gx]; }
  const r = (250 + rnd() * 350) / 111320, a = rnd() * Math.PI * 2;
  return [lat + r * Math.sin(a), lng + r * Math.cos(a) / Math.cos(lat * Math.PI / 180)];
}

/* demo data (seeded, clearly labelled) */
function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// every team gets demo fans: the ones without a city of their own (most of the API-Football list) get a home city
// in their country, and 2–8 fans by how big that country is in the demo (sqrt of its cities' weight)
function longTail(rnd) {
  const code = new Map(TEAMS.map(([n, c]) => [n, c]));
  const covered = new Set([...CITIES.flatMap(c => c[5].map(x => x[0])), ...GLOBAL.map(x => x[0])]);
  const homes = new Map(); // country code -> [[city, weight]]
  for (const c of CITIES) {
    const k = c[5].map(x => code.get(x[0])).find(x => x && x !== "NAT");
    if (k) homes.set(k, [...(homes.get(k) || []), [c, c[3]]]);
  }
  const weight = k => (homes.get(k) || []).reduce((s, x) => s + x[1], 0) || 2;
  const wMax = Math.max(...[...homes.keys()].map(weight));
  const teams = [...TEAMS.map(([n, c]) => [n, c]), ...API_TEAMS.map(([n, c]) => [n, c])].filter(([n]) => !covered.has(n));
  return teams.map(([name, k]) => {
    let lat, lng, spread;
    const cities = k === "NAT" ? null : homes.get(k);
    if (cities) {
      let r = rnd() * weight(k), i = 0; while (r > cities[i][1] && i < cities.length - 1) { r -= cities[i][1]; i++; }
      [, lat, lng, , spread] = cities[i][0];
    } else {
      const at = CAPITAL[k === "NAT" ? name : k]; if (!at) return null;
      [lat, lng] = at; spread = k === "NAT" ? 0.3 : 0.08;
    }
    const fans = k === "NAT" ? 10 : 2 + Math.round(6 * Math.sqrt(weight(k) / wMax));
    return { name, lat, lng, spread, fans };
  }).filter(Boolean);
}

export function makeDemo(n) {
  const rnd = mulberry(20261102), out = [];
  const tw = CITIES.reduce((s, c) => s + c[3], 0);
  const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const place = (t, lat0, lng0, s) => {
    const lat = lat0 + gauss() * s * 0.7, lng = lng0 + gauss() * s / Math.cos(lat0 * Math.PI / 180);
    const pr = rnd(), prec = pr < .5 ? "area" : pr < .8 ? "exact" : "city";
    const [bl, bg] = blur(lat, lng, prec, rnd);
    out.push({ t, lat: bl, lng: bg, p: prec, demo: true });
  };
  for (const tm of longTail(rnd)) for (let i = 0; i < tm.fans; i++) place(tm.name, tm.lat, tm.lng, tm.spread * (0.35 + rnd() * 0.9));
  n = Math.max(0, n - out.length); // the total stays n
  const gs = GLOBAL.reduce((s, x) => s + x[1], 0);
  const pools = CITIES.map(c => {
    const loc = c[5], ls = loc.reduce((s, x) => s + x[1], 0), rest = Math.max(.08, 1 - ls);
    const items = [...loc.map(x => [x[0], x[1]]), ...GLOBAL.map(x => [x[0], x[1] / gs * rest])];
    return { items, tot: items.reduce((s, x) => s + x[1], 0) };
  });
  for (let i = 0; i < n; i++) {
    let r = rnd() * tw, ci = 0; while (r > CITIES[ci][3]) { r -= CITIES[ci][3]; ci++; }
    const c = CITIES[ci], pool = pools[ci];
    let q = rnd() * pool.tot, ti = 0; while (q > pool.items[ti][1] && ti < pool.items.length - 1) { q -= pool.items[ti][1]; ti++; }
    place(pool.items[ti][0], c[1], c[2], c[4] * (0.35 + rnd() * 0.9));
  }
  return out;
}
