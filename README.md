# Ripple field tiles

Makes the worldwide Wind and Swell layers of the Map in [Ripple](https://ripple.surf) ahead of time, from
[Open-Meteo](https://open-meteo.com)'s public model files (AWS Open Data, `openmeteo` bucket, `data_spatial/`).

For each model it takes the newest complete run and, for every forecast hour (hourly to 48 h, then every third hour to
day 7), writes one file holding that hour's whole pyramid of 64 × 64 map tiles, a table of their lengths at the front,
so a phone reads any tile with one HTTP Range request. A `latest.json` per model says the run, its hours, the zooms and
where the files are. Files go to Cloudflare R2 (served at `https://tiles.ripple.surf/fields/`):

    fields/<model>/latest.json                 short cache; written last
    fields/<model>/<run>/<YYYYMMDDHHMM>.rfp    immutable

Two runs are kept: after a new run is up, the one before the previous is deleted. A run not yet complete on
Open-Meteo's side is left for the next time.

| Model | Layer | Source | Zooms | Per hour |
|---|---|---|---|---|
| `ecmwf` | wind: east and north at 10 m, gusts, sea-level pressure, sea share | ECMWF IFS 9 km (`ecmwf_ifs`) | 2–6, zoom 6 only over the sea and a coastal band | ~13.5 MB |
| `gfswave` | swell: whole sea, swells 1–3, wind chop (height, period, direction) | NOAA GFS-Wave 0.25° (`ncep_gfswave025`) | 2–5, all-land tiles left out | ~11.6 MB |

The tile and file formats are in `format.mjs`; Ripple's app reads them (its `src/v0/field/`). The sea share comes from
Météo-France's wave model (`meteofrance_wave`, 1/12°): where it has waves is sea.

## Run

    npm ci
    node job.mjs --hours 1 --force --out out     # one hour of each model, nothing uploaded: to measure
    node job.mjs --upload --out out              # the newest runs, uploaded with wrangler

Uploading needs wrangler: `CLOUDFLARE_API_TOKEN` (allowed to write R2) and `CLOUDFLARE_ACCOUNT_ID`, or a logged-in
wrangler (`WRANGLER=/path/to/wrangler`). `.github/workflows/fields.yml` runs it four times a day.

## Licence

GPL-2.0-only (`LICENSE`), because it uses Open-Meteo's file reader, `@openmeteo/file-reader`, which is GPL-2.0. The
forecasts themselves are Open-Meteo's and the models' makers' (ECMWF, NOAA, Météo-France), under their own terms.
