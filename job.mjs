// Ripple's field job: the Map's worldwide Wind and Swell layers, made ahead (18 Nov 2026).
//
// For each model it reads the newest complete run from Open-Meteo's public model files on S3
// (https://openmeteo.s3.amazonaws.com/data_spatial/<model>/; which run: runs.mjs), and for every forecast hour (hourly
// to 48 h, then three-hourly to the model's reach: ECMWF day 7, GFS-Wave day 16, HRRR 48 h) writes ONE file holding
// that hour's whole tile pyramid (format.mjs), plus a small latest.json per model. The phone fetches a tile with an
// HTTP Range request. With --upload the files go to the R2 bucket behind tiles.ripple.surf under
// fields/<model>/<run>/, latest.json last; the run before the previous one is then deleted, so two runs are kept. A run
// that isn't complete yet is left for next time: the old one stays. A making.json written before the first file names
// the run being made, so files of a run whose job died half way are deleted by the next job.
//
//   node job.mjs [--model ecmwf|gfswave|hrrr|all] [--out DIR] [--hours N] [--from H] [--upload] [--force]
//
// --hours N makes only the first N hours, --from H only hours H and later (to measure); --force remakes a run already on the bucket.
// Uploads go through wrangler (env WRANGLER, else `npx wrangler`), which needs CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID in CI (or a logged-in wrangler on a laptop).
//
// Licence: GPL-2.0-only (LICENSE), as it uses Open-Meteo's file reader (@openmeteo/file-reader), GPL-2.0.
import { OmDataType, OmFileReader } from '@openmeteo/file-reader';
import { deflateRawSync } from 'node:zlib';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { NONE, SIZE, SWELL_PLANES, WIND_PLANES, boxesFor, pack, sampleLonLat, stamp, tilesIn } from './format.mjs';
import { MODELS, PUBLIC, decide, fileUrl, manifest, get as getOnce } from './runs.mjs';

const BUCKET = 'ripple-seafloor', PREFIX = 'fields';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i < 0 ? d : process.argv[i + 1]; };
const has = (k) => process.argv.includes(k);
const OUT = arg('--out', 'out'), ONLY = arg('--model', 'all'), MAXH = Number(arg('--hours', '9999')), FROMH = Number(arg('--from', '0')), UPLOAD = has('--upload'), FORCE = has('--force');

MODELS.gfswave.zmax = Number(arg('--swell-zmax', MODELS.gfswave.zmax));

/* ------------------------------------------------------------ reading Open-Meteo's files */

let downloaded = 0, requests = 0;
const get = async (url, range) => { const o = await getOnce(url, range); downloaded += o.b.length; requests++; return o; };
/** Byte ranges for the reader, gathered: the file's tail with the first request, near ranges merged, a megabyte read ahead. */
class RangeFile {
  constructor(url) { this.url = url; this.size = -1; this.spans = []; this.pending = []; }
  async count() {
    if (this.size >= 0) return this.size;
    const { r, b } = await get(this.url, 'bytes=-262144');
    this.size = Number((r.headers.get('content-range') ?? '').split('/')[1]);
    this.spans.push({ off: this.size - b.length, buf: b });
    return this.size;
  }
  find(off, n) { for (const s of this.spans) if (off >= s.off && off + n <= s.off + s.buf.length) return s.buf.subarray(off - s.off, off - s.off + n); return null; }
  async fetchSpan(a, b) { const { b: buf } = await get(this.url, `bytes=${a}-${b - 1}`); this.spans.push({ off: a, buf }); }
  async getBytes(off, n) {
    const hit = this.find(off, n); if (hit) return hit;
    await this.fetchSpan(off, Math.min(this.size, off + Math.max(n, 1 << 20)));
    return this.find(off, n);
  }
  async collectPrefetchTasks(off, n) { if (this.find(off, n)) return []; this.pending.push([off, off + n]); return [() => this.flush()]; }
  async flush() {
    if (this.flushing) return this.flushing;
    const ps = this.pending.sort((a, b) => a[0] - b[0]); this.pending = [];
    const merged = [];
    for (const [a, b] of ps) { const l = merged[merged.length - 1]; if (l && a - l[1] < 1 << 18 && b - l[0] < 32 << 20) l[1] = Math.max(l[1], b); else merged.push([a, b]); }
    this.flushing = (async () => { for (let i = 0; i < merged.length; i += 6) await Promise.all(merged.slice(i, i + 6).map(([a, b]) => this.fetchSpan(a, b))); })().finally(() => { this.flushing = null; });
    return this.flushing;
  }
  async close() { this.spans = []; }
}
/** Whole variables of one file, as Float32Arrays with their dimensions. */
async function readVars(url, names) {
  const file = new RangeFile(url), rd = await OmFileReader.create(file), out = {};
  for (let i = 0; i < rd.numberOfChildren(); i++) {
    const c = await rd.getChild(i), nm = c.getName();
    if (!names.includes(nm)) continue;
    const dims = c.getDimensions().map(Number);
    out[nm] = { dims, data: await c.read({ type: OmDataType.FloatArray, ranges: dims.map((d) => ({ start: 0, end: d })), ioSizeMax: BigInt(64 << 20), ioSizeMerge: BigInt(1 << 18) }) };
  }
  file.spans = [];
  return out;
}

/* ------------------------------------------------------------ sampling (as functions/_field.ts does on the server) */

/** A regular latitude/longitude grid from its manifest: bilinear at a place over the corners that have a value. */
function regular(man, dims) {
  const [s, w, n, e] = /BBOX\[([^\]]*)\]/.exec(man.crs_wkt)[1].split(',').map(Number), ny = dims[0], nx = dims[1];
  const dlat = (n - s) / (ny - 1), dlon = (e - w) / (nx - 1), wrap = Math.abs(e - w + dlon - 360) < dlon / 2;
  /** Four corner indices and weights at a place, or null outside. */
  return (lat, lon, idx, wt) => {
    const fr = (lat - s) / dlat; let fc = (lon - w) / dlon;
    if (wrap) fc = ((fc % nx) + nx) % nx;
    if (!(fr >= -0.5 && fr <= ny - 0.5) || (!wrap && !(fc >= -0.5 && fc <= nx - 0.5))) return false;
    const r = Math.floor(fr), c = Math.floor(fc), a = fr - r, b = fc - c;
    const col = (cc) => (wrap ? ((cc % nx) + nx) % nx : Math.max(0, Math.min(nx - 1, cc))), row = (rr) => Math.max(0, Math.min(ny - 1, rr));
    idx[0] = row(r) * nx + col(c); wt[0] = (1 - a) * (1 - b);
    idx[1] = row(r) * nx + col(c + 1); wt[1] = (1 - a) * b;
    idx[2] = row(r + 1) * nx + col(c); wt[2] = a * (1 - b);
    idx[3] = row(r + 1) * nx + col(c + 1); wt[3] = a * b;
    return true;
  };
}
/** ECMWF's reduced Gaussian grid O1280: rings from the north pole south, ring r from the nearer pole 4r + 16 points from 0° east. */
function gaussian() {
  const R = 2560, half = R / 2, dl = 180 / R, pts = (k) => 4 * (k < half ? k + 1 : R - k) + 16, start = new Float64Array(R + 1);
  for (let k = 0; k < R; k++) start[k + 1] = start[k] + pts(k);
  return (lat, lon, idx, wt) => {
    const f = Math.max(0, Math.min(R - 1.0001, (90 - lat) / dl - 0.5)), k0 = Math.floor(f), a = f - k0, l = ((lon % 360) + 360) % 360;
    for (let q = 0; q < 2; q++) {
      const k = k0 + q, n = pts(k), g = (l / 360) * n, j = Math.floor(g), b = g - j, wr = q ? a : 1 - a;
      idx[2 * q] = start[k] + (j % n); wt[2 * q] = wr * (1 - b);
      idx[2 * q + 1] = start[k] + ((j + 1) % n); wt[2 * q + 1] = wr * b;
    }
    return true;
  };
}
/**
 * NOAA's HRRR grid (Lambert conformal on a sphere, both standard parallels the same, origin at the equator), its first
 * square at the manifest's south-west corner. Also the angle its winds are turned by (they run along the grid's own
 * axes, which turn with longitude on the cone) and the domain's latitude/longitude box, from walking its edge.
 */
function lambert(man, dims) {
  const wkt = man.crs_wkt, num = (k, d) => Number(new RegExp(`${k}",?\\s*([-\\d.]+)`).exec(wkt)?.[1] ?? d);
  const R = num('Sphere', 6371229), p1 = (num('Latitude of 1st standard parallel', 38.5) * Math.PI) / 180, lon0 = num('Longitude of false origin', -97.5);
  const n = Math.sin(p1), FR = (R * Math.cos(p1) * Math.pow(Math.tan(Math.PI / 4 + p1 / 2), n)) / n, rho0 = FR;
  const xy = (lat, lon) => { const rho = FR / Math.pow(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360), n), th = n * ((((lon - lon0 + 540) % 360) - 180) * Math.PI) / 180; return [rho * Math.sin(th), rho0 - rho * Math.cos(th)]; };
  const ll = (x, y) => { const rho = Math.hypot(x, rho0 - y), th = Math.atan2(x, rho0 - y); return [(2 * Math.atan(Math.pow(FR / rho, 1 / n)) - Math.PI / 2) * 180 / Math.PI, lon0 + (th / n) * 180 / Math.PI]; };
  const [s, w, nn, e] = /BBOX\[([^\]]*)\]/.exec(wkt)[1].split(',').map(Number), ny = dims[0], nx = dims[1];
  const [x0, y0] = xy(s, w), [x1, y1] = xy(nn, e), dx = (x1 - x0) / (nx - 1), dy = (y1 - y0) / (ny - 1);
  const area = [90, 180, -90, -180];
  for (let k = 0; k <= 2 * (nx + ny); k++) {
    const [c, r] = k <= nx ? [k, 0] : k <= nx + ny ? [nx - 1, k - nx] : k <= 2 * nx + ny ? [2 * nx + ny - k, ny - 1] : [0, 2 * (nx + ny) - k];
    const [la, lo] = ll(x0 + Math.min(c, nx - 1) * dx, y0 + Math.min(r, ny - 1) * dy);
    area[0] = Math.min(area[0], la); area[1] = Math.min(area[1], lo); area[2] = Math.max(area[2], la); area[3] = Math.max(area[3], lo);
  }
  const at = (lat, lon, idx, wt) => {
    const [x, y] = xy(lat, lon), fr = (y - y0) / dy, fc = (x - x0) / dx;
    if (!(fr >= -0.5 && fr <= ny - 0.5 && fc >= -0.5 && fc <= nx - 0.5)) return false;
    const r = Math.floor(fr), c = Math.floor(fc), a = fr - r, b = fc - c;
    const col = (cc) => Math.max(0, Math.min(nx - 1, cc)), row = (rr) => Math.max(0, Math.min(ny - 1, rr));
    idx[0] = row(r) * nx + col(c); wt[0] = (1 - a) * (1 - b);
    idx[1] = row(r) * nx + col(c + 1); wt[1] = (1 - a) * b;
    idx[2] = row(r + 1) * nx + col(c); wt[2] = a * (1 - b);
    idx[3] = row(r + 1) * nx + col(c + 1); wt[3] = a * b;
    return true;
  };
  return Object.assign(at, { area: area.map((v, i) => (i < 2 ? Math.floor(v * 100) : Math.ceil(v * 100)) / 100), turn: (lon) => (n * ((((lon - lon0 + 540) % 360) - 180) * Math.PI)) / 180 });
}
/** Bilinear from four taps, leaving out corners with no value: none if they hold under a third of the weight. */
function mixAt(d, idx, wt) { let s = 0, w = 0; for (let q = 0; q < 4; q++) { const v = d[idx[q]]; if (!Number.isFinite(v)) continue; s += v * wt[q]; w += wt[q]; } return w > 0.34 ? s / w : NaN; }

/** Where a tile's samples fall on a grid: 4 indices and weights per sample (NaN-free), or -1 outside. */
function tapsFor(at, z, x, y) {
  const N = SIZE * SIZE, idx = new Int32Array(N * 4).fill(-1), wt = new Float32Array(N * 4), i4 = new Int32Array(4), w4 = new Float32Array(4);
  for (let j = 0; j < SIZE; j++) for (let i = 0; i < SIZE; i++) {
    const [lo, la] = sampleLonLat(z, x, y, i, j), k = j * SIZE + i;
    if (!at(la, lo, i4, w4)) continue;
    for (let q = 0; q < 4; q++) { idx[k * 4 + q] = i4[q]; wt[k * 4 + q] = w4[q]; }
  }
  return { idx, wt };
}
function mixTile(d, T, mask) {
  const N = SIZE * SIZE, out = new Float32Array(N), i4 = new Int32Array(4), w4 = new Float32Array(4);
  for (let k = 0; k < N; k++) {
    if (T.idx[k * 4] < 0) { out[k] = NaN; continue; }
    for (let q = 0; q < 4; q++) { const ix = T.idx[k * 4 + q]; i4[q] = ix; w4[q] = mask && !(mask[ix] > 0.05) ? 0 : T.wt[k * 4 + q]; }
    out[k] = mixAt(d, i4, w4);
  }
  return out;
}
function mixDirTile(d, h, T) {
  const N = SIZE * SIZE, out = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    let sx = 0, sy = 0, w = 0;
    for (let q = 0; q < 4; q++) {
      const ix = T.idx[k * 4 + q]; if (ix < 0) continue;
      const v = d[ix], hh = h[ix];
      if (!Number.isFinite(v) || !(hh > 0.05)) continue;
      const a = (v * Math.PI) / 180, ww = T.wt[k * 4 + q] * Math.max(0.05, hh);
      sx += Math.sin(a) * ww; sy += Math.cos(a) * ww; w += T.wt[k * 4 + q];
    }
    out[k] = w > 0 ? ((Math.atan2(sx, sy) * 180) / Math.PI + 360) % 360 : NaN;
  }
  return out;
}

/* ------------------------------------------------------------ the tiles */

const N2 = SIZE * SIZE;
/** One wind tile's bytes (deflated), or null to leave it out. */
function windTile(V, seaAt, at, z, x, y, zmax) {
  // the finest zoom only over the sea and a coastal band (inland the coarser tile carries on)
  if (z === zmax && !nearSea(seaAt, z, x, y)) return null;
  const T = tapsFor(at, z, x, y);
  if (at.area && T.idx.every((i) => i < 0)) return null;   // a regional model: nothing of it in this tile
  const S = tapsFor(seaAt.at, z, x, y);
  const u = mixTile(V.u, T), v = mixTile(V.v, T), g = V.gust ? mixTile(V.gust, T) : null, p = V.p ? mixTile(V.p, T) : null;
  // winds along the grid's own axes (HRRR) turned back to east and north
  if (at.turn) for (let j = 0; j < SIZE; j++) for (let i = 0; i < SIZE; i++) {
    const k = j * SIZE + i, a = at.turn(sampleLonLat(z, x, y, i, j)[0]), c = Math.cos(a), sn = Math.sin(a), uu = u[k], vv = v[k];
    u[k] = uu * c + vv * sn; v[k] = -uu * sn + vv * c;
  }
  const sea = new Float32Array(N2);
  for (let k = 0; k < N2; k++) { let s = 0, w = 0; for (let q = 0; q < 4; q++) { const ix = S.idx[k * 4 + q]; if (ix < 0) continue; s += seaAt.mask[ix] * S.wt[k * 4 + q]; w += S.wt[k * 4 + q]; } sea[k] = w ? s / w : 0; }
  const out = new Uint8Array(N2 * WIND_PLANES.length).fill(NONE);
  for (let k = 0; k < N2; k++) {
    if (!Number.isFinite(u[k]) || !Number.isFinite(v[k])) continue;
    out[k] = WIND_PLANES[0].enc(u[k]); out[N2 + k] = WIND_PLANES[1].enc(v[k]);
    if (g && Number.isFinite(g[k])) out[2 * N2 + k] = WIND_PLANES[2].enc(g[k]);
    if (p && Number.isFinite(p[k])) out[3 * N2 + k] = WIND_PLANES[3].enc(p[k] > 2000 ? p[k] / 100 : p[k]);
    out[4 * N2 + k] = WIND_PLANES[4].enc(sea[k]);
  }
  return deflateRawSync(out);
}
/** Any sea within the tile or a quarter of a tile round it (16 × 16 looks); the same every hour, so kept. */
const nearSeen = new Map();
function nearSea(seaAt, z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (!nearSeen.has(key)) nearSeen.set(key, nearSeaNow(seaAt, z, x, y));
  return nearSeen.get(key);
}
function nearSeaNow(seaAt, z, x, y) {
  const i4 = new Int32Array(4), w4 = new Float32Array(4), n = 2 ** z;
  for (let j = -2; j <= 17; j++) for (let i = -2; i <= 17; i++) {
    const mx = (x + i / 16) / n, my = Math.max(0, Math.min(1, (y + j / 16) / n));
    const lon = mx * 360 - 180, lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI;
    if (!seaAt.at(lat, lon, i4, w4)) continue;
    for (let q = 0; q < 4; q++) if (seaAt.mask[i4[q]] > 0.5) return true;
  }
  return false;
}
const SWELL_VARS = [['wave_height', 'wave_period', 'wave_direction'], ['swell_wave_height', 'swell_wave_period', 'swell_wave_direction'], ['secondary_swell_wave_height', 'secondary_swell_wave_period', 'secondary_swell_wave_direction'], ['tertiary_swell_wave_height', 'tertiary_swell_wave_period', 'tertiary_swell_wave_direction'], ['wind_wave_height', 'wind_wave_period', 'wind_wave_direction']];
/** One swell tile's bytes, or null if it is all land. */
function swellTile(V, at, z, x, y) {
  const T = tapsFor(at, z, x, y), out = new Uint8Array(N2 * SWELL_PLANES.length).fill(NONE);
  let any = false;
  SWELL_VARS.forEach(([hn, pn, dn], gi) => {
    const H = V[hn], P = V[pn], D = V[dn];
    if (!H || !P || !D) return;
    const hh = mixTile(H, T), pp = mixTile(P, T, H), dd = mixDirTile(D, H, T), base = gi * 3 * N2;
    for (let k = 0; k < N2; k++) {
      if (!Number.isFinite(hh[k])) continue;
      any = true;
      out[base + k] = SWELL_PLANES[0].enc(hh[k]);
      if (Number.isFinite(pp[k])) out[base + N2 + k] = SWELL_PLANES[1].enc(pp[k]);
      if (Number.isFinite(dd[k])) out[base + 2 * N2 + k] = SWELL_PLANES[2].enc(dd[k]);
    }
  });
  return any ? deflateRawSync(out) : null;
}

/* ------------------------------------------------------------ the run */

/** Hourly to 48 h, then every third hour to the model's reach (or the model's own steps where coarser). */
const pickTimes = (run, times, reach) => times.filter((t) => { const h = (t - run) / 3600; return h >= 0 && h <= reach && (h <= 48 || h % 3 === 0); });
let wranglerBin = process.env.WRANGLER;
/** One wrangler command, tried three times. */
async function wrangler(...a) {
  const cmd = wranglerBin ?? 'npx', args = wranglerBin ? a : ['--yes', 'wrangler', ...a];
  for (let k = 0; ; k++) {
    try { return await new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 1 << 24 }, (e) => (e ? rej(e) : res()))); } catch (e) { if (k >= 2) throw e; }
  }
}
const put = (key, file, type, cache) => wrangler('r2', 'object', 'put', `${BUCKET}/${PREFIX}/${key}`, '--file', file, '--content-type', type, '--cache-control', cache, '--remote');
const del = (key) => wrangler('r2', 'object', 'delete', `${BUCKET}/${PREFIX}/${key}`, '--remote').catch(() => { /* gone already */ });
/** Uploads and deletes run a few at a time beside the making of the next hours (each wrangler call is mostly waiting). */
const busy = new Set();
let upFailed = null;
async function soon(p) {
  const q = p.catch((e) => { upFailed ??= e; }).finally(() => busy.delete(q));
  busy.add(q);
  while (busy.size >= 4) await Promise.race(busy);
  if (upFailed) throw upFailed;
}
async function settled() { await Promise.all(busy); if (upFailed) throw upFailed; }

let peakRss = 0;
const rss = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };
setInterval(rss, 200).unref();

async function seaMask() {
  const m = await manifest('meteofrance_wave'), run = Date.parse(m.reference_time) / 1000, t = Date.parse(m.valid_times[0]) / 1000;
  const v = (await readVars(fileUrl('meteofrance_wave', run, t), ['wave_height'])).wave_height;
  const mask = new Float32Array(v.data.length);
  for (let k = 0; k < mask.length; k++) mask[k] = Number.isFinite(v.data[k]) ? 1 : 0;
  return { mask, at: regular(m, v.dims) };
}

/** Every hour file of a run {run, times} deleted from storage. */
const dropRun = async (id, r) => { for (const t of r.times) await soon(del(`${id}/${r.run}/${stamp(t)}.rfp`)); await settled(); };

async function doModel(id) {
  await Promise.all(busy); upFailed = null;
  const M = MODELS[id], d = await decide(id, FORCE);
  if (!d.make) { console.log(id, d.why); return; }
  const { man, run, cur } = d, runS = stamp(run);
  const times = pickTimes(run, man.valid_times.map((t) => Date.parse(t) / 1000), M.hours).filter((t) => t - run >= FROMH * 3600).slice(0, MAXH);
  console.log(id, 'run', runS, times.length, 'hours, zoom', M.zmin, 'to', M.zmax);
  // after this run: it is latest and the one there now its prev; any other run's files go
  const prev = cur && cur.run !== runS ? { run: cur.run, times: cur.times } : cur?.prev ?? null;
  const keep = (r) => r && (r.run === runS || r.run === prev?.run);
  const making = { run: runS, times, drop: [cur, cur?.prev].filter((r) => r && !keep(r)).map((r) => ({ run: r.run, times: r.times })) };
  mkdirSync(join(OUT, PREFIX, id), { recursive: true });
  const makingPath = join(OUT, PREFIX, id, 'making.json');
  if (UPLOAD) {
    // a job that died half way left its making.json: what it was making, and what it was to drop
    const was = await fetch(`${PUBLIC}${id}/making.json`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    for (const r of was ? [was, ...(was.drop ?? [])] : []) if (r.run && !keep(r) && !making.drop.some((q) => q.run === r.run)) { console.log(id, 'dropping files left by an earlier job:', r.run); await dropRun(id, r); }
    writeFileSync(makingPath, JSON.stringify(making));
    await put(`${id}/making.json`, makingPath, 'application/json', 'no-store');
  }
  const seaAt = M.layer === 'wind' ? await seaMask() : null;
  const dir = join(OUT, PREFIX, id, runS);
  mkdirSync(dir, { recursive: true });
  let at = null, boxes = null, total = 0;
  const t0 = Date.now(), c0 = process.cpuUsage();
  for (const time of times) {
    const d0 = downloaded, h0 = Date.now(), hc = process.cpuUsage();
    const names = M.layer === 'wind' ? ['wind_u_component_10m', 'wind_v_component_10m', 'wind_gusts_10m', 'pressure_msl'] : SWELL_VARS.flat();
    const raw = await readVars(fileUrl(M.file, run, time), names);
    const first = Object.values(raw)[0];
    at ??= M.file === 'ecmwf_ifs' ? gaussian() : /Lambert Conic/.test(man.crs_wkt) ? lambert(man, first.dims) : regular(man, first.dims);
    const V = M.layer === 'wind' ? { u: raw.wind_u_component_10m?.data, v: raw.wind_v_component_10m?.data, gust: raw.wind_gusts_10m?.data, p: raw.pressure_msl?.data } : Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.data]));
    if (M.layer === 'wind' && (!V.u || !V.v)) throw new Error(`no wind in ${stamp(time)}`);
    const tiles = new Map();
    // the tiles that can exist at each zoom: the whole world, or a regional model's area (the file's table covers only these)
    boxes ??= boxesFor(M.zmin, M.zmax, at.area);
    for (let z = M.zmin; z <= M.zmax; z++) for (let y = boxes[z - M.zmin][2]; y <= boxes[z - M.zmin][3]; y++) for (let x = boxes[z - M.zmin][0]; x <= boxes[z - M.zmin][1]; x++) {
      const b = M.layer === 'wind' ? windTile(V, seaAt, at, z, x, y, M.zmax) : swellTile(V, at, z, x, y);
      if (b) tiles.set(`${z}/${x}/${y}`, b);
    }
    const buf = pack(M.zmin, M.zmax, (M.layer === 'wind' ? WIND_PLANES : SWELL_PLANES).length, tiles, boxes), name = `${stamp(time)}.rfp`, path = join(dir, name);
    writeFileSync(path, buf);
    total += buf.length;
    const cpu = process.cpuUsage(hc);
    rss();
    let wait = 0;
    if (UPLOAD) { const u0 = Date.now(); await soon(put(`${id}/${runS}/${name}`, path, 'application/octet-stream', 'public, max-age=31536000, immutable').then(() => rmSync(path))); wait = Date.now() - u0; }
    console.log(`${id} ${stamp(time)} tiles ${tiles.size} file ${(buf.length / 1e6).toFixed(2)} MB  download ${((downloaded - d0) / 1e6).toFixed(1)} MB  cpu ${((cpu.user + cpu.system) / 1e6).toFixed(1)} s  wall ${((Date.now() - h0) / 1000).toFixed(1)} s${UPLOAD ? `  waited for uploads ${(wait / 1000).toFixed(1)} s` : ''}  peak ${(peakRss / 1e6).toFixed(0)} MB`);
  }
  if (UPLOAD) await settled();   // every hour file up before the pointer moves
  const cpu = process.cpuUsage(c0);
  if (boxes) console.log(`${id} table ${((8 * boxes.length + 2 * tilesIn(boxes)) / 1024).toFixed(1)} KB a file`);
  console.log(`${id} run ${runS}: ${times.length} files, ${(total / 1e9).toFixed(2)} GB, cpu ${((cpu.user + cpu.system) / 1e6).toFixed(0)} s, wall ${((Date.now() - t0) / 1000).toFixed(0)} s, peak ${(peakRss / 1e6).toFixed(0)} MB`);
  // the pointer, last; the run before the previous one goes
  // area: a regional model's latitude/longitude box [south, west, north, east] (no tiles outside it)
  const latest = { model: id, run: runS, times, zmin: M.zmin, zmax: M.zmax, ...(at?.area ? { area: at.area } : {}), boxes, planes: (M.layer === 'wind' ? WIND_PLANES : SWELL_PLANES).length, path: `${id}/${runS}/`, made: Math.round(Date.now() / 1000), prev };
  writeFileSync(join(OUT, PREFIX, id, 'latest.json'), JSON.stringify(latest));
  if (UPLOAD) {
    await put(`${id}/latest.json`, join(OUT, PREFIX, id, 'latest.json'), 'application/json', 'public, max-age=300');
    for (const r of making.drop) await dropRun(id, r);
    // done: nothing left to drop
    writeFileSync(makingPath, JSON.stringify({ run: runS, times, drop: [] }));
    await put(`${id}/making.json`, makingPath, 'application/json', 'no-store');
    console.log(id, 'uploaded; dropped run', making.drop.map((r) => r.run).join(', ') || 'none');
  }
}

for (const id of ONLY === 'all' ? Object.keys(MODELS) : [ONLY]) {
  try { await doModel(id); } catch (e) { console.error(id, 'failed:', e.message); process.exitCode = 1; }
}
