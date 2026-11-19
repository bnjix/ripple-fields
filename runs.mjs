// Which run of a model to make, and whether storage already has it. No dependencies, so the workflow can ask before it
// installs anything:
//
//   node runs.mjs --model hrrr        prints the decision; in GitHub Actions also writes make=true|false to the step's
//                                     outputs (GITHUB_OUTPUT), which gates the install and the job.
//
// job.mjs uses the same functions, so the two never disagree.

export const S3 = 'https://openmeteo.s3.amazonaws.com/data_spatial/';
// FIELDS_PUBLIC: another place to read storage's latest.json and making.json from (to test)
export const PUBLIC = process.env.FIELDS_PUBLIC ?? 'https://tiles.ripple.surf/fields/';

/**
 * What we make, per model. Zooms by the data's own detail: a 64-sample tile's sample is 40,075 km / 2^z / 64 at the
 * equator (zoom 6: 9.8 km, 8: 2.4 km, about 1.9 km at 38° N). Hours: hourly to 48 h, then every third hour to `hours`.
 * `every`: make only runs starting at multiples of this many hours (UTC), not every run the bucket marks latest.
 */
export const MODELS = {
  ecmwf: { layer: 'wind', file: 'ecmwf_ifs', zmin: 2, zmax: 6, hours: 168 },
  gfswave: { layer: 'swell', file: 'ncep_gfswave025', zmin: 2, zmax: 5, hours: 384 },
  // HRRR's 00/06/12/18 UTC runs reach 48 h, the others 18 h: only the long ones (see README.md)
  hrrr: { layer: 'wind', file: 'ncep_hrrr_conus', zmin: 2, zmax: 8, hours: 48, every: 6 },
};

/** A URL fetched with a few tries; a 404 at once. */
export async function get(url, range) {
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(url, { headers: range ? { range } : {} });
      if (r.ok) return { r, b: new Uint8Array(await r.arrayBuffer()) };
      if (r.status === 404 || a >= 3) throw new Error(`${r.status} ${url}`);
    } catch (e) { if (a >= 3 || /^404 /.test(e.message)) throw e; }
    await new Promise((res) => setTimeout(res, 1000 * (a + 1)));
  }
}
const json = (b) => JSON.parse(new TextDecoder().decode(b).replace(/[\n\r\t]/g, ' '));
/** A model's latest.json on Open-Meteo's bucket: the newest complete run. */
export const manifest = async (file) => json((await get(`${S3}${file}/latest.json`)).b);

const pad = (n) => String(n).padStart(2, '0');
const runDir = (file, run) => { const r = new Date(run * 1000); return `${S3}${file}/${r.getUTCFullYear()}/${pad(r.getUTCMonth() + 1)}/${pad(r.getUTCDate())}/${pad(r.getUTCHours())}00Z/`; };
/** The file of one forecast hour: run and time as unix seconds. */
export function fileUrl(file, run, time) {
  const t = new Date(time * 1000);
  return `${runDir(file, run)}${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}.om`;
}

/** 2026-11-18T12:00Z (unix s) → 202611181200. */
export const stamp = (s) => new Date(s * 1000).toISOString().slice(0, 16).replace(/[-:T]/g, '');

/**
 * The newest complete run to make: { man, run } (man as latest.json: reference_time, valid_times, crs_wkt), or
 * { wait } when it isn't complete yet. With `every`, the newest run starting on that step, from its own meta.json.
 */
export async function newestRun(id) {
  const M = MODELS[id], man = await manifest(M.file);
  let run = Date.parse(man.reference_time) / 1000;
  if (!M.every || (run / 3600) % M.every === 0) return man.completed ? { man, run } : { wait: man.reference_time };
  run = Math.floor(run / 3600 / M.every) * M.every * 3600;
  const meta = await get(`${runDir(M.file, run)}meta.json`).then(({ b }) => json(b)).catch(() => null);
  if (!meta?.completed) return { wait: new Date(run * 1000).toISOString() };
  return { man: { ...man, ...meta }, run };
}

/** What storage holds now: tiles.ripple.surf's latest.json for the model, or null. */
export const current = (id) => fetch(`${PUBLIC}${id}/latest.json`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

/** Whether to make a run now: { make, why, man?, run?, cur }. */
export async function decide(id, force = false) {
  if (!MODELS[id]) throw new Error(`no model ${id}`);
  const [n, cur] = await Promise.all([newestRun(id), current(id)]);
  if (n.wait) return { make: false, why: `run ${n.wait} not complete yet: left for next time`, cur };
  const runS = stamp(n.run);
  if (cur?.run === runS && !force) return { make: false, why: `already has run ${runS}`, cur };
  if (cur?.run > runS && !force) return { make: false, why: `has a newer run ${cur.run} than ${runS}`, cur };
  return { make: true, why: `run ${runS} to make`, ...n, cur };
}

// run directly: the workflow's pre-check
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--model'), id = i < 0 ? null : process.argv[i + 1];
  let make = true, why = 'check failed: making it to be safe';
  try { ({ make, why } = await decide(id, process.argv.includes('--force'))); } catch (e) { why = `${why} (${e.message})`; if (!MODELS[id]) { console.error(e.message); process.exit(1); } }
  console.log(id, why);
  if (process.env.GITHUB_OUTPUT) (await import('node:fs')).appendFileSync(process.env.GITHUB_OUTPUT, `make=${make}\n`);
}
