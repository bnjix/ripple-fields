# Ripple field tiles

Makes the Wind and Swell layers of the Map in [Ripple](https://ripple.surf) ahead of time, from
[Open-Meteo](https://open-meteo.com)'s public model files (AWS Open Data, `openmeteo` bucket, `data_spatial/`).

For each model it takes the newest complete run and, for every forecast hour (hourly to 48 h, then every third hour to
the model's reach), writes one file holding that hour's whole pyramid of 64 × 64 map tiles, a table of their lengths at
the front, so a phone reads any tile with one HTTP Range request. A `latest.json` per model says the run, its hours,
the zooms and where the files are. Files go to Cloudflare R2 (served at `https://tiles.ripple.surf/fields/`):

    fields/<model>/latest.json                 short cache; written last
    fields/<model>/<run>/<YYYYMMDDHHMM>.rfp    immutable
    fields/<model>/making.json                 the run being made, and the runs to drop (not cached)

Two runs are kept: after a new run is up, the one before the previous is deleted. A run not yet complete on
Open-Meteo's side is left for the next time. `making.json` is written before the first hour file; if a job dies half
way, the next job finds the run there that is neither the latest nor the one before, and deletes its files (wrangler
cannot list a bucket, so the job keeps its own record of what it started).

| Model | Layer | Source | Hours | Zooms | Per hour | Per run |
|---|---|---|---|---|---|---|
| `ecmwf` | wind: east and north at 10 m, gusts, sea-level pressure, sea share | ECMWF IFS 9 km (`ecmwf_ifs`), every run | to day 7 (06/18 UTC runs: day 6), 89 files | 2–6, zoom 6 only over the sea and a coastal band | ~13.5 MB | ~1.2 GB |
| `gfswave` | swell: whole sea, swells 1–3, wind chop (height, period, direction) | NOAA GFS-Wave 0.25° (`ncep_gfswave025`), every run | to day 16, 161 files | 2–5, all-land tiles left out | ~11.8 MB | ~1.9 GB |
| `hrrr` | wind, as `ecmwf` | NOAA HRRR 3 km (`ncep_hrrr_conus`), 00/06/12/18 UTC runs only | to 48 h, 49 files | 2–8 inside HRRR's domain only, zoom 8 only over the sea and a coastal band | ~3.0–3.4 MB | ~0.16 GB |

HRRR's 00/06/12/18 UTC runs reach 48 h, the other hourly runs only 18 h. Made from every run, the map would reach
only 18 h ahead for five hours in six (tomorrow morning missing most of the day), so only the long runs are made; they
are at most about 8 h old. Its `latest.json` also carries `area`, the domain's latitude/longitude box
`[south, west, north, east]`; there are no tiles outside the domain, and tiles at its edge have no value (255) outside it.
HRRR's winds come along its own grid's axes, which turn with longitude on its cone; they are turned back to east and
north.

The tile and file formats are in `format.mjs`; Ripple's app reads them (its `src/v0/field/`). Since 20 Nov 2026 the
files are of a second version (`RFP2`): each zoom carries the box of tiles that can exist, and the table at the front
covers only those, so HRRR's table is 4.4 KB where the first version's world-wide table took 171 KB (ECMWF's 10.7 KB,
GFS-Wave's 2.7 KB, as before). `latest.json` carries the boxes too (`boxes`, per zoom from `zmin`: x0, x1, y0, y1), so the
phone asks for the whole head in one request; a `latest.json` without them points at files of the first version. The sea share comes from
Météo-France's wave model (`meteofrance_wave`, 1/12°, the Great Lakes included): where it has waves is sea. HRRR on
Open-Meteo's bucket has no land mask, so it uses the same one.

## Run

    npm ci
    node runs.mjs --model hrrr                   # would a run be made now? (no dependencies)
    node job.mjs --model hrrr --hours 2 --force --out out           # two hours, nothing uploaded: to measure
    node job.mjs --model gfswave --from 360 --hours 2 --force --out out   # two hours from 360 h on
    node job.mjs --upload --out out              # the newest runs, uploaded with wrangler

Uploading needs wrangler: `CLOUDFLARE_API_TOKEN` (allowed to write R2) and `CLOUDFLARE_ACCOUNT_ID`, or a logged-in
wrangler (`WRANGLER=/path/to/wrangler`). Uploads and deletes run four at a time beside the making of the next hours.

## Schedule

`.github/workflows/fields.yml` wakes every hour at :56, one job per model. Each job first runs `runs.mjs`, which only
reads two small JSON files; when storage already holds the newest complete run the job ends there, before installing
anything. A model's jobs never overlap: a wake while one is still running waits behind it (GitHub keeps at most one
waiting per model), and then usually finds nothing new.

GitHub turns off a public repository's schedules after 60 days without commits. Twice a month (the second cron) a
keep-alive job calls GitHub's API to enable the workflow again, with the default `GITHUB_TOKEN` given `actions: write`:
no extra secret and no commits.

## Licence

GPL-2.0-only (`LICENSE`), because it uses Open-Meteo's file reader, `@openmeteo/file-reader`, which is GPL-2.0. The
forecasts themselves are Open-Meteo's and the models' makers' (ECMWF, NOAA, Météo-France), under their own terms.
