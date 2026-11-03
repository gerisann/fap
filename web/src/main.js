import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "./style.css";
import { TEAMS } from "./data/teams.js";
import { blur, makeDemo } from "./data/demo.js";
import { loadStyle } from "./basemap.js";
import { searchCities, searchAddress, searchAreas } from "./geocode.js";
import { placeGeometry, circle, distKm, bbox, contains } from "./area.js";
import { asyncCombo } from "./combo.js";
import { t, num, lang, applyDom, setLang, onLangChange } from "./i18n.js";
import { track, initAnalytics, consent, setConsent } from "./analytics.js";

const $ = s => document.querySelector(s);
maplibregl.setWorkerUrl(workerUrl); // v6 + bundler: the worker URL must be given explicitly
applyDom();

/* ---------- teams ---------- */
const teamMeta = new Map(TEAMS.map(([n, c, col]) => [n.toLowerCase(), { name: n, country: c, color: col }]));
const aliases = { "fradi": "Ferencváros", "ftc": "Ferencváros", "barca": "FC Barcelona", "barça": "FC Barcelona", "bayern": "Bayern München", "man utd": "Manchester United", "psg": "Paris Saint-Germain", "bvb": "Borussia Dortmund", "spurs": "Tottenham Hotspur", "juve": "Juventus", "dvsc": "Debreceni VSC", "dvtk": "Diósgyőr", "fehérvár": "Videoton / MOL Fehérvár" };
function hashColor(s) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 70% 58%)`; }
function canonical(name) { const k = name.trim().toLowerCase(); const m = teamMeta.get(k) || teamMeta.get((aliases[k] || "").toLowerCase()); return m ? m.name : name.trim().replace(/\s+/g, " ").slice(0, 40); }
function colorOf(name) { const m = teamMeta.get(name.toLowerCase()); return m ? m.color : hashColor(name); }
const DEMO = makeDemo(24000);

/* ---------- state ---------- */
const MAX_TEAMS = 5;
let view = "pins", selected = [], showDemo = true;
let area = null;                 // { level, name, geom, test(lng, lat) }; null = whole world
let real = new Map();            // uid -> pin from the shared store
let user = null, myPin = null, backend = null, loginMethod = null;
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

let ready = false, topKeys = [], styleSeq = 0;
const OTHER = "var(--wash-2)";
async function reloadStyle() {
  const seq = ++styleSeq;
  const s = await loadStyle(theme, lang, P()).catch(() => null);
  if (!s || seq !== styleSeq) return;
  ready = false; clearLabels(); map.setStyle(s, { diff: false });
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
function fc(arr) { return { type: "FeatureCollection", features: arr.map(p => ({ type: "Feature", properties: { t: p.t, c: colorOf(p.t), p: p.p, d: p.demo ? 1 : 0 }, geometry: { type: "Point", coordinates: [p.lng, p.lat] } })) }; }
function keyProps(keys) { const props = {}; keys.forEach((tm, i) => { props["k" + i] = ["+", ["case", ["==", ["get", "t"], tm], 1, 0]]; }); return props; }
function addClusterSource(id, data, keys) {
  if (map.getLayer(id + "-c")) map.removeLayer(id + "-c");
  if (map.getLayer(id + "-u")) map.removeLayer(id + "-u");
  if (map.getSource(id)) map.removeSource(id);
  map.addSource(id, { type: "geojson", data, cluster: true, clusterRadius: 48, clusterMaxZoom: 15, clusterProperties: keyProps(keys) });
  map.addLayer({ id: id + "-c", type: "circle", source: id, filter: ["has", "point_count"], paint: {
    "circle-color": "rgba(0,0,0,0)", "circle-radius": ["step", ["get", "point_count"], 12, 10, 15, 50, 19, 200, 24, 1000, 30, 4000, 37] } });
  map.addLayer({ id: id + "-u", type: "circle", source: id, filter: ["!", ["has", "point_count"]], paint: {
    "circle-color": ["get", "c"], "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 3.5, 14, 7],
    "circle-stroke-color": ["case", ["==", ["get", "d"], 0], P().accent, P().paper], "circle-stroke-width": ["case", ["==", ["get", "d"], 0], 2.5, 1.2] } });
}
function rebuild() {
  if (!ready) return;
  const pts = scoped();
  const groups = new Map(); for (const p of pts) groups.set(p.t, (groups.get(p.t) || 0) + 1);
  const data = fc(pts);
  map.getSource("heat").setData(data);
  const top = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(x => x[0]);
  if (top.join("|") !== topKeys.join("|") || !map.getSource("all")) { topKeys = top; addClusterSource("all", data, top); }
  else map.getSource("all").setData(data);
  updateSel(pts);
  applyVisibility(); renderStats(groups, pts.length); scheduleLabels();
}
function updateSel(pts) {
  const set = new Set(selected);
  addClusterSource("sel", fc((pts || scoped()).filter(p => set.has(p.t))), selected);
}
function applyVisibility() {
  if (!ready) return;
  const all = view === "pins" && !selected.length, sel = view === "pins" && !!selected.length;
  for (const [id, on] of [["all", all], ["sel", sel]]) for (const L of ["-c", "-u"]) if (map.getLayer(id + L)) map.setLayoutProperty(id + L, "visibility", on ? "visible" : "none");
  map.setLayoutProperty("heatL", "visibility", view === "heat" ? "visible" : "none");
  map.setFilter("heatL", selected.length ? ["in", ["get", "t"], ["literal", selected]] : null);
  clearLabels(); scheduleLabels();
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
function fmt(n) { return n >= 10000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1).replace(".0", "") + "k" : String(n); }
function radiusFor(n) { return n < 10 ? 12 : n < 50 ? 15 : n < 200 ? 19 : n < 1000 ? 24 : n < 4000 ? 30 : 37; }
function donut(props, keys) {
  const n = props.point_count, r = radiusFor(n) + 3, w = Math.max(4, r * .22), R = r - w / 2, C = 2 * Math.PI * R;
  const parts = keys.map((tm, i) => [colorOf(tm), props["k" + i] || 0]);
  const known = parts.reduce((s, x) => s + x[1], 0); parts.push([OTHER, Math.max(0, n - known)]);
  let off = 0, segs = "";
  for (const [col, v] of parts) { if (!v) continue; const len = v / n * C; segs += `<circle r="${R}" cx="${r}" cy="${r}" fill="none" style="stroke:${col}" stroke-width="${w}" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 ${r} ${r})"/>`; off += len; }
  const el = document.createElement("div"); el.className = "donut"; el.style.width = el.style.height = (2 * r) + "px";
  el.innerHTML = `<svg width="${2 * r}" height="${2 * r}" viewBox="0 0 ${2 * r} ${2 * r}" aria-hidden="true"><circle r="${r - .5}" cx="${r}" cy="${r}" style="fill:var(--paper)"/>${segs}</svg><b>${fmt(n)}</b>`;
  const lead = parts.slice(0, -1).sort((a, b) => b[1] - a[1])[0];
  el.title = t("clusterTitle", { n: num(n) }) + (lead && lead[1] ? " · " + t("mostFans", { team: keys[parts.indexOf(lead)] }) : "");
  return el;
}
function updateLabels() {
  if (!ready) return;
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
  if (map.getSource("heat")) return;
  map.addSource("area", { type: "geojson", data: areaFC() });
  map.addLayer({ id: "area-fill", type: "fill", source: "area", paint: { "fill-color": P().accent, "fill-opacity": .06 } });
  map.addLayer({ id: "area-line", type: "line", source: "area", paint: { "line-color": P().accent, "line-width": 1.6, "line-opacity": .8 } });
  map.addSource("heat", { type: "geojson", data: fc([]) });
  map.addLayer({ id: "heatL", type: "heatmap", source: "heat", layout: { visibility: "none" }, paint: {
    "heatmap-weight": ["interpolate", ["linear"], ["zoom"], 1, .01, 5, .04, 9, .2, 13, 1],
    "heatmap-intensity": 1,
    "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 1, 10, 5, 22, 10, 30, 14, 36],
    "heatmap-opacity": .85,
    "heatmap-color": heatRamp() } });
  ready = true; topKeys = []; rebuild(); applyMapTheme();
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
  const q = teamQuery.trim().toLowerCase(), al = aliases[q];
  const rows = q ? all.filter(([tm]) => tm.toLowerCase().includes(q) || (al && tm === al)).slice(0, 40) : showAll ? all : all.slice(0, 10);
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
  if (ready) { updateSel(); applyVisibility(); }
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
function setArea(next) { area = next; if (ready) { map.getSource("area")?.setData(areaFC()); rebuild(); } }
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
function setBoard(open, persist) {
  board.classList.toggle("collapsed", !open); grab.setAttribute("aria-expanded", String(open));
  if (persist) { try { localStorage.setItem("tm.board", open ? "1" : "0"); } catch (_) {} track("panel_toggle", { on: open }); }
}
setBoard(!phone.matches || (() => { try { return localStorage.getItem("tm.board") === "1"; } catch (_) { return false; } })(), false);
grab.onclick = () => setBoard(board.classList.contains("collapsed"), true);
let swipeY = null;
board.addEventListener("touchstart", e => { swipeY = phone.matches && !e.target.closest(".board-body") || e.target.closest(".grab") ? e.touches[0].clientY : null; }, { passive: true });
board.addEventListener("touchend", e => {
  if (swipeY == null) return; const dy = e.changedTouches[0].clientY - swipeY; swipeY = null;
  if (dy < -28) setBoard(false, true); else if (dy > 28) setBoard(true, true);
}, { passive: true });
function setView(v) { view = v; $("#vPins").setAttribute("aria-pressed", String(v === "pins")); $("#vHeat").setAttribute("aria-pressed", String(v === "heat")); applyVisibility(); track("view_change", { view: v }); }
$("#vPins").onclick = () => setView("pins"); $("#vHeat").onclick = () => setView("heat");
$("#demoToggle").onchange = e => { showDemo = e.target.checked; rebuild(); track("demo_toggle", { on: showDemo }); };

const langSel = $("#langSel"); langSel.value = lang;
langSel.onchange = () => setLang(langSel.value);
onLangChange(l => { if (lastGroups) renderStats(lastGroups, lastTotal); reloadStyle(); track("lang_change", { lang: l }); });

/* ---------- sign-up sheet ---------- */
let chosenTeam = null, pickLL = null, picking = false, pendingMarker = null, myMarker = null;
const sheet = $("#sheet");
function openSheet() { sheet.hidden = false; document.body.classList.add("sheet-open"); }
$("#openSheet").onclick = () => { openSheet(); $("#teamInput").focus(); track("pin_flow_start"); };
$("#closeSheet").onclick = () => { sheet.hidden = true; document.body.classList.remove("sheet-open"); stopPick(); track("pin_flow_close", { team_chosen: !!chosenTeam, place_chosen: !!pickLL }); };
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
  const al = aliases[q];
  optList = TEAMS.filter(([n]) => n.toLowerCase().includes(q) || (al && n === al)).slice(0, 8).map(x => x[0]);
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
  pickLL = [lat, lng];
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
  const el = document.createElement("div"); el.className = "me"; el.title = t("you", { team: p.t });
  myMarker = new maplibregl.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map);
}
function updateMine() {
  myPin = user ? real.get(user.uid) || null : null;
  showMine(myPin);
  $("#myRow").hidden = !user; $("#delBtn").hidden = !myPin;
  $("#whoAmI").textContent = user ? t("signedInAs", { email: user.email || "" }) : "";
}

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
    setStatus(t("saved"));
    map.flyTo({ center: [pin.lng, pin.lat], zoom: Math.max(map.getZoom(), 12) });
    track("pin_save", { team: pin.t, precision: pin.p, custom: !teamMeta.has(pin.t.toLowerCase()), update: had });
  } catch (e) {
    setStatus(t(e.code === "permission-denied" && had ? "tooFast" : "saveFailed"), true);
    track("pin_save_error", { code: e.code || "unknown" });
  }
  validate();
}
$("#saveBtn").onclick = () => {
  const prec = document.querySelector('input[name="prec"]:checked').value;
  const [bl, bg] = blur(pickLL[0], pickLL[1], prec);
  const pin = { t: chosenTeam, lat: +bl.toFixed(6), lng: +bg.toFixed(6), p: prec };
  if (user && backend) { publish(pin); return; }
  try { localStorage.setItem(DRAFT, JSON.stringify(pin)); } catch (_) {}
  authBox.hidden = false; $("#saveBtn").hidden = true;
  track("login_prompt");
};
$("#delBtn").onclick = async () => {
  try { await backend.deletePin(); setStatus(t("deleted")); track("pin_delete"); }
  catch (e) { setStatus(t("saveFailed"), true); track("pin_delete_error", { code: e.code || "unknown" }); }
};
$("#googleBtn").onclick = async () => {
  if (!backend) return; loginMethod = "google"; track("login_start", { method: "google" });
  try { await backend.signInGoogle(); }
  catch (e) { if (!/popup-closed|cancelled-popup/.test(e.code)) setStatus(t("authFailed"), true); track("login_error", { method: "google", code: e.code || "unknown" }); }
};
$("#emailForm").onsubmit = async e => {
  e.preventDefault(); if (!backend) return;
  const email = $("#emailInput").value.trim(); track("login_start", { method: "email" });
  try { await backend.sendEmailLink(email); setStatus(t("linkSent", { email })); track("login_link_sent"); }
  catch (err) { setStatus(t("authFailed"), true); track("login_error", { method: "email", code: err.code || "unknown" }); }
};
$("#signOutBtn").onclick = () => { backend?.signOut(); track("logout"); };

/* shared store + auth load after the map, so first paint is not blocked by the Firebase SDK */
import("./firebase.js").then(async fb => {
  backend = fb;
  fb.onUser(u => {
    user = u;
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
