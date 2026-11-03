import { CITIES, GLOBAL } from "./cities.js";

/* privacy: blur before anything is stored */
export function blur(lat, lng, prec, rnd = Math.random) {
  if (prec === "exact") return [lat, lng];
  if (prec === "city") { const g = 0.05, gx = g / Math.cos(lat * Math.PI / 180); return [Math.round(lat / g) * g, Math.round(lng / gx) * gx]; }
  const r = (250 + rnd() * 350) / 111320, a = rnd() * Math.PI * 2;
  return [lat + r * Math.sin(a), lng + r * Math.cos(a) / Math.cos(lat * Math.PI / 180)];
}

/* demo data (seeded, clearly labelled) */
function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

export function makeDemo(n) {
  const rnd = mulberry(20261102), out = [];
  const tw = CITIES.reduce((s, c) => s + c[3], 0);
  const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
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
    const s = c[4] * (0.35 + rnd() * 0.9);
    const lat = c[1] + gauss() * s * 0.7, lng = c[2] + gauss() * s / Math.cos(c[1] * Math.PI / 180);
    const pr = rnd(), prec = pr < .5 ? "area" : pr < .8 ? "exact" : "city";
    const [bl, bg] = blur(lat, lng, prec, rnd);
    out.push({ t: pool.items[ti][0], lat: bl, lng: bg, p: prec, demo: true });
  }
  return out;
}
