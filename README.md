# Earth Trend Atlas

A simple tool for exploring how Earth’s climate has changed over time.

Pick a variable (temperature, rainfall, ice, and more), choose a place, and see whether that place has warmed, cooled, gotten wetter, or dried — and whether the trend looks statistically meaningful.

Live site: [space.advay.ca](https://space.advay.ca)

![Earth Trend Atlas overview](docs/atlas-overview.png)

![30-year trend view](docs/atlas-trend.png)

## How to use

1. Open the site and click **Explore the atlas**.
2. Choose a climate layer.
3. Search a city or click the map.
4. Move the timeline, or switch to **30-year trend**.
5. Read the side panel for the anomaly, trend per decade, and significance.

## How to read it

- **Colors** show anomalies: warmer/cooler or wetter/drier than the usual baseline.
- **Anomaly** means difference from normal, not the absolute value.
- **Trend per decade** is the average rate of change over about 30 years.
- **Significant at 5%** means a flat (no-change) line is unlikely for that grid cell. It does not prove a cause.
- Cities jump to the **nearest coarse grid cell** (~2°), not a weather station.

## Run locally

```sh
python3 -m http.server 8080 --bind 127.0.0.1 --directory dist
```

Open [http://127.0.0.1:8080/](http://127.0.0.1:8080/).

## Data

Main layers include NASA GISTEMP temperature, GPCP precipitation, NOAA ERSST sea surface temperature, NCEP/NCAR reanalysis fields, and OISST sea ice. Full citations and methods are on the [Data & methods](dist/data-and-methods/) page.
