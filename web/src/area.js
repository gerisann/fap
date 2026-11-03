/* Area scope helpers: a place outline (country / city from OSM via Nominatim, fetched once per pick)
   or a circle. contains() returns a fast (lng, lat) => boolean test with a bbox pre-check. */

const NOMINATIM = "https://nominatim.openstreetmap.org/lookup";

export async function placeGeometry(place, level, signal) {
  if (place.osm) {
    try {
      const u = new URL(NOMINATIM);
      u.search = new URLSearchParams({ osm_ids: place.osm, format: "geojson", polygon_geojson: "1", polygon_threshold: level === "country" ? "0.01" : "0.0005" });
      const r = await fetch(u, { signal });
      if (r.ok) { const g = (await r.json()).features?.[0]?.geometry; if (g && (g.type === "Polygon" || g.type === "MultiPolygon")) return g; }
    } catch (e) { if (e.name === "AbortError") throw e; }
  }
  // fallbacks: the place's bounding box, then a plain circle around it
  if (place.extent) { const [a, b, c, d] = place.extent; return { type: "Polygon", coordinates: [[[a, d], [c, d], [c, b], [a, b], [a, d]]] }; }
  return circle(place.lng, place.lat, level === "country" ? 200 : 10);
}

export function circle(lng, lat, km, n = 96) {
  const dLat = km / 111.32, dLng = km / (111.32 * Math.cos(lat * Math.PI / 180)), ring = [];
  for (let i = 0; i <= n; i++) { const a = i / n * 2 * Math.PI; ring.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]); }
  return { type: "Polygon", coordinates: [ring] };
}

export function distKm(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

const polysOf = g => g.type === "Polygon" ? [g.coordinates] : g.coordinates;

export function bbox(g) {
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  for (const p of polysOf(g)) for (const [x, y] of p[0]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function contains(g) {
  const [x0, y0, x1, y1] = bbox(g), polys = polysOf(g);
  return (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    for (const p of polys) if (inRing(x, y, p[0]) && !p.slice(1).some(h => inRing(x, y, h))) return true;
    return false;
  };
}
