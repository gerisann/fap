import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "./style.css";
import { TEAMS as CURATED } from "./data/teams.js";
import { API_TEAMS } from "./data/teams-api.js";
import { blur, makeDemo } from "./data/demo.js";
import { loadStyle } from "./basemap.js";
import { searchCities, searchAddress, searchAreas, searchDistricts } from "./geocode.js";
import { placeGeometry, circle, distKm, bbox, contains } from "./area.js";
import { initTribes, validUsername, usernameProblem } from "./tribes.js";
import { isProfane } from "./profanity.js";
import { todaysMatches, cheerOpen } from "./fixtures.js";
import { ALIASES } from "./teamkeys.js";
import { asyncCombo } from "./combo.js";
import { runTour } from "./tour.js";
import { holdToCheer } from "./cheerhold.js";
import { t, num, lang, locale, applyDom, setLang, onLangChange } from "./i18n.js";
import { track, initAnalytics, consent, setConsent } from "./analytics.js";

const $ = s => document.querySelector(s);
// older iOS Safari pinch-zooms the page through gesture events; the map pinches by itself
document.addEventListener("gesturestart", e => { if (!e.target.closest?.("#map")) e.preventDefault(); }, { passive: false });
maplibregl.setWorkerUrl(workerUrl); // v6 + bundler: the worker URL must be given explicitly
applyDom();

/* ---------- teams ---------- */
// curated teams (crest colours) first, then the API-Football list (scripts/fetch-teams.mjs, hashed colours)
const TEAMS = [...CURATED, ...API_TEAMS.map(([n, c]) => [n, c, null])];
const fold = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const TEAM_F = TEAMS.map(([n]) => fold(n));
const teamMeta = new Map(TEAMS.map(([n, c, col]) => [n.toLowerCase(), { name: n, country: c, color: col }]));
const teamByFold = new Map(TEAMS.map(([n], i) => [TEAM_F[i], n]).reverse()); // first spelling wins
// API-Football spellings work as search aliases too (Bayern Munich, Wolves, FCSB ...)
const ALIAS_OF = new Map(TEAMS.map(([n], i) => [n, (ALIASES[n] || []).map(fold).filter(a => a !== TEAM_F[i])]));
const aliasByFold = new Map(); for (const [n, as] of ALIAS_OF) for (const a of as) if (!aliasByFold.has(a)) aliasByFold.set(a, n);
const aliasHit = (n, qf) => ALIAS_OF.get(n)?.some(a => a.includes(qf));
const aliases = { "fradi": "Ferencváros", "ftc": "Ferencváros", "barca": "FC Barcelona", "barça": "FC Barcelona", "bayern": "Bayern München", "man utd": "Manchester United", "psg": "Paris Saint-Germain", "bvb": "Borussia Dortmund", "spurs": "Tottenham Hotspur", "juve": "Juventus", "dvsc": "Debreceni VSC", "dvtk": "Diósgyőr", "fehérvár": "Videoton / MOL Fehérvár" };
function hashColor(s) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 70% 58%)`; }
function canonical(name) { const k = name.trim().toLowerCase(); const m = teamMeta.get(k) || teamMeta.get((aliases[k] || "").toLowerCase()) || teamMeta.get((teamByFold.get(fold(k)) || "").toLowerCase()) || teamMeta.get((aliasByFold.get(fold(k)) || "").toLowerCase()); return m ? m.name : name.trim().replace(/\s+/g, " ").slice(0, 40); }
function colorOf(name) { const m = teamMeta.get(name.toLowerCase()); return m && m.color ? m.color : hashColor(name); }
const DEMO = makeDemo(24000, 100); // 24 000 home points ×100 fans: see makeDemo()

/* ---------- state ---------- */
const MAX_TEAMS = 5;
let view = "pins", selected = [], showDemo = true;
let area = null;                 // { level, name, geom, test(lng, lat) }; null = whole world
let tribes = null;               // tribe layer + sheet (tribes.js), set up after the board
let cheersFC = { type: "FeatureCollection", features: [] }; // match-day cheer dots (kept across style reloads)
let real = new Map();            // uid -> pin from the shared store
let user = null, myPin = null, backend = null, loginMethod = null, profile = null, stats = null, unsubStats = null;
const DRAFT = "tm.draft";        // blurred pin waiting for sign-in; never the raw location
try { localStorage.removeItem("tm.mypin"); } catch (_) {} // device-only pins from before sign-in existed
function points() { const arr = showDemo ? DEMO.slice() : []; for (const p of real.values()) arr.push(p); return arr; }
function scoped() { const pts = points(); return area ? pts.filter(p => area.test(p.lng, p.lat)) : pts; }

/* ---------- theme ---------- */
const PAL = {
  light: { paper: "#ffffff", ocean: "#e4e7ec", land: "#fbfbfc", accent: "#3355ff", space: "#eef0f3", horizon: "#dfe3ea", meta: "#ffffff" },
  dark: { paper: "#1b1d21", ocean: "#0e1013", land: "#1f2226", accent: "#6680ff", space: "#0b0c0e", horizon: "#16181c", meta: "#1b1d21" },
};
let theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
const P = () => PAL[theme];
// fire spectrum: deep red → orange → yellow → white-hot core
function heatRamp() { return ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(160,0,20,0)", .12, "rgba(170,10,25,.35)", .3, "rgba(215,35,30,.7)", .5, "#f2521b", .68, "#ff9a00", .84, "#ffd84a", 1, "#ffffff"]; }
const fallbackStyle = () => ({ version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": P().land } }], projection: { type: "globe" } });

/* ---------- map ---------- */
const map = new maplibregl.Map({
  container: "map",
  style: await loadStyle(theme, lang, P()).catch(() => fallbackStyle()),
  center: [14, 38], zoom: 1.7, minZoom: 1, maxZoom: 18, attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
const geo = new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: false }, showUserLocation: false });
map.addControl(geo, "bottom-right");
geo.on("geolocate", () => track("geolocate"));
map.dragRotate.disable(); map.touchZoomRotate.disableRotation();
if (import.meta.env.DEV) window.__map = map;

let topKeys = [], styleSeq = 0;
// read from the map, not kept in a flag: MapLibre itself swaps the style (worker restart after the tab comes back,
// WebGL context loss / restore), and our sources are gone until it has rebuilt it. "heat" is added last in setupLayers.
const ready = () => !!map.getSource("heat");
const OTHER = "var(--wash-2)";
async function reloadStyle() {
  const seq = ++styleSeq;
  const s = await loadStyle(theme, lang, P()).catch(() => null);
  if (!s || seq !== styleSeq) return;
  clearLabels(); map.setStyle(s, { diff: false });
}
function applyMapTheme() {
  const p = P();
  const set = (l, k, v) => { if (map.getLayer(l)) map.setPaintProperty(l, k, v); };
  for (const id of ["all", "sel"]) set(id + "-u", "circle-stroke-color", ["case", ["==", ["get", "d"], 0], p.accent, p.paper]);
  set("heatL", "heatmap-color", heatRamp());
  set("area-fill", "fill-color", p.accent); set("area-line", "line-color", p.accent);
}
function applyTheme(next) {
  theme = next; const d = document.documentElement; d.dataset.theme = next; d.classList.toggle("is-dark", next === "dark");
  document.querySelector('meta[name="theme-color"]').setAttribute("content", P().meta);
  try { localStorage.setItem("tm.theme", next); } catch (_) {}
  reloadStyle();
}

/* two clustered sources, both drawn as team-share donuts: "all" (top 40 teams) and "sel" (the ≤5 picked teams).
   Everything is scoped to the chosen area first. */
// m: 1 for my own pin, which is drawn as a separate map pin instead of a dot
// w: how many fans a point stands for (1; the scaled demo's world points stand for 99). Every count sums w.
function fc(arr) { return { type: "FeatureCollection", features: arr.map(p => ({ type: "Feature", properties: { t: p.t, c: colorOf(p.t), p: p.p, d: p.demo ? 1 : 0, m: p === myPin ? 1 : 0, w: p.w || 1 }, geometry: { type: "Point", coordinates: [p.lng, p.lat] } })) }; }
function keyProps(keys) { const props = { n: ["+", ["get", "w"]] }; keys.forEach((tm, i) => { props["k" + i] = ["+", ["case", ["==", ["get", "t"], tm], ["get", "w"], 0]]; }); return props; }
function addClusterSource(id, data, keys) {
  if (map.getLayer(id + "-c")) map.removeLayer(id + "-c");
  if (map.getLayer(id + "-u")) map.removeLayer(id + "-u");
  if (map.getSource(id)) map.removeSource(id);
  map.addSource(id, { type: "geojson", data, cluster: true, clusterRadius: 48, clusterMaxZoom: 15, clusterProperties: keyProps(keys) });
  map.addLayer({ id: id + "-c", type: "circle", source: id, filter: ["has", "point_count"], paint: {
    "circle-color": "rgba(0,0,0,0)", "circle-radius": ["+", 11, ["*", 2.6, ["log10", ["max", 1, ["get", "n"]]]]] } }); // = radiusFor() + 3
  map.addLayer({ id: id + "-u", type: "circle", source: id, filter: ["all", ["!", ["has", "point_count"]], ["!=", ["get", "m"], 1]], paint: {
    "circle-color": ["get", "c"], "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 3.5, 14, 7],
    "circle-stroke-color": ["case", ["==", ["get", "d"], 0], P().accent, P().paper], "circle-stroke-width": ["case", ["==", ["get", "d"], 0], 2.5, 1.2] } });
}
function rebuild() {
  if (!ready()) return;
  const pts = scoped();
  let total = 0; const groups = new Map(); for (const p of pts) { const w = p.w || 1; total += w; groups.set(p.t, (groups.get(p.t) || 0) + w); }
  const data = fc(pts);
  map.getSource("heat").setData(data);
  const top = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(x => x[0]);
  if (top.join("|") !== topKeys.join("|") || !map.getSource("all")) { topKeys = top; addClusterSource("all", data, top); }
  else map.getSource("all").setData(data);
  updateSel(pts);
  applyVisibility(); renderStats(groups, total); scheduleLabels();
}
function updateSel(pts) {
  const set = new Set(selected);
  addClusterSource("sel", fc((pts || scoped()).filter(p => set.has(p.t))), selected);
}
function applyVisibility() {
  if (!ready()) return;
  const all = view === "pins" && !selected.length, sel = view === "pins" && !!selected.length;
  for (const [id, on] of [["all", all], ["sel", sel]]) for (const L of ["-c", "-u"]) if (map.getLayer(id + L)) map.setLayoutProperty(id + L, "visibility", on ? "visible" : "none");
  map.setLayoutProperty("heatL", "visibility", view === "heat" ? "visible" : "none");
  map.setFilter("heatL", selected.length ? ["in", ["get", "t"], ["literal", selected]] : null);
  clearLabels(); scheduleLabels();
  tribes?.render();
}
function onClick(e, src) {
  if (picking || areaMode === "radius") return;
  const f = e.features[0];
  if (f.properties.point_count) { zoomCluster(src, f.properties.cluster_id, f.geometry.coordinates, f.properties.point_count); return; }
  const tm = f.properties.t;
  const pl = t({ exact: "popExact", area: "popArea", city: "popCity" }[f.properties.p] || "popArea");
  const el = document.createElement("div");
  const a = document.createElement("div"); a.className = "pop-t"; const d = document.createElement("span"); d.className = "dot"; d.style.background = colorOf(tm); a.append(d, document.createTextNode(t("fanOf", { team: tm })));
  const b = document.createElement("div"); b.className = "pop-s"; b.textContent = pl + " · " + t(f.properties.d ? "demoTag" : "realTag");
  el.append(a, b);
  new maplibregl.Popup({ offset: 10, closeButton: false }).setLngLat(f.geometry.coordinates).setDOMContent(el).addTo(map);
  track("pin_open", { team: tm, demo: !!f.properties.d });
}
async function zoomCluster(src, id, center, n) {
  track("cluster_click", { size: n < 50 ? "s" : n < 1000 ? "m" : "l", zoom: Math.round(map.getZoom()) });
  try { const z = await map.getSource(src).getClusterExpansionZoom(id); map.easeTo({ center, zoom: Math.min(z + 0.2, 18) }); } catch (_) {}
}
for (const src of ["all", "sel"]) for (const L of ["-c", "-u"]) {
  map.on("click", src + L, e => onClick(e, src));
  map.on("mouseenter", src + L, () => { if (!picking) map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", src + L, () => { if (!picking) map.getCanvas().style.cursor = ""; });
}

/* cluster markers drawn as HTML team-share donuts */
let labels = new Map(), labelTimer = 0;
function scheduleLabels() { if (labelTimer) return; labelTimer = setTimeout(() => { labelTimer = 0; updateLabels(); }, 60); }
function clearLabels() { for (const m of labels.values()) m.remove(); labels = new Map(); }
function fmt(n) { return n >= 1e6 ? (n / 1e6).toFixed(1).replace(".0", "") + "M" : n >= 10000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1).replace(".0", "") + "k" : String(n); }
// log scale: 10 fans → 11 px, 1k → 16, 10k → 18, 1M → 24; the weighted demo made a step scale max out everywhere
function radiusFor(n) { return Math.round(8 + 2.6 * Math.log10(Math.max(1, n))); }
function donut(props, keys) {
  const n = props.n ?? props.point_count, r = radiusFor(n) + 3, w = Math.max(3, r * .17), R = r - w / 2, C = 2 * Math.PI * R;
  const parts = keys.map((tm, i) => [colorOf(tm), props["k" + i] || 0]);
  const known = parts.reduce((s, x) => s + x[1], 0); parts.push([OTHER, Math.max(0, n - known)]);
  let off = 0, segs = "";
  for (const [col, v] of parts) { if (!v) continue; const len = v / n * C; segs += `<circle r="${R}" cx="${r}" cy="${r}" fill="none" style="stroke:${col}" stroke-width="${w}" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 ${r} ${r})"/>`; off += len; }
  const el = document.createElement("div"); el.className = "donut"; el.style.width = el.style.height = (2 * r) + "px";
  el.innerHTML = `<svg width="${2 * r}" height="${2 * r}" viewBox="0 0 ${2 * r} ${2 * r}" aria-hidden="true"><circle r="${r - .5}" cx="${r}" cy="${r}" style="fill:var(--paper)" fill-opacity=".55"/>${segs}</svg><b style="font-size:${r < 17 ? 10 : r < 21 ? 11 : 12}px">${fmt(n)}</b>`;
  const lead = parts.slice(0, -1).sort((a, b) => b[1] - a[1])[0];
  el.title = t("clusterTitle", { n: num(n) }) + (lead && lead[1] ? " · " + t("mostFans", { team: keys[parts.indexOf(lead)] }) : "");
  return el;
}
function updateLabels() {
  if (!ready()) return;
  const next = new Map();
  const src = view !== "pins" ? null : selected.length ? "sel" : "all";
  if (src) {
    const keys = src === "all" ? topKeys : selected;
    let feats = []; try { feats = map.querySourceFeatures(src, { filter: ["has", "point_count"] }); } catch (_) {}
    for (const f of feats) {
      const key = src + ":" + f.properties.cluster_id; if (next.has(key)) continue;
      let m = labels.get(key);
      if (!m) {
        const el = donut(f.properties, keys);
        el.addEventListener("click", ev => {
          ev.stopPropagation(); if (picking) return;
          if (areaMode === "radius") setRadiusCenter(f.geometry.coordinates);
          else zoomCluster(src, f.properties.cluster_id, f.geometry.coordinates, f.properties.point_count);
        });
        m = new maplibregl.Marker({ element: el, opacityWhenCovered: "0" }).setLngLat(f.geometry.coordinates).addTo(map);
      }
      next.set(key, m);
    }
  }
  for (const [k, m] of labels) if (!next.has(k)) m.remove();
  labels = next;
}
map.on("moveend", scheduleLabels);
map.on("idle", scheduleLabels);
map.on("sourcedata", e => { if (e.isSourceLoaded && (e.sourceId === "all" || e.sourceId === "sel")) scheduleLabels(); });
map.on("zoomend", () => { clearLabels(); scheduleLabels(); });

let lastMoveTrack = 0;
map.on("moveend", e => {
  if (!e.originalEvent || Date.now() - lastMoveTrack < 3000) return;
  lastMoveTrack = Date.now(); track("map_move", { zoom: Math.round(map.getZoom()), view });
});

function areaFC() { return { type: "FeatureCollection", features: area ? [{ type: "Feature", properties: {}, geometry: area.geom }] : [] }; }
function setupLayers() {
  // rebuilt by MapLibre from a snapshot: our sources are back with their old data, catch up on what changed meanwhile
  if (ready()) { map.getSource("area").setData(areaFC()); map.getSource("cheers").setData(cheersFC); rebuild(); return; }
  map.addSource("area", { type: "geojson", data: areaFC() });
  map.addLayer({ id: "area-fill", type: "fill", source: "area", paint: { "fill-color": P().accent, "fill-opacity": .06 } });
  map.addLayer({ id: "area-line", type: "line", source: "area", paint: { "line-color": P().accent, "line-width": 1.6, "line-opacity": .8 } });
  // match-day cheers: a soft glow + a dot per cheering fan, in their side's colour
  map.addSource("cheers", { type: "geojson", data: cheersFC });
  map.addLayer({ id: "cheers-glow", type: "circle", source: "cheers", paint: { "circle-color": ["get", "c"], "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 6, 8, 18], "circle-blur": 1, "circle-opacity": .45 } });
  map.addLayer({ id: "cheers-dot", type: "circle", source: "cheers", paint: { "circle-color": ["get", "c"], "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 2.5, 8, 5], "circle-stroke-color": "#fff", "circle-stroke-width": 1 } });
  map.addSource("heat", { type: "geojson", data: fc([]) });
  map.addLayer({ id: "heatL", type: "heatmap", source: "heat", layout: { visibility: "none" }, paint: {
    // density only, not w: the demo's weighted world points would burn the map; halved for its 2× points
    "heatmap-weight": ["interpolate", ["linear"], ["zoom"], 1, .005, 5, .02, 9, .1, 13, .5],
    "heatmap-intensity": 1,
    "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 1, 10, 5, 22, 10, 30, 14, 36],
    "heatmap-opacity": .85,
    "heatmap-color": heatRamp() } });
  topKeys = []; rebuild(); applyMapTheme();
}
map.on("style.load", setupLayers);
if (map.isStyleLoaded()) setupLayers();
$("#themeBtn").onclick = () => { applyTheme(theme === "dark" ? "light" : "dark"); track("theme_change", { theme }); };

/* ---------- board: stats, team list (top 10 / all / search), up to 5 picked teams ---------- */
let lastGroups = null, lastTotal = 0, showAll = false, teamQuery = "", hintTimer = 0;
function renderStats(groups, total) {
  lastGroups = groups; lastTotal = total;
  $("#sFans").textContent = num(total);
  $("#sTeams").textContent = num(groups.size);
  const all = [...groups.entries()].sort((a, b) => b[1] - a[1]);
  const q = teamQuery.trim().toLowerCase(), al = aliases[q], qf = fold(q);
  const rows = q ? all.filter(([tm]) => fold(tm).includes(qf) || (al && tm === al) || aliasHit(tm, qf)).slice(0, 40) : showAll ? all : all.slice(0, 10);
  const ul = $("#teamList"); ul.replaceChildren();
  for (const [tm, n] of rows) {
    const li = document.createElement("li"), b = document.createElement("button"); b.setAttribute("aria-pressed", String(selected.includes(tm)));
    const d = document.createElement("span"); d.className = "dot"; d.style.background = colorOf(tm);
    const nm = document.createElement("span"); nm.textContent = tm; const c = document.createElement("span"); c.className = "n"; c.textContent = num(n);
    b.append(d, nm, c); b.onclick = () => toggleTeam(tm, q ? "search" : "list"); li.append(b); ul.append(li);
  }
  if (q && !rows.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = t("noTeams"); ul.append(li); }
  const more = $("#moreTeams");
  more.hidden = !!q || all.length <= 10;
  more.textContent = showAll ? t("fewerTeams") : t("allTeams", { n: num(all.length) });
  renderFilter();
}
function renderFilter() {
  const box = $("#filterBox"); box.replaceChildren();
  for (const tm of selected) {
    const chip = document.createElement("div"); chip.className = "filter-chip"; const d = document.createElement("span"); d.className = "dot"; d.style.background = colorOf(tm);
    const n = document.createElement("span"); n.textContent = tm; const x = document.createElement("button"); x.textContent = "✕"; x.setAttribute("aria-label", t("clearFilter") + ": " + tm); x.onclick = () => toggleTeam(tm, "chip");
    chip.append(d, n, x); box.append(chip);
  }
  if (selected.length > 1) { const c = document.createElement("button"); c.className = "chip-clear"; c.textContent = t("clearAll"); c.onclick = () => setSelected([], "clear"); box.append(c); }
}
function flashHint(msg) { const h = $("#teamHint"); h.textContent = msg; h.hidden = false; clearTimeout(hintTimer); hintTimer = setTimeout(() => { h.hidden = true; }, 2600); }
function setSelected(list, source) {
  selected = list;
  if (ready()) { updateSel(); applyVisibility(); }
  if (lastGroups) renderStats(lastGroups, lastTotal);
  track("team_filter", { teams: selected.join("|") || "(none)", count: selected.length, source });
}
function toggleTeam(tm, source) {
  if (selected.includes(tm)) return setSelected(selected.filter(x => x !== tm), source);
  if (selected.length >= MAX_TEAMS) { flashHint(t("maxTeams", { n: MAX_TEAMS })); track("team_filter_limit"); return; }
  setSelected([...selected, tm], source);
}
$("#moreTeams").onclick = () => { showAll = !showAll; if (lastGroups) renderStats(lastGroups, lastTotal); track("team_list_more", { on: showAll }); };
let searchTrackTimer = 0;
$("#teamSearch").addEventListener("input", e => {
  teamQuery = e.target.value; if (lastGroups) renderStats(lastGroups, lastTotal);
  clearTimeout(searchTrackTimer); searchTrackTimer = setTimeout(() => { if (teamQuery) track("team_search", { query_len: teamQuery.length }); }, 1200);
});

/* ---------- area scope: world / country / city (OSM outline) / radius around a dropped point ---------- */
let areaMode = "world", radiusKm = 25, radiusCenter = null, radiusMarker = null, areaCtrl = null, radiusTimer = 0;
function setArea(next) { area = next; if (ready()) { map.getSource("area")?.setData(areaFC()); rebuild(); } }
function setAreaMode(m) {
  areaMode = m;
  for (const b of document.querySelectorAll("#areaSeg button")) b.setAttribute("aria-pressed", String(b.dataset.area === m));
  $("#areaSearchBox").hidden = !(m === "country" || m === "city"); $("#radiusBox").hidden = m !== "radius";
  const inp = $("#areaInput"); inp.dataset.i18nAttr = "placeholder:" + (m === "country" ? "searchCountry" : "searchCity"); inp.placeholder = t(m === "country" ? "searchCountry" : "searchCity");
  areaCombo.clear(); areaCtrl?.abort();
  if (m !== "radius" && radiusMarker) { radiusMarker.remove(); radiusMarker = null; radiusCenter = null; $("#radiusHint").hidden = false; }
  map.getCanvas().style.cursor = m === "radius" ? "crosshair" : "";
  if (m === "radius" && radiusCenter) applyRadius(); else setArea(null);
  if (m === "country" || m === "city") inp.focus();
  track("area_filter", { level: m });
}
for (const b of document.querySelectorAll("#areaSeg button")) b.onclick = () => setAreaMode(b.dataset.area);
const areaCombo = asyncCombo($("#areaInput"), $("#areaOpts"), {
  search: (q, signal) => searchAreas(q, areaMode, lang, signal),
  onPick: async pl => {
    areaCtrl?.abort(); areaCtrl = new AbortController(); const level = areaMode;
    try {
      const g = await placeGeometry(pl, level, areaCtrl.signal);
      setArea({ level, name: pl.name, geom: g, test: contains(g) });
      const [x0, y0, x1, y1] = bbox(g); map.fitBounds([[x0, y0], [x1, y1]], { padding: 60, maxZoom: 12, duration: 900 });
      track("area_filter", { level, source: "search" });
    } catch (e) { if (e.name !== "AbortError") track("area_error", { level }); }
  },
});
function applyRadius() {
  const [lng, lat] = radiusCenter;
  setArea({ level: "radius", name: radiusKm + " km", geom: circle(lng, lat, radiusKm), test: (x, y) => distKm(lat, lng, y, x) <= radiusKm });
}
function setRadiusCenter([lng, lat]) {
  radiusCenter = [lng, lat]; $("#radiusHint").hidden = true;
  if (!radiusMarker) {
    const el = document.createElement("div"); el.className = "rc";
    radiusMarker = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(radiusCenter).addTo(map);
    radiusMarker.on("dragend", () => { const p = radiusMarker.getLngLat(); radiusCenter = [p.lng, p.lat]; applyRadius(); });
  } else radiusMarker.setLngLat(radiusCenter);
  applyRadius(); track("area_filter", { level: "radius", radius_km: radiusKm });
}
map.on("click", e => { if (!picking && areaMode === "radius") setRadiusCenter([e.lngLat.lng, e.lngLat.lat]); });
$("#radiusRange").addEventListener("input", e => {
  radiusKm = +e.target.value; $("#radiusVal").textContent = radiusKm + " km";
  clearTimeout(radiusTimer); if (radiusCenter) radiusTimer = setTimeout(applyRadius, 120);
});
$("#radiusRange").addEventListener("change", () => track("area_filter", { level: "radius", radius_km: radiusKm }));

/* ---------- top panel on phones: collapsed by default, tap the grip or swipe up / down ---------- */
const board = $(".board"), grab = $("#boardGrab"), phone = matchMedia("(max-width:720px)");
// on phones the board and the account sheet never stay open together: opening one closes the other
function setBoard(open, persist) {
  if (open && phone.matches) closeAccount();
  board.classList.toggle("collapsed", !open); grab.setAttribute("aria-expanded", String(open));
  if (persist) { try { localStorage.setItem("tm.board", open ? "1" : "0"); } catch (_) {} track("panel_toggle", { on: open }); }
}
setBoard(!phone.matches || (() => { try { return localStorage.getItem("tm.board") === "1"; } catch (_) { return false; } })(), false);
grab.onclick = () => setBoard(board.classList.contains("collapsed"), true);
$("#boardClose").onclick = () => setBoard(false, true);
let swipeY = null;
board.addEventListener("touchstart", e => { swipeY = phone.matches && !e.target.closest(".board-body") || e.target.closest(".grab") ? e.touches[0].clientY : null; }, { passive: true });
board.addEventListener("touchend", e => {
  if (swipeY == null) return; const dy = e.changedTouches[0].clientY - swipeY; swipeY = null;
  if (dy < -28) setBoard(false, true); else if (dy > 28) setBoard(true, true);
}, { passive: true });
function setView(v) {
  view = v;
  for (const [id, k] of [["#vPins", "pins"], ["#vHeat", "heat"], ["#vTribes", "tribes"]]) $(id).setAttribute("aria-pressed", String(v === k));
  document.body.classList.toggle("view-tribes", v === "tribes"); updateCta();
  tribes?.setVisible(v === "tribes"); applyVisibility(); track("view_change", { view: v });
}
$("#vPins").onclick = () => setView("pins"); $("#vHeat").onclick = () => setView("heat"); $("#vTribes").onclick = () => setView("tribes");
$("#demoToggle").onchange = e => { showDemo = e.target.checked; rebuild(); track("demo_toggle", { on: showDemo }); };

const flags = document.querySelectorAll(".flag");
const paintFlags = () => { for (const b of flags) b.setAttribute("aria-pressed", String(b.dataset.lang === lang)); };
for (const b of flags) b.onclick = () => setLang(b.dataset.lang);
paintFlags();
onLangChange(l => { if (matchFx) { paintMatch(); paintCounts(lastCounts); } paintFlags(); renderAccount(); updateCta(); if (lastGroups) renderStats(lastGroups, lastTotal); tribes?.render(); reloadStyle(); track("lang_change", { lang: l }); });

/* ---------- sign-up sheet (new pin, or editing my pin) ---------- */
let chosenTeam = null, pickLL = null, picking = false, pendingMarker = null, myMarker = null;
let editing = false, keepLL = false; // keepLL: editing without moving → keep the stored (already blurred) point, no re-blur drift
const sheet = $("#sheet");
const PREC_KEY = { area: "precArea", city: "precCity", exact: "precExact" };
function relabel(el, key) { el.dataset.i18n = key; el.textContent = t(key); }
function openSheet(edit = false) {
  editing = edit && !!myPin; keepLL = false;
  relabel($("#sheetTitle"), editing ? "editPinTitle" : "sheetTitle");
  relabel($("#saveBtn"), editing ? "saveChanges" : "save");
  if (editing) {
    chosenTeam = myPin.t; ti.value = myPin.t; $("#st1").classList.add("done");
    pickLL = [myPin.lat, myPin.lng]; keepLL = true;
    const b = $("#pickedBox"); b.classList.add("on"); b.textContent = t("currentPlace"); $("#st2").classList.add("done");
    const r = document.querySelector(`input[name="prec"][value="${myPin.p}"]`); if (r) r.checked = true;
    relabel($("#precHint"), HINTS[myPin.p] || "hintArea");
    validate();
  }
  $("#myRow").hidden = !editing;
  if (tribes?.isOpen()) tribes.close(); // one sheet at a time: they sit on the same spot
  sheet.hidden = false; document.body.classList.add("sheet-open"); closeAccount();
}
function showMyPin() { if (!myPin) return; closeAccount(); map.flyTo({ center: [myPin.lng, myPin.lat], zoom: Math.max(map.getZoom(), 13), duration: 1200 }); track("my_pin_show"); }
// the bottom button: in the tribes view it founds a tribe, elsewhere it is "put me on the map" / "my pin"
function updateCta() { relabel($("#openSheet"), view === "tribes" ? "newTribe" : myPin ? "myPin" : "cta"); }
$("#openSheet").onclick = () => { if (view === "tribes") { tribes?.create(); return; } if (myPin) { showMyPin(); return; } openSheet(); $("#teamInput").focus(); track("pin_flow_start"); };
$("#closeSheet").onclick = () => { sheet.hidden = true; document.body.classList.toggle("sheet-open", !!tribes?.isOpen()); stopPick(); track("pin_flow_close", { team_chosen: !!chosenTeam, place_chosen: !!pickLL }); };
/* place: city search, then an optional street + number inside that city. Query text never goes to analytics. */
let pickedCity = null;
const addrBox = $("#addrBox");
asyncCombo($("#cityInput"), $("#cityOpts"), {
  search: (q, signal) => searchCities(q, lang, signal),
  onInput: () => { pickedCity = null; addrBox.hidden = true; addr.clear(); },
  onPick: c => { pickedCity = c; addrBox.hidden = false; setPick(c.lng, c.lat, "search", c.name); map.flyTo({ center: [c.lng, c.lat], zoom: 11 }); },
});
const addr = asyncCombo($("#addrInput"), $("#addrOpts"), {
  minLen: 3,
  search: (q, signal) => searchAddress(q, pickedCity, lang, signal),
  onPick: a => { setPick(a.lng, a.lat, "address", a.name + ", " + pickedCity.name); map.flyTo({ center: [a.lng, a.lat], zoom: 16 }); },
});

const ti = $("#teamInput"), opts = $("#teamOpts"); let optIdx = 0, optList = [];
function showOpts() {
  const q = ti.value.trim().toLowerCase();
  if (!q) { opts.hidden = true; ti.setAttribute("aria-expanded", "false"); return; }
  const qf = fold(q), al = aliases[q] || aliasByFold.get(qf);
  // alias, then name start, then word start, then anywhere; ties keep the curated-first order
  const rank = (n, f) => n === al ? 0 : f.startsWith(qf) ? 1 : f.includes(" " + qf) ? 2 : f.includes(qf) ? 3 : aliasHit(n, qf) ? 4 : 9;
  optList = TEAMS.map(([n], i) => [n, rank(n, TEAM_F[i])]).filter(x => x[1] < 9).sort((a, b) => a[1] - b[1]).slice(0, 8).map(x => x[0]);
  if (!optList.some(n => n.toLowerCase() === q)) optList.push({ custom: ti.value.trim().slice(0, 40) });
  optIdx = 0; opts.replaceChildren();
  optList.forEach((o, i) => {
    const li = document.createElement("li"); li.setAttribute("role", "option"); li.setAttribute("aria-selected", String(i === optIdx));
    const name = typeof o === "string" ? o : o.custom; const d = document.createElement("span"); d.className = "dot"; d.style.background = colorOf(name);
    const s = document.createElement("span"); s.textContent = typeof o === "string" ? o : t("newTeam", { name: o.custom });
    const sm = document.createElement("small"); const ctry = typeof o === "string" ? teamMeta.get(o.toLowerCase()).country : null;
    sm.textContent = ctry ? (ctry === "NAT" ? t("national") : ctry) : t("custom");
    li.append(d, s, sm); li.onmousedown = ev => { ev.preventDefault(); pickTeam(name); }; opts.append(li);
  });
  opts.hidden = false; ti.setAttribute("aria-expanded", "true");
}
function pickTeam(name) {
  chosenTeam = canonical(name); ti.value = chosenTeam; opts.hidden = true; ti.setAttribute("aria-expanded", "false"); $("#st1").classList.add("done"); validate();
  track("pin_team_pick", { team: chosenTeam, custom: !teamMeta.has(chosenTeam.toLowerCase()) });
}
ti.addEventListener("input", () => { chosenTeam = null; $("#st1").classList.remove("done"); showOpts(); validate(); });
ti.addEventListener("keydown", e => {
  if (opts.hidden) return; const items = [...opts.children];
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); optIdx = (optIdx + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; items.forEach((li, i) => li.setAttribute("aria-selected", String(i === optIdx))); }
  else if (e.key === "Enter") { e.preventDefault(); const o = optList[optIdx]; pickTeam(typeof o === "string" ? o : o.custom); }
  else if (e.key === "Escape") { opts.hidden = true; }
});
ti.addEventListener("blur", () => { setTimeout(() => { opts.hidden = true; }, 120); });

function setPick(lng, lat, method, label) {
  pickLL = [lat, lng]; keepLL = false;
  if (!pendingMarker) {
    const el = document.createElement("div"); el.className = "me pending"; pendingMarker = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([lng, lat]).addTo(map);
    pendingMarker.on("dragend", () => { const p = pendingMarker.getLngLat(); setPick(p.lng, p.lat, "drag"); });
  } else pendingMarker.setLngLat([lng, lat]);
  const b = $("#pickedBox"); b.classList.add("on"); b.textContent = (label ? label + " · " : "") + lat.toFixed(3) + ", " + lng.toFixed(3);
  $("#st2").classList.add("done"); validate();
  track("pin_place", { method });
}
function startPick() { picking = true; $("#pickHint").hidden = false; map.getCanvas().style.cursor = "crosshair"; if (innerWidth <= 720) sheet.hidden = true; }
function stopPick() { picking = false; $("#pickHint").hidden = true; map.getCanvas().style.cursor = ""; }
$("#pickBtn").onclick = startPick;
map.on("click", e => { if (!picking) return; setPick(e.lngLat.lng, e.lngLat.lat, "map"); stopPick(); sheet.hidden = false; });
const HINTS = { area: "hintArea", city: "hintCity", exact: "hintExact" };
document.querySelectorAll('input[name="prec"]').forEach(r => r.addEventListener("change", () => { const h = $("#precHint"); h.dataset.i18n = HINTS[r.value]; h.textContent = t(HINTS[r.value]); track("pin_precision", { precision: r.value }); }));
function validate() { $("#saveBtn").disabled = !(chosenTeam && pickLL); }
function setStatus(msg, err) { const s = $("#status"); s.textContent = msg; s.classList.toggle("err", !!err); }

function showMine(p) {
  if (myMarker) { myMarker.remove(); myMarker = null; }
  if (!p) return;
  // the marker element gets MapLibre's positioning transform, so the drop animation lives on the inner .me-pin
  const el = document.createElement("div"), pinEl = document.createElement("div"); el.className = "me-mk"; pinEl.className = "me-pin"; pinEl.title = t("you", { team: p.t });
  pinEl.innerHTML = `<svg viewBox="0 0 32 42" aria-hidden="true"><path d="M16 41s14-13.2 14-24.5a14 14 0 0 0-28 0C2 27.8 16 41 16 41z" fill="${colorOf(p.t)}" stroke="#fff" stroke-width="2.5"/><circle cx="16" cy="16.5" r="6" fill="#fff"/></svg>`;
  const tag = document.createElement("span"); tag.textContent = profile?.nick && validUsername(profile.nick) && !profile.nameHidden ? "@" + profile.nick : t("me"); pinEl.append(tag);
  el.append(pinEl);
  el.addEventListener("click", ev => {
    ev.stopPropagation();
    const box = document.createElement("div");
    const a = document.createElement("div"); a.className = "pop-t"; const d = document.createElement("span"); d.className = "dot"; d.style.background = colorOf(p.t); a.append(d, document.createTextNode(t("thisIsYou")));
    const b = document.createElement("div"); b.className = "pop-s"; b.textContent = t("fanOf", { team: p.t }) + " · " + t({ exact: "popExact", area: "popArea", city: "popCity" }[p.p] || "popArea");
    const acts = document.createElement("div"); acts.className = "pop-actions"; const e = document.createElement("button"); e.textContent = t("editPin"); e.onclick = () => { popup.remove(); openSheet(true); track("pin_edit_start", { source: "popup" }); }; acts.append(e);
    box.append(a, b, acts);
    const popup = new maplibregl.Popup({ offset: [0, -40], closeButton: false }).setLngLat([p.lng, p.lat]).setDOMContent(box).addTo(map);
    track("my_pin_open");
  });
  myMarker = new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([p.lng, p.lat]).addTo(map);
}
function updateMine() {
  myPin = user ? real.get(user.uid) || null : null;
  showMine(myPin);
  if (!myPin) editing = false;
  $("#myRow").hidden = !(editing && myPin);
  renderAccount(); updateCta(); refreshMatch();
}

/* ---------- match day: my pin's team plays today → cheer all day until the final whistle ---------- */
let matchFx = null, unsubMatch = null, cheersShown = false;
const hhmm = ms => new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit" }).format(ms);
async function refreshMatch() {
  const bar = $("#matchBar");
  const fx = myPin && backend ? (await todaysMatches(myPin.t).catch(() => [])).find(cheerOpen) : null;
  if (!fx) { bar.hidden = true; $("#mbChip").hidden = true; unsubMatch?.(); unsubMatch = null; matchFx = null; return; }
  if (matchFx?.id !== fx.id) {
    matchFx = fx; unsubMatch?.(); unsubMatch = backend.watchMatch(fx.id, paintCounts);
    backend.hasCheered(fx.id).then(setCheerBtn).catch(() => setCheerBtn(false));
    track("matchday_show", { team: myPin.t });
  }
  matchFx = { ...matchFx, ...fx }; paintMatch(); foldMatch(folded() === String(fx.id));
}
// the bar can be folded for the rest of this match (remembered); a small chip brings it back
const MB_FOLD = "tm.mbHide";
const folded = () => { try { return localStorage.getItem(MB_FOLD); } catch (_) { return null; } };
function foldMatch(on) {
  $("#matchBar").hidden = on; $("#mbChip").hidden = !on;
  if (on) $("#mbChipText").textContent = matchFx.home + " – " + matchFx.away + (Date.now() < matchFx.kickoff ? " " + hhmm(matchFx.kickoff) : "");
}
$("#mbClose").onclick = () => { try { localStorage.setItem(MB_FOLD, String(matchFx.id)); } catch (_) {} foldMatch(true); track("matchday_fold"); };
$("#mbChip").onclick = () => { try { localStorage.removeItem(MB_FOLD); } catch (_) {} foldMatch(false); track("matchday_unfold"); };
// rival colours must differ: mine stays, a look-alike opponent gets the most distant of a few fallbacks
const rgbCtx = document.createElement("canvas").getContext("2d");
const rgbOf = c => { rgbCtx.fillStyle = "#000"; rgbCtx.fillStyle = c; const h = rgbCtx.fillStyle; return h[0] === "#" ? [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) : [0, 0, 0]; };
const colorDist = (a, b) => { const x = rgbOf(a), y = rgbOf(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
const RIVAL_FALLBACK = ["#3355ff", "#ffb020", "#21a366", "#f2f2f2"];
function sideColor(side) {
  const mine = colorOf(myPin.t);
  if (side === matchFx.side) return mine;
  const theirs = colorOf(side === "h" ? matchFx.home : matchFx.away);
  return colorDist(mine, theirs) >= 110 ? theirs : RIVAL_FALLBACK.reduce((best, c) => colorDist(mine, c) > colorDist(mine, best) ? c : best);
}
function paintMatch() {
  const fx = matchFx;
  $("#mbHome").textContent = fx.home; $("#mbAway").textContent = fx.away;
  $("#mbHDot").style.background = $("#mbBarH").style.background = sideColor("h");
  $("#mbADot").style.background = $("#mbBarA").style.background = sideColor("a");
  $("#mbInfo").textContent = (Date.now() < fx.kickoff ? t("kickoffAt", { time: hhmm(fx.kickoff) }) : t("matchLive")) + " · " + fx.league;
}
let lastCounts = {};
function paintCounts(m) {
  lastCounts = m || {};
  const h = m.h || 0, a = m.a || 0;
  $("#mbCountH").textContent = t("cheersN", { n: num(h) }); $("#mbCountA").textContent = t("cheersN", { n: num(a) });
  $("#mbBarH").style.flexGrow = h + a ? h : 1; $("#mbBarA").style.flexGrow = h + a ? a : 1;
}
function setCheerBtn(done) { const b = $("#mbCheer"); relabel(b, done ? "cheered" : "cheer"); b.disabled = done; b.classList.toggle("done", done); }
// cheering takes a 5-second hold (cheerhold.js): the button fills in my colour while puppet fans climb out behind the card
const lum = c => { const [r, g, b] = rgbOf(c); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
let cheerXp = false;
holdToCheer($("#mbCheer"), $("#matchBar"), {
  canStart: () => !!(matchFx && backend && myPin),
  color: () => sideColor(matchFx.side),
  text: c => lum(c) > .62 ? "#16181c" : "#fff",
  labels: () => ({ hold: t("cheerHold"), done: t("cheerOk"), idle: t("cheer") }),
  track,
  onShort: () => { $("#mbInfo").textContent = t("cheerHoldHint"); },
  onStart: () => paintMatch(),
  async done() {
    try {
      const r = await backend.cheer(matchFx, myPin); cheerXp = !!r.xp;
      track("cheer", { team: myPin.t, on: r.xp }); if (cheersShown) loadCheerLayer();
    } catch (e) { $("#mbInfo").textContent = t("saveFailed"); track("cheer_error", { code: e.code || "unknown" }); throw e; }
  },
  settle(ok) { setCheerBtn(ok); if (ok) $("#mbInfo").textContent = t("cheerThanks") + (cheerXp ? " +25 XP" : ""); },
});
async function loadCheerLayer() {
  const list = await backend.loadCheers(matchFx.id).catch(() => []);
  cheersFC = { type: "FeatureCollection", features: list.map(c => ({ type: "Feature", properties: { c: sideColor(c.side) }, geometry: { type: "Point", coordinates: [c.lng, c.lat] } })) };
  map.getSource("cheers")?.setData(cheersFC);
}
// a switch: the cheers of this match as coloured dots on the map, on or off
$("#mbMap").onchange = async () => {
  cheersShown = $("#mbMap").checked;
  if (cheersShown) { await loadCheerLayer(); map.flyTo({ center: [myPin.lng, myPin.lat], zoom: 3, duration: 1200 }); }
  else { cheersFC = { type: "FeatureCollection", features: [] }; map.getSource("cheers")?.setData(cheersFC); }
  track("cheer_map", { on: cheersShown });
};
setInterval(() => { if (myPin) refreshMatch(); }, 5 * 60 * 1000);

/* ---------- account block: who I am, my pin, language, theme ---------- */
const account = $("#account");
function closeAccount() { document.body.classList.remove("acct-open"); }
function openAccount() { if (phone.matches) setBoard(false, false); document.body.classList.add("acct-open"); }
function acctStatus(msg, err) { const s = $("#acctStatus"); s.textContent = msg || ""; s.classList.toggle("err", !!err); }
function renderAccount() {
  const signed = !!user, uname = validUsername(profile?.nick) ? profile.nick : null, name = uname ? "@" + uname : user?.email || "";
  for (const a of [$("#acctAvatar"), $("#acctBtnAvatar")]) { a.textContent = signed ? ((uname || name)[0] || "?").toUpperCase() : "?"; a.classList.toggle("anon", !signed); }
  $("#acctName").textContent = signed ? name : t("guest");
  $("#acctSub").textContent = signed ? (uname ? user.email : t("signedIn")) : t("signedOut");
  $("#unameView").hidden = !signed || !uname; $("#unameText").textContent = uname || "";
  $("#unameAdd").hidden = !signed || !!uname || !$("#unameForm").hidden;
  if (!signed) $("#unameForm").hidden = true;
  $("#acctOut").hidden = signed; $("#acctIn").hidden = !signed; $("#signOutBtn").hidden = !signed;
  if (signed) $("#acctLogin").hidden = true;
  $("#myPinBox").hidden = $("#myPinActs").hidden = !myPin; $("#noPinBox").hidden = !signed || !!myPin;
  renderXp(); renderMyTribes();
  if (myPin) { $("#mpDot").style.background = colorOf(myPin.t); $("#mpTeam").textContent = myPin.t; $("#mpSub").textContent = t("myPin") + " · " + t(PREC_KEY[myPin.p] || "precArea"); }
}
$("#acctBtn").onclick = () => { if (document.body.classList.contains("acct-open")) closeAccount(); else openAccount(); track("account_open"); };
$("#acctClose").onclick = closeAccount;
$("#acctLoginBtn").onclick = () => { const box = $("#acctLogin"); box.hidden = !box.hidden; track("login_open"); };
/* XP + level: level L needs 50·L·(L-1) XP in total (0, 100, 300, 600, 1000, …) */
const xpFor = L => 50 * L * (L - 1);
function levelOf(xp) { let L = 1; while (xp >= xpFor(L + 1)) L++; return L; }
function renderXp() {
  const box = $("#xpBox"); box.hidden = !user || !stats; if (box.hidden) return;
  const xp = stats.xp || 0, L = levelOf(xp), lo = xpFor(L), hi = xpFor(L + 1);
  $("#xpLevel").textContent = t("level", { n: L });
  $("#xpPts").textContent = t("xpPts", { xp: num(xp), left: num(hi - xp) });
  $("#xpFill").style.width = Math.round((xp - lo) / (hi - lo) * 100) + "%";
}
function renderMyTribes() {
  const box = $("#myTribesBox"), ul = $("#myTribesList"), ids = [...new Set([...(stats?.current || []), ...(tribes?.guestIds() || [])])];
  box.hidden = !user || !stats; if (box.hidden) return;
  ul.replaceChildren();
  const mine = ids.map(id => tribes?.get(id)).filter(Boolean);
  // up to two right here; more go behind one row that opens the list in its own window
  if (mine.length > 2) {
    const li = document.createElement("li"), b = document.createElement("button"); b.className = "mt-more";
    const n = document.createElement("span"); n.className = "n"; n.textContent = num(mine.length) + " ›";
    b.append(document.createTextNode(t("myTribesOpen")), n); b.onclick = () => openMyTribes(mine); li.append(b); ul.append(li);
  } else for (const tr of mine) ul.append(tribes.row(tr));
  if (!ul.children.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = t("noMyTribes"); ul.append(li); }
}
// picking one of my tribes opens its sheet: the account sheet (and the list window) step aside
$("#myTribesList").addEventListener("click", e => { if (e.target.closest(".tribe-row")) closeAccount(); });
const mtModal = $("#myTribesModal");
const mtEsc = e => { if (e.key === "Escape") closeMyTribes(); };
function closeMyTribes() { mtModal.hidden = true; document.removeEventListener("keydown", mtEsc); }
function openMyTribes(list) {
  $("#mtList").replaceChildren(...list.map(tr => tribes.row(tr)));
  mtModal.hidden = false; document.addEventListener("keydown", mtEsc); $("#mtClose").focus();
  track("my_tribes_open", { n: list.length });
}
$("#mtClose").onclick = closeMyTribes;
mtModal.addEventListener("click", e => { if (e.target === mtModal) closeMyTribes(); });
$("#mtList").addEventListener("click", e => { if (e.target.closest(".tribe-row")) { closeMyTribes(); closeAccount(); } });

/* ---------- GDPR: download my data, delete my account ---------- */
$("#exportBtn").onclick = async () => {
  if (!backend || !user) return;
  acctStatus(t("exporting"));
  try {
    const data = await backend.exportMyData();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = "tribemap-" + new Date().toISOString().slice(0, 10) + ".json"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    acctStatus(t("exported")); track("data_export");
  } catch (e) { acctStatus(t("saveFailed"), true); track("data_export_error", { code: e.code || "unknown" }); }
};
$("#deleteAcctBtn").onclick = async () => {
  if (!backend || !user) return;
  // removing the sign-in itself needs a fresh sign-in: check first, so data and account go together
  if (!backend.recentlySignedIn()) { acctStatus(t("deleteNeedsLogin"), true); track("account_delete_relogin"); return; }
  const word = t("deleteWord");
  if ((prompt(t("deleteConfirmAll", { word })) || "").trim().toUpperCase() !== word) return;
  try {
    await backend.deleteMyAccount(step => acctStatus(t("deleting", { step: t("step_" + step) })));
    for (const k of ["tm.draft", "tm.email", "tm.board"]) try { localStorage.removeItem(k); } catch (_) {}
    try { sessionStorage.removeItem("tm.ref"); } catch (_) {}
    acctStatus(t("accountDeleted")); track("account_delete");
  } catch (e) {
    acctStatus(t(e.code === "auth/requires-recent-login" ? "deleteNeedsLogin" : "deleteFailed"), true);
    track("account_delete_error", { code: e.code || "unknown" });
  }
};

/* optional username (also the tribe nickname): unique, English letters, digits, - and _ */
function openUnameForm() { $("#unameForm").hidden = false; $("#unameAdd").hidden = true; const i = $("#unameInput"); i.value = profile?.nick && validUsername(profile.nick) ? profile.nick : ""; i.focus(); }
$("#unameAdd").onclick = openUnameForm; $("#unameEdit").onclick = openUnameForm;
$("#unameForm").onsubmit = async e => {
  e.preventDefault(); if (!backend || !user) return;
  const nick = $("#unameInput").value.trim(), bad = usernameProblem(nick);
  if (bad) { acctStatus(t(bad), true); return; }
  try {
    await backend.claimUsername(nick, profile?.nick, false);
    profile = { ...profile, nick, nameHidden: false }; tribes?.setProfile(profile);
    $("#unameForm").hidden = true; acctStatus(t("usernameSaved")); renderAccount(); showMine(myPin); track("username_set");
  } catch (err) { acctStatus(t(err.code === "taken" ? "nickTaken" : "saveFailed"), true); track("username_error", { code: err.code || "unknown" }); }
};
$("#mpShow").onclick = showMyPin;
$("#mpEdit").onclick = () => { openSheet(true); track("pin_edit_start"); };
$("#mpAdd").onclick = () => { openSheet(); $("#teamInput").focus(); track("pin_flow_start", { source: "account" }); };
renderAccount(); updateCta();

/* saving needs an account: a blurred draft waits in localStorage while the visitor signs in */
const authBox = $("#authBox");
const readDraft = () => { try { const d = JSON.parse(localStorage.getItem(DRAFT) || "null"); return d && typeof d.t === "string" ? d : null; } catch (_) { return null; } };
const dropDraft = () => { try { localStorage.removeItem(DRAFT); } catch (_) {} };
async function publish(pin) {
  $("#saveBtn").disabled = true; setStatus("");
  const had = !!myPin;
  try {
    await backend.savePin(pin); dropDraft();
    if (pendingMarker) { pendingMarker.remove(); pendingMarker = null; }
    setStatus(t(had ? "updated" : "saved"));
    if (!had) map.flyTo({ center: [pin.lng, pin.lat], zoom: Math.max(map.getZoom(), 12) });
    // done: the sheet steps aside (after a beat, so the confirmation is read) and the map shows the pin
    setTimeout(() => { if (!sheet.hidden) { sheet.hidden = true; document.body.classList.toggle("sheet-open", !!tribes?.isOpen()); stopPick(); } }, 900);
    track("pin_save", { team: pin.t, precision: pin.p, custom: !teamMeta.has(pin.t.toLowerCase()), update: had });
  } catch (e) {
    setStatus(t(e.code === "permission-denied" && had ? "tooFast" : "saveFailed"), true);
    track("pin_save_error", { code: e.code || "unknown" });
  }
  validate();
}
$("#saveBtn").onclick = () => {
  const prec = document.querySelector('input[name="prec"]:checked').value;
  const [bl, bg] = editing && keepLL && prec === myPin.p ? [myPin.lat, myPin.lng] : blur(pickLL[0], pickLL[1], prec);
  const pin = { t: chosenTeam, lat: +bl.toFixed(6), lng: +bg.toFixed(6), p: prec };
  if (isProfane(pin.t)) { setStatus(t("profane"), true); track("pin_blocked"); return; }
  if (user && backend) { publish(pin); return; }
  try { localStorage.setItem(DRAFT, JSON.stringify(pin)); } catch (_) {}
  authBox.hidden = false; $("#saveBtn").hidden = true;
  track("login_prompt");
};
async function deleteMyPin() {
  if (!myPin || !confirm(t("deleteConfirmPin"))) return;
  try { await backend.deletePin(); setStatus(t("deleted")); acctStatus(t("deleted")); track("pin_delete"); }
  catch (e) { setStatus(t("saveFailed"), true); acctStatus(t("saveFailed"), true); track("pin_delete_error", { code: e.code || "unknown" }); }
}
$("#delBtn").onclick = deleteMyPin; $("#mpDel").onclick = deleteMyPin;
// the same sign-in controls live in the pin sheet and in the account block; messages go to whichever was used
const sayFor = el => el.closest(".account") ? acctStatus : setStatus;
for (const b of document.querySelectorAll(".js-google")) b.onclick = async () => {
  if (!backend) return; loginMethod = "google"; track("login_start", { method: "google" });
  try { await backend.signInGoogle(); }
  catch (e) { if (!/popup-closed|cancelled-popup/.test(e.code)) sayFor(b)(t("authFailed"), true); track("login_error", { method: "google", code: e.code || "unknown" }); }
};
for (const f of document.querySelectorAll(".js-email")) f.onsubmit = async e => {
  e.preventDefault(); if (!backend) return;
  const email = f.querySelector("input").value.trim(); track("login_start", { method: "email" });
  try { await backend.sendEmailLink(email, lang); sayFor(f)(t("linkSent", { email })); track("login_link_sent"); }
  catch (err) { sayFor(f)(t("authFailed"), true); track("login_error", { method: "email", code: err.code || "unknown" }); }
};
$("#signOutBtn").onclick = () => { backend?.signOut(); track("logout"); };

/* ---------- tribes ---------- */
tribes = initTribes({
  map, maplibregl, t, num, track, colorOf, locale, asyncCombo, searchAreas, searchDistricts,
  lang: () => lang, selected: () => selected, inScope: (lng, lat) => !area || area.test(lng, lat),
  user: () => user, myPin: () => myPin, backend: () => backend, flash: flashHint, onMembership: () => renderMyTribes(),
  openPinSheet: () => { openSheet(); $("#teamInput").focus(); },
  openAuth: () => { $("#acctLogin").hidden = false; if (phone.matches) openAccount(); },
  setSheetOpen: open => document.body.classList.toggle("sheet-open", open || !sheet.hidden),
  closePin: () => { if (!sheet.hidden) { sheet.hidden = true; stopPick(); } },
  onProfile: p => { profile = p; renderAccount(); showMine(myPin); },
  stats: () => stats, onTribes: () => renderMyTribes(),
});
if (location.pathname.startsWith("/t/")) setView("tribes");

/* shared store + auth load after the map, so first paint is not blocked by the Firebase SDK */
import("./firebase.js").then(async fb => {
  backend = fb;
  tribes.setBackend(fb);
  fb.onUser(async u => {
    user = u; profile = null;
    tribes.onUser(u);
    if (u) fb.getProfile().then(async p => {
      profile = p;
      // a name hidden by reports must be changed before posting again
      if (p?.nick && await fb.nameHidden(p.nick)) {
        profile = { ...p, nameHidden: true }; tribes.setProfile(profile);
        acctStatus(t("nameHiddenYou"), true); openUnameForm(); if (phone.matches) openAccount();
        track("name_hidden_notice");
      }
      renderAccount(); showMine(myPin);
    }).catch(() => {});
    unsubStats?.(); unsubStats = null; stats = null;
    if (u) {
      unsubStats = fb.watchStats(s => { stats = s; renderAccount(); });
      // +10 XP once per (UTC) day for showing up; also creates the ledger for first-time users
      fb.claimDaily().then(got => { if (got) { acctStatus(t("dailyXp")); track("xp_daily"); } }).catch(() => {});
    }
    if (u) { authBox.hidden = true; $("#saveBtn").hidden = false; if (loginMethod) { track("login_success", { method: loginMethod }); loginMethod = null; } }
    updateMine();
    const d = u && readDraft(); if (d) { openSheet(); publish(d); }
  });
  fb.watchPins(m => { real = m; updateMine(); rebuild(); }, e => { track("store_error", { code: e.code || "unknown" }); });
  if (new URLSearchParams(location.search).has("signin")) loginMethod = "email";
  try { await fb.completeEmailLink(() => prompt(t("emailPrompt"))); }
  catch (e) { openSheet(); setStatus(t("authFailed"), true); track("login_error", { method: "email", code: e.code || "unknown" }); }
}).catch(() => setStatus(t("offline"), true));

/* ---------- consent + analytics ---------- */
const banner = $("#consent");
const answer = v => { setConsent(v); banner.hidden = true; };
$("#consentYes").onclick = () => answer("granted");
$("#consentNo").onclick = () => answer("denied");
$("#privacyBtn").onclick = () => { banner.hidden = false; };
if (!consent()) banner.hidden = false;
initAnalytics({ lang, theme, consent_analytics: consent() || "unset" });

/* ---------- first visit: a short welcome, once per browser (not on the way back from an e-mail sign-in link),
   then the guided tour; the footer's "Tour" button replays it ---------- */
// on phones the board steps open the board first, the rest fold it away
const boardStep = (sel, text) => ({ el: () => sel, text, before: () => { if (phone.matches) setBoard(true, false); } });
const TOUR = [
  boardStep(".stats", "tourStats"),
  boardStep(".seg3", "tourViews"),
  boardStep("#areaSeg", "tourArea"),
  boardStep("#teamList", "tourTeams"),
  { el: () => "#openSheet", text: "tourCta", before: () => { if (phone.matches) setBoard(false, false); } },
  { el: () => phone.matches ? "#acctBtn" : "#account", text: "tourAccount" },
];
const startTour = () => { closeAccount(); runTour(TOUR, { t, track }); };
$("#tourBtn").onclick = startTour;
(() => {
  let seen = false; try { seen = localStorage.getItem("tm.welcome") === "1"; } catch (_) {}
  if (seen || new URLSearchParams(location.search).has("signin")) return;
  const w = $("#welcome"), go = $("#welcomeGo");
  const esc = e => { if (e.key === "Escape") close(false); };
  const close = tour => { w.hidden = true; document.removeEventListener("keydown", esc); try { localStorage.setItem("tm.welcome", "1"); } catch (_) {} track("welcome_close"); if (tour) startTour(); };
  w.hidden = false; go.onclick = () => close(true); document.addEventListener("keydown", esc); go.focus();
  track("welcome_show");
})();
