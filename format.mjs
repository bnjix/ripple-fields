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
 * The packed hour file ("RFP1"): every tile of one forecast hour, zoom zmin to zmax, so the phone reads one tile with
 * one HTTP Range request.
 *   bytes 0–3   "RFP1"
 *   byte  4, 5  zmin, zmax
 *   byte  6, 7  planes per tile, samples per side (64)
 *   then for every zoom from zmin up, row by row (y), left to right (x): the tile's length in bytes, uint16 little-endian
 *   (0: no tile, all land or nothing to show), then the tiles themselves in the same order.
 * A tile's offset is 8 + 2 × (number of tiles) + the lengths of the tiles before it.
 */
export const tilesUpTo = (zmin, zmax) => { let n = 0; for (let z = zmin; z <= zmax; z++) n += 4 ** z; return n; };
export function pack(zmin, zmax, planes, tiles /* Map "z/x/y" → Uint8Array */) {
  const n = tilesUpTo(zmin, zmax), head = Buffer.alloc(8 + 2 * n), parts = [head];
  head.write('RFP1', 0, 'ascii'); head[4] = zmin; head[5] = zmax; head[6] = planes; head[7] = SIZE;
  let k = 0;
  for (let z = zmin; z <= zmax; z++) for (let y = 0; y < 2 ** z; y++) for (let x = 0; x < 2 ** z; x++, k++) {
    const t = tiles.get(`${z}/${x}/${y}`);
    if (!t) continue;
    if (t.length > 65535) throw new Error(`tile ${z}/${x}/${y} too long`);
    head.writeUInt16LE(t.length, 8 + 2 * k);
    parts.push(t);
  }
  return Buffer.concat(parts);
}
