# Earth Trend Atlas

A simple tool for exploring how Earth’s climate has changed over time.

Pick a variable (temperature, rainfall, ice, and more), choose a place, and see whether that place has warmed, cooled, gotten wetter, or dried — and whether the trend looks statistically meaningful.

Live site: [space.advay.ca](https://space.advay.ca)

![Earth Trend Atlas overview](docs/atlas-overview.png)

![30-year trend view](docs/atlas-trend.png)

## How to use

1. Type a city on the landing page, or open the world map.
2. Choose a climate layer.
3. Move the timeline. Years after the latest data are violet: projections to 2050 with a 95% range, explained and tested on the [Projections](dist/projections/) page.
4. Read the side panel for the anomaly, trend per decade, and significance.
5. Download the series with its trend line and projection (CSV), the fit statistics (JSON), or the chart and map (PNG).

Every layer's dataset page and original NetCDF file are linked under **Where this data comes from**.

## How to read it

- **Colors** show anomalies: warmer/cooler or wetter/drier than the usual baseline.
- **Anomaly** means difference from normal, not the absolute value.
- **Trend per decade** is the average rate of change over about 30 years.
- **Significant at 5%** means a flat (no-change) line is unlikely for that grid cell. It does not prove a cause.
- **Projected** values are a statistical estimate from past data with a stated error range, not a climate model forecast.
- Cities jump to the **nearest coarse grid cell** (~2°), not a weather station.

## Run locally

```sh
python3 -m http.server 8080 --bind 127.0.0.1 --directory dist
```

Open [http://127.0.0.1:8080/](http://127.0.0.1:8080/).

## Push changes to GitHub

```sh
bash scripts/push-to-github.sh "what changed"
```

The first run links this folder to `advayc/space-apps`; every run commits and pushes to the `landing-redesign` branch (set `BRANCH=main` to push straight to the live site).

## Data

Main layers include NASA GISTEMP temperature, GPCP precipitation, NOAA ERSST sea surface temperature, NCEP/NCAR reanalysis fields, and OISST sea ice. Full citations and methods are on the [Data & methods](dist/data-and-methods/) page.
