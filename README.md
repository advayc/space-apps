# Earth Trend Atlas

An independent NASA Space Apps Challenge project. Explore annual climate anomalies and animated 30-year trend maps on an orthographic globe or a flat map. Select a location to inspect the nearest grid cell, see its annual history and confidence interval, and download its values.

Serve the bundled site with Python from this directory.

```sh
python3 -m http.server 8080 --bind 127.0.0.1 --directory dist
```

Open [the local atlas](http://127.0.0.1:8080/). The browser needs Canvas and DecompressionStream support.

## Scientific inputs

| Layer | Product | Included years | Grid | Reference |
|---|---|---|---|---|
| Surface temperature | [NASA GISS GISTEMP v4 LOTI](https://data.giss.nasa.gov/gistemp/data_v4.html) | 1880–2025 | 2° with 1,200 km smoothing | 1951–1980 |
| Precipitation | [GPCP v2.3 monthly, provided by NOAA PSL, Boulder, Colorado, USA](https://psl.noaa.gov/data/gridded/data.gpcp.html) | 1979–2025 | 2.5° | 1991–2020 |
| Sea surface temperature | [NOAA ERSST v6](https://psl.noaa.gov/data/gridded/data.noaa.ersst.v6.html) | 1850–2025 | 2° display | 1991–2020 |
| Atmospheric water vapor, sea level pressure, near-surface wind speed, cloud cover, and outgoing longwave radiation | [NCEP/NCAR Reanalysis 1, provided by NOAA PSL](https://psl.noaa.gov/data/gridded/data.ncep.reanalysis.html) | 1948–2025 | 2.5° display | 1991–2020 |

Annual fields are weighted by the number of calendar days in each month. A cell-year must contain all 12 valid monthly values, and an incomplete source year does not enter the timeline. Precipitation is a daily mean rate anomaly. Except for NASA temperature, each anomaly is relative to the cell’s mean of the 30 annual values in 1991–2020. The six added layers use nearest-neighbor sampling to place their native grids on the display grid. The reanalysis combines observations with a weather model, and changes in the observing network can affect its trends. Coastlines and borders are from [Natural Earth](https://www.naturalearthdata.com/about/terms-of-use/).

The 30-year trend is an ordinary least squares slope in units per decade. The local test uses a three-lag Bartlett Newey–West covariance with an n/(n−2) finite sample correction and a normal approximation, assuming weakly dependent annual residuals. It screens for a linear trend in that window. P-values are pointwise, and repeated exploration across cells or windows increases false-positive risk. Confidence intervals capture regression uncertainty and exclude uncertainty in the source products. A location can have several years with no data, particularly early in the temperature record. Named places are shortcuts to coarse grid cells.

## Rebuild the data

```sh
python3 -m pip install -r scripts/requirements.txt
curl -fL https://data.giss.nasa.gov/pub/gistemp/gistemp1200_GHCNv4_ERSSTv5.nc.gz -o gistemp.nc.gz
gzip -d gistemp.nc.gz
curl -fL https://downloads.psl.noaa.gov/Datasets/gpcp/precip.mon.mean.nc -o gpcp.nc
# Download the six extra NetCDF files from the URLs in the catalog.
python3 - <<'PYTHON' | while read -r key url; do curl -fL "$url" -o "$key.nc" || exit 1; done
import json
from pathlib import Path

for key, layer in json.loads(Path("dist/assets/catalog.json").read_text()).items():
    if key not in {"temperature", "precipitation"}:
        print(key, layer["download"])
PYTHON
python3 scripts/prepare_data.py --temperature gistemp.nc --precipitation gpcp.nc \
  --sst sst.nc --moisture moisture.nc --pressure pressure.nc --wind wind.nc \
  --cloud cloud.nc --olr olr.nc
```

Keep the raw NetCDF downloads outside the Site source before publishing. The browser uses the gzip-compressed little-endian float grids referenced by `dist/assets/catalog.json`. The catalog records raw NetCDF SHA-256 hashes. The agencies may revise historical values as well as append new months. Delete unreferenced grid files after rebuilding and before publishing.

The workspace also includes a separate station CSV explorer for local exports.
