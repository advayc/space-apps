# GQ Atlas Space Apps submission

**Title** — GQ Atlas

**Team name** — The Sonic Waves

**Challenge** — 2026 NASA Space Apps Challenge, [Be An Earth System Trend Detective!](https://www.spaceappschallenge.org/2026/challenges/earth-system-trend-detective/)

**Link to final project** — [GQ Atlas](https://space.advay.ca/) and [source code](https://github.com/advayc/space-apps). The public site is up. Publish this checkout before using the public URL to demonstrate Compare.

**Link to project demo** — Add the public URL of the finished slide deck or demo video. The walkthrough below is ready to record from this checkout.

## Summary

GQ Atlas is a browser tool for exploring regional climate records. Choose a variable and two places, then compare their anomalies or trends using the same year and period. In our NASA GISTEMP example, the Canadian Arctic grid cell was 3.45 °C above its local baseline in 2025 and the Toronto cell was 1.01 °C above its own, a difference of 2.44 °C. The atlas shows where the two places differ and helps users check whether the primary cell’s longer trend is statistically significant.

## Detailed project description

### What did you develop

We built an interactive world map and globe for exploring 18 Earth science variables, including surface temperature, precipitation, sea ice, and atmospheric water vapor. A user can search for a city or select a grid cell, move the timeline, and inspect that cell’s record. Compare adds a second cell, marks both on the map, and puts their records on one chart. The panel displays both values and the primary value minus the comparison value. The chart can be downloaded alongside the map, and the primary series and fit statistics are available as CSV and JSON.

### How does it address the challenge

The layer selector answers *what* is changing, the map answers *where*, and the chart and fitted slope show *how much*. The primary cell’s 95% confidence interval and p-value help users judge whether its trend meets a 5% significance threshold. Both cells share the layer, period, and date. When both have complete records over the same 30 measured years, the panel reports their fitted rates.

### How does it work

A place resolves to the grid cell containing its coordinates. The browser reads that cell’s history from the same gridded dataset used to color the map. A monthly view tracks the same calendar month across years. Seasonal and annual views weight each month by its number of days and require complete periods. Anomalies use each cell’s own baseline for the selected product and period. The value in the 30-year trend view is a slope per decade over the window ending in the selected year.

The trend uses ordinary least squares on 30 consecutive values. The primary cell’s uncertainty uses a Newey–West standard error with three lags and an approximate two-sided normal test. The rates shown side by side describe the fitted slopes. The p-value tests the primary cell’s slope against zero. Projected dates compare the central estimates from both cells, and the chart retains the prediction band for the primary cell when available. These estimates extrapolate past records. [Data and methods](https://space.advay.ca/data-and-methods/) · [Projection formulas and hindcasts](https://space.advay.ca/projections/)

### Why is it important and what do you hope to achieve

People often encounter a global climate number before they see what a dataset says about places they know. We want students and curious readers to start with a familiar location, compare it with another region, and explain what they can conclude from the data. Showing the anomaly, long-term trend, and statistical uncertainty together helps them distinguish an unusual year from a sustained change.

### What tools did you use

We used HTML, CSS, and JavaScript with Canvas and SVG for the browser interface, D3 Geo and D3 Array for geographic work, and TopoJSON Client for packaged map geometry. Python, NumPy, and netCDF4 prepare the source grids as compressed binary assets. Git and GitHub hold the source, and Vercel serves the static site. We developed and tested on a laptop and used Chrome for browser verification. The app runs in a browser on ordinary computers and phones.

## NASA data

**NASA Goddard Institute for Space Studies Surface Temperature Analysis v4, Land–Ocean Temperature Index.** Atlas uses `tempanomaly` from the monthly 2° × 2° gridded product with 1,200 km smoothing. NASA combines NOAA GHCN v4 land air temperature records with NOAA ERSST v5 sea surface temperature estimates. The values are deviations in °C from 1951–1980. The Atlas snapshot has complete annual periods from 1880 through 2025. It uses the grid to color the surface temperature map, power both place histories, and calculate regional trends. The landing chart uses an area-weighted mean of the same annual grid. [NASA GISS product](https://data.giss.nasa.gov/gistemp/data_v4.html) · [Exact NetCDF download](https://data.giss.nasa.gov/pub/gistemp/gistemp1200_GHCNv4_ERSSTv5.nc.gz) · [GISTEMP v4 methods paper](https://doi.org/10.1029/2018JD029522)

## Other data and credits

| Product | Atlas layers | Complete annual record in Atlas |
| --- | --- | --- |
| [NOAA PSL GPCP v2.3](https://psl.noaa.gov/data/gridded/data.gpcp.html) | Satellite–gauge precipitation (`precip`) | 1979–2025 |
| [NOAA PSL ERSST v6](https://psl.noaa.gov/data/gridded/data.noaa.ersst.v6.html) | Sea surface temperature (`sst`) | 1850–2025 |
| [NOAA PSL NCEP/NCAR Reanalysis 1](https://psl.noaa.gov/data/gridded/data.ncep.reanalysis.html) | Water vapor (`pr_wtr`), sea level pressure (`slp`), 10 m wind speed and components (`wspd`, `uwnd`, `vwnd`), cloud cover (`tcdc`), 2 m air temperature (`air`), surface skin temperature (`skt`), topsoil moisture and temperature (`soilw`, `tmp`), surface incoming sunlight (`dswrf`), latent and sensible heat flux (`lhtfl`, `shtfl`), and outgoing longwave radiation (`ulwrf`) | 1948–2025 |
| [NOAA PSL OISST v2](https://psl.noaa.gov/data/gridded/data.noaa.oisst.v2.html) | Sea ice concentration (`icec`) | 1982–2022 |

- **Data inventory.** The [catalog](../dist/assets/catalog.json) lists each layer’s exact NetCDF URL, baseline, unit, grid and coverage. The [Python preparation script](../scripts/prepare_data.py) records the source variable for each layer and the transformations applied. The NOAA-distributed layers use 1991–2020 cell baselines.
- **Map data.** The coastlines and borders use [Natural Earth](https://www.naturalearthdata.com/about/terms-of-use/) via World Atlas. The repository contains the [city search list](../dist/assets/cities.json), [major-city naming list](../dist/assets/major-cities.json), and [administrative boundaries](../dist/assets/admin1.json) used to label a clicked cell. The source versions of these legacy label files are not recorded in the repository.
- **Code and fonts.** Licenses for D3 Array, D3 Geo, TopoJSON Client, and World Atlas are bundled in [assets](../dist/assets/). The site uses Bricolage Grotesque, IBM Plex Sans, and IBM Plex Mono from Google Fonts. [Python dependencies](../scripts/requirements.txt)
- **Text and images.** The project summary and demo wording describe the team’s implementation. Atlas captures show the app’s rendered data, basemap, and interface. Use the [2025 comparison screenshot](atlas-compare.png) in the demo. Other captures include [the overview](atlas-overview.png), [the trend view](atlas-trend.png), and the project’s [social preview](../dist/assets/og.png). The official challenge title is credited to NASA Space Apps.
- **SI disclosure.** Super Intelligence (SI) tools assisted parts of this project. Repository history credits Cursor and Anthropic Claude for earlier Atlas development. OpenAI Codex assisted with the Compare implementation, browser verification, and this submission and demo draft. That use covered research, coding, debugging, and writing. The running app calculates values, slopes, and uncertainty with fixed formulas and does not use an SI model. No SI-generated images are included.

## Slide outline

1. **GQ Atlas.** The Sonic Waves. Show the two marked grid cells and introduce the NASA challenge.
2. **The investigation.** “How different were the Canadian Arctic and Toronto temperature anomalies in the same year?” Explain that both use their local 1951–1980 baseline.
3. **The comparison.** Open the atlas, leave Canadian Arctic as A, click **Compare**, and search **Toronto**. Show 2025 with A at **+3.45 °C**, B at **+1.01 °C**, and A − B at **+2.44 °C**.
4. **The trend test.** Point to the shared chart. For 1996–2025, the fitted rates were **+0.40 °C/decade** and **+0.33 °C/decade**. The Arctic cell’s **p = 0.0506** is above 0.05 and its 95% confidence interval includes zero.
5. **NASA data and methods.** Name GISTEMP v4, the 2° grid, the 1951–1980 baseline, and the 30-year fit. Show where judges can find the original data and download the analysis.
6. **Next investigation.** Invite judges to compare two places they know, then repeat the question for a different variable. End with the project and source links.

### Optional 30-second narration

> How does warming in the Canadian Arctic compare with Toronto? Using NASA’s GISTEMP data, GQ Atlas compares both places in the same year. In 2025, the Arctic grid cell was 3.45 degrees above its baseline and Toronto was 1.01 above its own. That’s a 2.44-degree difference. Over the latest 30 years both fitted trends rise, and the Arctic trend falls just short of the 5-percent significance threshold. Try two places you know.
