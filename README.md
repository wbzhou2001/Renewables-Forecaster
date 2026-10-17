# HPCP Portal

A live solar (PV) adoption dashboard for Indianapolis. Every curve, band and
interval is recomputed **in the browser, from the installation records**, each
time a setting changes. Nothing is pre-rendered and there is no server.

This is the successor of the static
[EVPV-Dashboard](https://github.com/wbzhou2001/EVPV-Dashboard), which served
pre-generated PNGs per slider combination. It runs on three data sources, chosen
in the control panel: **synthetic** installation records drawn from the model
in the paper, the **real** desensitized Indianapolis records, or your own CSV
records.

> W. Zhou & S. Zhu, *Hierarchical Probabilistic Conformal Prediction for
> Distributed Energy Resources Adoption*, The Annals of Applied Statistics
> 20(2), 1626–1645 (2026). [doi:10.1214/26-AOAS2199](https://doi.org/10.1214/26-AOAS2199)
> · preprint [arXiv:2411.12193](https://arxiv.org/abs/2411.12193).

## Run it

Open `index.html` in a browser, or serve the folder with any static server and
open the page. GitHub Pages works as-is. There is no build step.

The page loads four things from the web: Open Sans (CMU's sans-serif) from
Google Fonts, KaTeX 0.16.9 and Leaflet 1.9.4 from cdnjs, and OpenStreetMap
tiles for the grid map base layer. KaTeX typesets every equation and number in
the browser, so no LaTeX installation is needed. Without a connection, fonts
fall back to system faces, math falls back to a Times-style text rendering, and
the grid map falls back to a schematic SVG view. Everything else is local.

All computation runs in the viewer's browser (in a Web Worker). There is no
server or paid API, so hosting is free static serving.

OpenStreetMap's main tile server refuses requests that carry no Referer, which
is what a page opened straight from disk (`file://`) sends. The page therefore
uses OSM France's Humanitarian (HOT) tiles when opened from disk, or when a probe
tile is refused, and the standard OSM tiles when served over http(s).

## What it computes

| Stage | Paper | Where | Re-runs when you change… |
|---|---|---|---|
| Synthetic grid and records, placed over Indianapolis for the base map: a multivariate Hawkes process with exponential growth, self-excitation, sibling-circuit excitation and spatial disparity | Eq. 5, §6.2 scale (≈1.7k records, 245 circuits, 51 substations, 2010–2024) | `engine.js` `buildSynthetic` | seed, generator |
| MLE fit by EM (closed-form ECM updates; exact β step including the compensator's boundary term) | Eq. 4 | `fitHawkes` | data, τ |
| Ogata thinning simulation | §4.2 | `simulate` | — |
| HPCP calibration: rolling windows after τ, sibling-aware score `min_m ‖S_k ⊙ (y − ỹ⁽ᵐ⁾)‖∞`, `S = CCᵀ` | Eq. 7, Alg. 1 | `calibrate` | τ, window, M |
| Conformal quantiles (optionally recency-weighted), circuit and substation intervals, Marginal / Joint / Bonferroni ablations, held-out coverage | Eq. 8, §6.1 | `evaluate` | confidence, recency weighting |
| Long-range scenarios to 2050: γ(t) = 1 before the tipping point, then shrinks with headroom to the penetration cap; growth rate drawn from its sampling error | Eq. 5 γ(t) | `longRange` | cap, tipping point, paths |

Results are cached per stage inside a Web Worker, so a slider move only reruns
what it affects. Typical full run: 1–3 s.

**Caveat:** the conformal guarantee applies only to the next-window intervals.
The 2050 band is a model-based Monte Carlo spread under the chosen saturation
scenario.

## Real data (`data/real/`)

Choose **Real** in the control panel to run the portal on the Indianapolis
installation records. The records were desensitized before publication:

| File | Contents |
|---|---|
| `records.csv` | 1,617 installations, 2000-08-21 to 2024-06-11: `date, circuit_id, substation_id, sector` (1,489 residential, 128 commercial; the one industrial installation is counted as commercial) |
| `topology.csv` | 374 circuits: `circuit_id, substation_id, lon, lat` |
| `substations.csv` | 49 substations: `substation_id, lon, lat, n_circuits` (reference only; the portal places each substation at the centre of its circuits) |
| `bundle.js` | `records.csv` + `topology.csv` packed for the portal; regenerate with `powershell -File data\real\build-bundle.ps1` after editing the CSVs |

How it was desensitized:

- **Names.** Circuit and substation names are replaced by random codes (`C###`, `S##`), assigned in random order. The key to the real names is kept private and is not in this repository.
- **Locations.** Each circuit's location is the centre of its utility poles plus independent Gaussian noise of 400 m per axis (median shift about 480 m). The same applies to substations. Pole positions and pole IDs are not published.
- **Installations.** Addresses, coordinates, customer and contract IDs, installers, equipment details and reviewer notes are removed. Exact timestamps are kept, and so is the sector, taken from the utility's IURC classification.
- **Customer counts** per circuit are not part of the data. The portal splits the **Total customers** setting evenly across circuits for penetration and the cap.

## Using your own data

Choose **Upload CSV** in the sidebar.

- **Records** (required): `date, circuit_id, substation_id[, sector]`. The date
  is any parseable date. A `sector` value containing "com" counts as
  commercial; everything else is residential.
- **Topology** (optional):
  `circuit_id, substation_id, residential_customers, commercial_customers[, lon, lat]`.
  Without it, customers are split evenly from the "total customers" box and the
  map uses a schematic layout.

**Download → Records** exports the current synthetic sample in exactly this
format, along with its topology.

## Files

```
index.html      page shell and the in-app README (all explanatory text)
css/style.css   CMU light and dark design tokens and layout
js/engine.js    all modelling (self-contained; run inside a blob Web Worker)
js/charts.js    dependency-free SVG charts with hover tooltips
js/app.js       controls, worker wiring, rendering, CSV import/export
data/real/      desensitized Indianapolis data (see "Real data" above)
```

When you release changes, bump the `?v=` tag on the CSS and JS links in
`index.html`, and on `bundle.js` in `js/app.js`. Otherwise returning visitors can
get the new page with cached old scripts for up to 10 minutes.

## Interface

- **Theme:** Carnegie Mellon colours, with a Carnegie Red accent on Iron
  Gray and white, and a dark mode. Data colours follow one rule: observed is
  gray, forecast and HPCP are red, and ablations are neutral gray with direct
  labels.
- **Control panel:** drag its right edge to resize it. Releasing it near the
  left edge snaps it shut and gives the dashboard the full width; drag or click
  the tab at the left edge to bring it back. Width and state are remembered.
  Every setting has a `?` button that explains it, with the math typeset.
- **README panel:** the in-app README explains how and where the predictions
  are computed, how to read the charts, the live calibration check, the method
  and the caveats. Setting descriptions live in the `?` buttons instead. It is hidden on load; open it with
  the README button.
- **CMU wordmark:** the header shows the name as typeset text in Open Sans,
  followed by the sun mark and the page title. To use the official logo artwork
  instead, swap the `.wordmark` span in `index.html` for an `<img>`.

## Citation

If you use this portal or its forecasts, please cite:

> Zhou, W., & Zhu, S. (2026). Hierarchical probabilistic conformal prediction for distributed energy resources adoption. *The Annals of Applied Statistics*, *20*(2), 1626–1645. https://doi.org/10.1214/26-AOAS2199
