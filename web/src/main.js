import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "./style.css";
import { TEAMS } from "./data/teams.js";
import { CITIES } from "./data/cities.js";
import { blur, makeDemo } from "./data/demo.js";
import { loadStyle } from "./basemap.js";
import { t, num, lang, locale, applyDom, setLang, onLangChange } from "./i18n.js";
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
function isLight(hex) { const c = document.createElement("canvas").getContext("2d"); c.fillStyle = hex; const v = c.fillStyle; if (v[0] !== "#") return false; const r = parseInt(v.slice(1, 3), 16), g = parseInt(v.slice(3, 5), 16), b = parseInt(v.slice(5, 7), 16); return (0.299 * r + 0.587 * g + 0.114 * b) > 165; }
const lightCache = new Map(); const light = n => { if (!lightCache.has(n)) lightCache.set(n, isLight(colorOf(n))); return lightCache.get(n); };

const DEMO = makeDemo(24000);

/* ---------- state ---------- */
const LS = "tm.mypin";
let view = "pins", filter = null, showDemo = true;
let real = new Map();            // id -> pin from the shared store (F1)
let localOnly = null, myPin = null;
try { const v = JSON.parse(localStorage.getItem(LS) || "null"); if (v && typeof v.t === "string") { localOnly = { ...v, demo: false }; myPin = localOnly; } } catch (_) {}
function points() { const arr = showDemo ? DEMO.slice() : []; for (const p of real.values()) arr.push(p); if (localOnly) arr.push(localOnly); return arr; }

/* ---------- theme ---------- */
const PAL = {
  light: { paper: "#ffffff", ocean: "#e4e7ec", land: "#fbfbfc", accent: "#3355ff", space: "#eef0f3", horizon: "#dfe3ea", meta: "#ffffff" },
  dark: { paper: "#1b1d21", ocean: "#0e1013", land: "#1f2226", accent: "#6680ff", space: "#0b0c0e", horizon: "#16181c", meta: "#1b1d21" },
};
let theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
const P = () => PAL[theme];
function heatRamp() { const a = P().accent; return ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(80,100,255,0)", .15, "rgba(80,100,255,.18)", .4, "rgba(80,100,255,.5)", .7, a, .9, theme === "dark" ? "#8fa2ff" : "#1e2fa8", 1, theme === "dark" ? "#c9d2ff" : "#16181c"]; }
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
  for (const id of ["all", "one"]) { set(id + "-c", "circle-stroke-color", p.paper); set(id + "-u", "circle-stroke-color", ["case", ["==", ["get", "d"], 0], p.accent, p.paper]); }
  set("heatL", "heatmap-color", heatRamp());
}
function applyTheme(next) {
  theme = next; const d = document.documentElement; d.dataset.theme = next; d.classList.toggle("is-dark", next === "dark");
  document.querySelector('meta[name="theme-color"]').setAttribute("content", P().meta);
  try { localStorage.setItem("tm.theme", next); } catch (_) {}
  reloadStyle();
}

/* two clustered sources: "all" (donut clusters by team share) and "one" (a single team) */
function fc(arr) { return { type: "FeatureCollection", features: arr.map(p => ({ type: "Feature", properties: { t: p.t, c: colorOf(p.t), p: p.p, d: p.demo ? 1 : 0 }, geometry: { type: "Point", coordinates: [p.lng, p.lat] } })) }; }
function addClusterSource(id, data, props) {
  if (map.getLayer(id + "-c")) map.removeLayer(id + "-c");
  if (map.getLayer(id + "-u")) map.removeLayer(id + "-u");
  if (map.getSource(id)) map.removeSource(id);
  map.addSource(id, { type: "geojson", data, cluster: true, clusterRadius: 48, clusterMaxZoom: 15, clusterProperties: props || {} });
  map.addLayer({ id: id + "-c", type: "circle", source: id, filter: ["has", "point_count"], paint: {
    "circle-color": id === "one" ? "#888" : "rgba(0,0,0,0)", "circle-opacity": .9, "circle-stroke-color": P().paper, "circle-stroke-width": id === "one" ? 2 : 0,
    "circle-radius": ["step", ["get", "point_count"], 12, 10, 15, 50, 19, 200, 24, 1000, 30, 4000, 37] } });
  map.addLayer({ id: id + "-u", type: "circle", source: id, filter: ["!", ["has", "point_count"]], paint: {
    "circle-color": ["get", "c"], "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 3.5, 14, 7],
    "circle-stroke-color": ["case", ["==", ["get", "d"], 0], P().accent, P().paper], "circle-stroke-width": ["case", ["==", ["get", "d"], 0], 2.5, 1.2] } });
}
function rebuild() {
  if (!ready) return;
  const pts = points();
  const groups = new Map(); for (const p of pts) groups.set(p.t, (groups.get(p.t) || 0) + 1);
  map.getSource("heat").setData(fc(pts));
  const top = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(x => x[0]);
  const allData = fc(pts);
  if (top.join("|") !== topKeys.join("|") || !map.getSource("all")) {
    topKeys = top; const props = {}; top.forEach((tm, i) => { props["k" + i] = ["+", ["case", ["==", ["get", "t"], tm], 1, 0]]; });
    addClusterSource("all", allData, props);
  } else map.getSource("all").setData(allData);
  updateOne(pts);
  applyVisibility(); renderStats(groups, pts.length); scheduleLabels();
}
function updateOne(pts) {
  pts = pts || points();
  const arr = filter ? pts.filter(p => p.t === filter) : [];
  addClusterSource("one", fc(arr)); map.setPaintProperty("one-c", "circle-color", filter ? colorOf(filter) : "#000");
}
function applyVisibility() {
  if (!ready) return;
  const all = view === "pins" && !filter, one = view === "pins" && !!filter;
  for (const [id, on] of [["all", all], ["one", one]]) for (const L of ["-c", "-u"]) if (map.getLayer(id + L)) map.setLayoutProperty(id + L, "visibility", on ? "visible" : "none");
  map.setLayoutProperty("heatL", "visibility", view === "heat" ? "visible" : "none");
  map.setFilter("heatL", filter ? ["==", ["get", "t"], filter] : null);
  clearLabels(); scheduleLabels();
}
function onClick(e, src) {
  if (picking) return;
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
for (const src of ["all", "one"]) for (const L of ["-c", "-u"]) {
  map.on("click", src + L, e => onClick(e, src));
  map.on("mouseenter", src + L, () => { if (!picking) map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", src + L, () => { if (!picking) map.getCanvas().style.cursor = ""; });
}

/* cluster markers drawn as HTML: team-share donuts (all) or numbered team bubbles (one) */
let labels = new Map(), labelTimer = 0;
function scheduleLabels() { if (labelTimer) return; labelTimer = setTimeout(() => { labelTimer = 0; updateLabels(); }, 60); }
function clearLabels() { for (const m of labels.values()) m.remove(); labels = new Map(); }
function fmt(n) { return n >= 10000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1).replace(".0", "") + "k" : String(n); }
function radiusFor(n) { return n < 10 ? 12 : n < 50 ? 15 : n < 200 ? 19 : n < 1000 ? 24 : n < 4000 ? 30 : 37; }
function donut(props) {
  const n = props.point_count, r = radiusFor(n) + 3, w = Math.max(4, r * .22), R = r - w / 2, C = 2 * Math.PI * R;
  const parts = topKeys.map((tm, i) => [colorOf(tm), props["k" + i] || 0]);
  const known = parts.reduce((s, x) => s + x[1], 0); parts.push([OTHER, Math.max(0, n - known)]);
  let off = 0, segs = "";
  for (const [col, v] of parts) { if (!v) continue; const len = v / n * C; segs += `<circle r="${R}" cx="${r}" cy="${r}" fill="none" style="stroke:${col}" stroke-width="${w}" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 ${r} ${r})"/>`; off += len; }
  const el = document.createElement("div"); el.className = "donut"; el.style.width = el.style.height = (2 * r) + "px";
  el.innerHTML = `<svg width="${2 * r}" height="${2 * r}" viewBox="0 0 ${2 * r} ${2 * r}" aria-hidden="true"><circle r="${r - .5}" cx="${r}" cy="${r}" style="fill:var(--paper)"/>${segs}</svg><b>${fmt(n)}</b>`;
  const lead = parts.slice(0, -1).sort((a, b) => b[1] - a[1])[0];
  el.title = t("clusterTitle", { n: num(n) }) + (lead && lead[1] ? " · " + t("mostFans", { team: topKeys[parts.indexOf(lead)] }) : "");
  return el;
}
function updateLabels() {
  if (!ready) return;
  const next = new Map();
  const src = view !== "pins" ? null : filter ? "one" : "all";
  if (src) {
    let feats = []; try { feats = map.querySourceFeatures(src, { filter: ["has", "point_count"] }); } catch (_) {}
    for (const f of feats) {
      const key = src + ":" + f.properties.cluster_id; if (next.has(key)) continue;
      let m = labels.get(key);
      if (!m) {
        let el;
        if (src === "all") { el = donut(f.properties); el.addEventListener("click", ev => { ev.stopPropagation(); if (!picking) zoomCluster("all", f.properties.cluster_id, f.geometry.coordinates, f.properties.point_count); }); }
        else { el = document.createElement("div"); el.className = "cl" + (light(filter) ? " dark" : ""); el.textContent = fmt(f.properties.point_count); }
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
map.on("sourcedata", e => { if (e.isSourceLoaded && (e.sourceId === "all" || e.sourceId === "one")) scheduleLabels(); });
map.on("zoomend", () => { clearLabels(); scheduleLabels(); });

let lastMoveTrack = 0;
map.on("moveend", e => {
  if (!e.originalEvent || Date.now() - lastMoveTrack < 3000) return;
  lastMoveTrack = Date.now(); track("map_move", { zoom: Math.round(map.getZoom()), view });
});

function setupLayers() {
  if (map.getSource("heat")) return;
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

/* ---------- board ---------- */
let lastGroups = null, lastTotal = 0;
function renderStats(groups, total) {
  lastGroups = groups; lastTotal = total;
  $("#sTotal").textContent = num(total);
  $("#sTeams").textContent = t("statsSub", { n: num(groups.size) });
  const top = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const ul = $("#teamList"); ul.replaceChildren();
  for (const [tm, n] of top) {
    const li = document.createElement("li"), b = document.createElement("button"); b.setAttribute("aria-pressed", String(filter === tm));
    const d = document.createElement("span"); d.className = "dot"; d.style.background = colorOf(tm);
    const nm = document.createElement("span"); nm.textContent = tm; const c = document.createElement("span"); c.className = "n"; c.textContent = num(n);
    b.append(d, nm, c); b.onclick = () => setFilter(filter === tm ? null : tm, "list"); li.append(b); ul.append(li);
  }
  renderFilter();
}
function renderFilter() {
  const box = $("#filterBox"); box.replaceChildren();
  if (!filter) return;
  const chip = document.createElement("div"); chip.className = "filter-chip"; const d = document.createElement("span"); d.className = "dot"; d.style.background = colorOf(filter);
  const n = document.createElement("span"); n.textContent = filter; n.style.flex = "1"; const x = document.createElement("button"); x.textContent = "✕"; x.setAttribute("aria-label", t("clearFilter")); x.onclick = () => setFilter(null, "chip");
  chip.append(d, n, x); box.append(chip);
}
function setFilter(tm, source) { filter = tm; if (ready) { updateOne(); applyVisibility(); } if (lastGroups) renderStats(lastGroups, lastTotal); track("team_filter", { team: tm || "(none)", source }); }
function setView(v) { view = v; $("#vPins").setAttribute("aria-pressed", String(v === "pins")); $("#vHeat").setAttribute("aria-pressed", String(v === "heat")); applyVisibility(); track("view_change", { view: v }); }
$("#vPins").onclick = () => setView("pins"); $("#vHeat").onclick = () => setView("heat");
$("#demoToggle").onchange = e => { showDemo = e.target.checked; rebuild(); track("demo_toggle", { on: showDemo }); };

const langSel = $("#langSel"); langSel.value = lang;
langSel.onchange = () => setLang(langSel.value);
onLangChange(l => { if (lastGroups) renderStats(lastGroups, lastTotal); fillCities(); reloadStyle(); track("lang_change", { lang: l }); });

/* ---------- sign-up sheet ---------- */
let chosenTeam = null, pickLL = null, picking = false, pendingMarker = null, myMarker = null;
const sheet = $("#sheet");
$("#openSheet").onclick = () => { sheet.hidden = false; document.body.classList.add("sheet-open"); $("#teamInput").focus(); track("pin_flow_start"); };
$("#closeSheet").onclick = () => { sheet.hidden = true; document.body.classList.remove("sheet-open"); stopPick(); track("pin_flow_close", { team_chosen: !!chosenTeam, place_chosen: !!pickLL }); };
function fillCities() {
  const sel = $("#citySel"), keep = sel.value; sel.replaceChildren(sel.options[0]);
  for (const c of [...CITIES].sort((a, b) => a[0].localeCompare(b[0], locale()))) { const o = document.createElement("option"); o.value = c[1] + "," + c[2]; o.textContent = c[0]; sel.append(o); }
  sel.value = keep;
}
fillCities();

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
$("#citySel").onchange = e => { if (!e.target.value) return; const [la, ln] = e.target.value.split(",").map(Number); setPick(ln, la, "city", e.target.selectedOptions[0].textContent); map.flyTo({ center: [ln, la], zoom: 11 }); };
const HINTS = { area: "hintArea", city: "hintCity", exact: "hintExact" };
document.querySelectorAll('input[name="prec"]').forEach(r => r.addEventListener("change", () => { const h = $("#precHint"); h.dataset.i18n = HINTS[r.value]; h.textContent = t(HINTS[r.value]); track("pin_precision", { precision: r.value }); }));
function validate() { $("#saveBtn").disabled = !(chosenTeam && pickLL); }
function setStatus(msg, err) { const s = $("#status"); s.textContent = msg; s.classList.toggle("err", !!err); }

function showMine(p) {
  if (myMarker) { myMarker.remove(); myMarker = null; }
  $("#myRow").hidden = !p;
  if (!p) return;
  const el = document.createElement("div"); el.className = "me"; el.title = t("you", { team: p.t });
  myMarker = new maplibregl.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map);
}
showMine(myPin);
$("#saveBtn").onclick = () => {
  const prec = document.querySelector('input[name="prec"]:checked').value;
  const [bl, bg] = blur(pickLL[0], pickLL[1], prec);
  const pin = { t: chosenTeam, lat: +bl.toFixed(6), lng: +bg.toFixed(6), p: prec, ts: Date.now() };
  $("#saveBtn").disabled = true;
  if (pendingMarker) { pendingMarker.remove(); pendingMarker = null; }
  localOnly = { ...pin, demo: false }; myPin = localOnly;
  try { localStorage.setItem(LS, JSON.stringify(pin)); } catch (_) {}
  setStatus(t("savedLocal")); rebuild();
  showMine(myPin); map.flyTo({ center: [pin.lng, pin.lat], zoom: Math.max(map.getZoom(), 12) }); validate();
  track("pin_save", { team: pin.t, precision: prec, custom: !teamMeta.has(pin.t.toLowerCase()) });
};
$("#delBtn").onclick = () => {
  localOnly = null; myPin = null; try { localStorage.removeItem(LS); } catch (_) {}
  showMine(null); rebuild(); setStatus(t("deleted"));
  track("pin_delete");
};

/* ---------- consent + analytics ---------- */
const banner = $("#consent");
const answer = v => { setConsent(v); banner.hidden = true; };
$("#consentYes").onclick = () => answer("granted");
$("#consentNo").onclick = () => answer("denied");
$("#privacyBtn").onclick = () => { banner.hidden = false; };
if (!consent()) banner.hidden = false;
initAnalytics({ lang, theme, consent_analytics: consent() || "unset", has_pin: !!myPin });
