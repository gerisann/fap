/* Place search via Photon (OpenStreetMap, komoot). The UI only uses searchCities / searchAddress,
   so the provider can be swapped (e.g. Google Places) without touching main.js. */

const API = "https://photon.komoot.io/api/";
const PLANG = { en: "en" }; // Photon knows default/en/de/fr; "default" = local names

async function photon(params, signal) {
  const u = new URL(API);
  for (const [k, v] of params) u.searchParams.append(k, v);
  const r = await fetch(u, { signal });
  if (!r.ok) throw new Error("geocode " + r.status);
  return (await r.json()).features || [];
}
const dedupe = list => { const seen = new Set(); return list.filter(x => { const k = x.name + "|" + x.sub; if (seen.has(k)) return false; seen.add(k); return true; }); };

export async function searchCities(q, lang, signal) {
  const f = await photon([["q", q], ["limit", "8"], ["layer", "city"], ["lang", PLANG[lang] || "default"]], signal);
  return dedupe(f.map(x => {
    const p = x.properties;
    return { name: p.name, sub: [p.state, p.country].filter(Boolean).join(", "), lng: x.geometry.coordinates[0], lat: x.geometry.coordinates[1], extent: p.extent };
  }));
}

/* countries or cities for the area filter; osm = "R123" style id for the outline lookup */
export async function searchAreas(q, level, lang, signal) {
  const f = await photon([["q", q], ["limit", "8"], ["layer", level === "country" ? "country" : "city"], ["lang", PLANG[lang] || "default"]], signal);
  return dedupe(f.map(x => {
    const p = x.properties;
    return { name: p.name, sub: level === "country" ? "" : [p.state, p.country].filter(Boolean).join(", "), lng: x.geometry.coordinates[0], lat: x.geometry.coordinates[1], extent: p.extent, osm: p.osm_type && p.osm_id ? p.osm_type + p.osm_id : null };
  }));
}

// districts (boroughs, e.g. "XIII. kerület") and neighbourhoods (suburbs) inside a picked city, for district tribes
export async function searchDistricts(q, city, lang, signal) {
  const base = [["q", q], ["limit", "8"], ["layer", "district"], ["lang", PLANG[lang] || "default"]];
  let f = [];
  if (city.extent) { const [a, b, c, d] = city.extent; f = await photon([...base, ["bbox", [a, d, c, b].join(",")]], signal); }
  // a city's extent can be its core only (London → City of London): then anything within 40 km of its centre
  if (!f.length) f = (await photon([...base, ["lat", String(city.lat)], ["lon", String(city.lng)]], signal)).filter(x => {
    const [lng, lat] = x.geometry.coordinates, k = Math.cos(city.lat * Math.PI / 180);
    return Math.hypot((lat - city.lat) * 111, (lng - city.lng) * 111 * k) <= 40;
  });
  return dedupe(f.filter(x => x.properties.osm_type && x.properties.osm_id).map(x => {
    const p = x.properties;
    return { name: p.name, sub: p.city || city.name, lng: x.geometry.coordinates[0], lat: x.geometry.coordinates[1], osm: p.osm_type + p.osm_id };
  }));
}

export async function searchAddress(q, city, lang, signal) {
  const params = [["q", q + ", " + city.name], ["limit", "8"], ["layer", "house"], ["layer", "street"], ["lang", PLANG[lang] || "default"]];
  // Photon extent is [minLon, maxLat, maxLon, minLat]; bbox wants minLon,minLat,maxLon,maxLat
  if (city.extent) { const [a, b, c, d] = city.extent; params.push(["bbox", [a, d, c, b].join(",")]); }
  else params.push(["lat", String(city.lat)], ["lon", String(city.lng)]);
  const f = await photon(params, signal);
  return dedupe(f.map(x => {
    const p = x.properties;
    const street = p.street || p.name || "";
    return { name: [street, p.housenumber].filter(Boolean).join(" "), sub: [p.postcode, p.city || p.district].filter(Boolean).join(" "), lng: x.geometry.coordinates[0], lat: x.geometry.coordinates[1] };
  })).filter(x => x.name);
}
