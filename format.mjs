// The tile format Ripple's app reads (copied from the app's src/v0/field/catalog.ts on 18 Nov 2026; keep the two the
// same). A Web-Mercator tile z/x/y holds SIZE × SIZE samples, sample (i, j) at the centre of its cell; each variable is
// one plane of SIZE² bytes, NONE where there is no value; the planes follow each other and the whole is deflated (raw).

export const SIZE = 64;
export const NONE = 255;

const q = (v) => Math.max(0, Math.min(254, Math.round(v)));
const signed = (name, step) => ({ name, enc: (v) => q(v / step + 127) });
const plain = (name, lo, step) => ({ name, enc: (v) => q((v - lo) / step) });

/** Wind: m/s east and north at 10 m, gusts, sea-level pressure (hPa), and how much of the place is sea (0–1). */
export const WIND_PLANES = [signed('u', 0.5), signed('v', 0.5), plain('gust', 0, 0.5), plain('p', 930, 0.5), plain('sea', 0, 1 / 254)];
/** Swell: the whole sea, swells 1–3 (as the model numbers them, biggest first), the wind chop: height (m), period (s), from (°). */
const hpd = (k) => [plain(k + 'h', 0, 0.1), plain(k + 'p', 0, 0.1), plain(k + 'd', 0, 360 / 254)];
export const SWELL_PLANES = [...hpd('t'), ...hpd('s1'), ...hpd('s2'), ...hpd('s3'), ...hpd('w')];

/** 2026-11-18T12:00Z (unix s) → 202611181200. */
export const stamp = (s) => new Date(s * 1000).toISOString().slice(0, 16).replace(/[-:T]/g, '');

/** Longitude and latitude of a tile's sample (i, j), cell centres. */
export function sampleLonLat(z, x, y, i, j) {
  const n = 2 ** z, mx = (x + (i + 0.5) / SIZE) / n, my = (y + (j + 0.5) / SIZE) / n;
  return [mx * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI];
}

/**
 * The packed hour file: every tile of one forecast hour, zoom zmin to zmax, so the phone reads one tile with one HTTP
 * Range request. Two versions; the app reads both.
 *
 * "RFP2" (20 Nov 2026), written now. Each zoom has a box of the tiles that can exist (a regional model's area; the whole
 * world for the others), and the table covers only the boxes:
 *   bytes 0–3   "RFP2"
 *   byte  4, 5  zmin, zmax
 *   byte  6, 7  planes per tile, samples per side (64)
 *   then for every zoom from zmin up: x0, x1, y0, y1, uint16 little-endian each (inclusive; x0 > x1 when the zoom
 *   has none)
 *   then for every zoom from zmin up, row by row (y0..y1), left to right (x0..x1): the tile's length in bytes, uint16
 *   little-endian (0: no tile, all land or nothing to show), then the tiles themselves in the same order.
 * The boxes are also in latest.json (`boxes`), so the phone asks for the whole head at once.
 *
 * "RFP1" (19 Nov), runs made before: no boxes; the table covers every tile of every zoom (4^z each).
 */
export const tilesUpTo = (zmin, zmax) => { let n = 0; for (let z = zmin; z <= zmax; z++) n += 4 ** z; return n; };

/** The box of tiles touching a latitude/longitude area [south, west, north, east] at each zoom, or the whole world. */
export function boxesFor(zmin, zmax, area) {
  const out = [];
  for (let z = zmin; z <= zmax; z++) {
    const n = 2 ** z;
    if (!area) { out.push([0, n - 1, 0, n - 1]); continue; }
    const tx = (lon) => Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
    const ty = (lat) => { const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180); return Math.min(n - 1, Math.max(0, Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n))); };
    out.push([tx(area[1]), tx(area[3]), ty(area[2]), ty(area[0])]);
  }
  return out;
}
export const tilesIn = (boxes) => boxes.reduce((a, [x0, x1, y0, y1]) => a + Math.max(0, x1 - x0 + 1) * Math.max(0, y1 - y0 + 1), 0);
export const inBox = (b, x, y) => x >= b[0] && x <= b[1] && y >= b[2] && y <= b[3];

export function pack(zmin, zmax, planes, tiles /* Map "z/x/y" → Uint8Array */, boxes = boxesFor(zmin, zmax)) {
  const n = tilesIn(boxes), nz = zmax - zmin + 1, t0 = 8 + 8 * nz, head = Buffer.alloc(t0 + 2 * n), parts = [head];
  head.write('RFP2', 0, 'ascii'); head[4] = zmin; head[5] = zmax; head[6] = planes; head[7] = SIZE;
  boxes.forEach((b, i) => b.forEach((v, j) => head.writeUInt16LE(v, 8 + 8 * i + 2 * j)));
  let k = 0, put = 0;
  boxes.forEach(([x0, x1, y0, y1], i) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++, k++) {
      const t = tiles.get(`${zmin + i}/${x}/${y}`);
      if (!t) continue;
      if (t.length > 65535) throw new Error(`tile ${zmin + i}/${x}/${y} too long`);
      head.writeUInt16LE(t.length, t0 + 2 * k);
      parts.push(t); put++;
    }
  });
  if (put !== tiles.size) throw new Error(`${tiles.size - put} tiles outside the boxes`);
  return Buffer.concat(parts);
}
