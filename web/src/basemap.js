/* OpenFreeMap vector styles, recoloured to the design tokens, labels in the UI language, globe projection. */

const URLS = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };
const cache = new Map();
const LABEL = /^(label_|place_|water_name|airport)/;

export async function loadStyle(theme, lang, pal) {
  if (!cache.has(theme)) cache.set(theme, fetch(URLS[theme]).then(r => { if (!r.ok) throw new Error("style " + r.status); return r.json(); }));
  const s = structuredClone(await cache.get(theme));
  for (const l of s.layers) {
    if (l.id === "background") l.paint = { ...l.paint, "background-color": pal.land };
    if (l.id === "water") l.paint = { ...l.paint, "fill-color": pal.ocean };
    if (l.layout?.["text-field"] && LABEL.test(l.id)) l.layout["text-field"] = ["coalesce", ["get", "name:" + lang], ["get", "name:latin"], ["get", "name"]];
  }
  s.projection = { type: "globe" };
  s.sky = {
    "sky-color": pal.space, "horizon-color": pal.horizon, "fog-color": pal.horizon,
    "sky-horizon-blend": .6, "horizon-fog-blend": .5, "fog-ground-blend": .9,
    "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 7, 0],
  };
  return s;
}
