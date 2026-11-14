"""Build reproducible annual grids from the agency's monthly NetCDF records."""
from argparse import ArgumentParser
from calendar import monthrange
import gzip
from hashlib import sha256
import json
from pathlib import Path

from netCDF4 import Dataset, num2date
import numpy as np

PRODUCTS = {
    "temperature": {
        "variable": "tempanomaly",
        "name": "Surface temperature anomaly",
        "group": "Temperature",
        "shortSource": "NASA GISS · GISTEMP v4",
        "description": "How warm or cool the surface was compared with 1951–1980. NASA combines land air temperatures with sea surface temperatures.",
        "inputUnits": ("K", "degC"),
        "agency": "NASA GISS",
        "product": "GISTEMP v4 · Land–Ocean Temperature Index",
        "reference": "1951–1980",
        "scale": 3,
        "trendScale": 1,
        "unit": "°C",
        "source": "https://data.giss.nasa.gov/gistemp/data_v4.html",
        "download": "https://data.giss.nasa.gov/pub/gistemp/gistemp1200_GHCNv4_ERSSTv5.nc.gz",
    },
    "precipitation": {
        "variable": "precip",
        "name": "Precipitation",
        "group": "Water",
        "shortSource": "NOAA PSL · GPCP v2.3",
        "description": "How much more or less rain and snow fell per day than usual, estimated from satellites and rain gauges.",
        "inputUnits": ("mm/day",),
        "agency": "NOAA PSL",
        "product": "GPCP v2.3 · Satellite–gauge precipitation",
        "reference": "1991–2020",
        "scale": 1.25,
        "trendScale": 0.3,
        "unit": "mm/day",
        "source": "https://psl.noaa.gov/data/gridded/data.gpcp.html",
        "download": "https://downloads.psl.noaa.gov/Datasets/gpcp/precip.mon.mean.nc",
    },
}


PSL_FILES = "https://downloads.psl.noaa.gov/Datasets/"
REANALYSIS = "https://psl.noaa.gov/data/gridded/data.ncep.reanalysis.html"


def reanalysis(variable, name, group, description, unit, input_unit, grid, file, scale, trend_scale):
    return {
        "variable": variable, "name": name, "group": group, "description": description,
        "unit": unit, "inputUnits": (input_unit,), "reference": "1991–2020",
        "agency": "NOAA PSL", "product": "NCEP/NCAR Reanalysis 1",
        "shortSource": "NOAA PSL · NCEP/NCAR R1", "source": REANALYSIS,
        "download": PSL_FILES + "ncep.reanalysis.derived/" + grid + "/" + file,
        "scale": scale, "trendScale": trend_scale, "displayGrid": 2.5,
    }


PRODUCTS.update({
    "sst": {
        "variable": "sst", "name": "Sea surface temperature", "group": "Temperature",
        "description": "Temperature of the ocean surface, reconstructed from marine observations. Land is gray in this layer.",
        "unit": "°C", "inputUnits": ("degC",), "reference": "1991–2020", "agency": "NOAA PSL",
        "product": "NOAA Extended Reconstructed Sea Surface Temperature v6",
        "shortSource": "NOAA PSL · ERSST v6", "scale": 2, "trendScale": 0.8,
        "source": "https://psl.noaa.gov/data/gridded/data.noaa.ersst.v6.html",
        "download": PSL_FILES + "noaa.ersst.v6/sst.mnmean.nc",
        "displayGrid": 2,
    },
    "moisture": reanalysis("pr_wtr", "Atmospheric water vapor", "Water",
        "Total water vapor in the column of air overhead. One kilogram per square meter would make a millimeter of liquid water.",
        "kg/m²", "kg/m^2", "surface", "pr_wtr.eatm.mon.mean.nc", 5, 2),
    "pressure": reanalysis("slp", "Sea level air pressure", "Atmosphere",
        "Atmospheric pressure adjusted to sea level so places at different elevations can be compared.",
        "hPa", "millibars", "surface", "slp.mon.mean.nc", 5, 2),
    "wind": reanalysis("wspd", "Near-surface wind speed", "Atmosphere",
        "How fast air moves 10 meters above the surface, averaged over time.",
        "m/s", "m/s", "surface_gauss", "wspd.10m.mon.mean.nc", 1.5, 0.6),
    "cloud": reanalysis("tcdc", "Total cloud cover", "Atmosphere",
        "The share of the sky covered by clouds at any height. Differences are in percentage points.",
        "pp", "%", "other_gauss", "tcdc.eatm.mon.mean.nc", 15, 5),
    "olr": reanalysis("ulwrf", "Outgoing longwave radiation", "Energy",
        "Thermal infrared energy leaving Earth at the top of the atmosphere, measured as power per unit area.",
        "W/m²", "W/m^2", "other_gauss", "ulwrf.ntat.mon.mean.nc", 15, 5),
})


def annual_grid(path, key, meta):
    with Dataset(path) as source:
        time = source["time"]
        dates = num2date(time[:], time.units, getattr(time, "calendar", "standard"))
        annual = {}
        months_by_year = {}
        for i, date in enumerate(dates):
            months = months_by_year.setdefault(date.year, {})
            if date.month in months:
                raise ValueError(f"{path}: duplicate month {date.year}-{date.month}")
            months[date.month] = i

        longitude = (np.asarray(source["lon"][:]) + 180) % 360 - 180
        latitude = np.asarray(source["lat"][:])
        step = meta.get("displayGrid", float(360 / len(longitude)))
        target_lon = -180 + step * (0.5 + np.arange(round(360 / step)))
        target_lat = 90 - step * (0.5 + np.arange(round(180 / step)))
        # Sample the nearest source grid point without mixing land and sea values.
        xs = np.abs((longitude[None, :] - target_lon[:, None] + 180) % 360 - 180).argmin(axis=1)
        ys = np.abs(latitude[None, :] - target_lat[:, None]).argmin(axis=1)
        if "displayGrid" not in meta and not (np.allclose(longitude[xs], target_lon)
                                              and np.allclose(latitude[ys], target_lat)):
            raise ValueError(f"{path}: unexpected grid coordinates")

        field = source[meta["variable"]]
        if field.dimensions != ("time", "lat", "lon") or field.units not in meta["inputUnits"]:
            raise ValueError(f"{path}: unexpected field metadata {field.dimensions}, {field.units}")
        for year, months in sorted(months_by_year.items()):
            if len(months) != 12:
                continue
            block = field[[months[m] for m in range(1, 13)]].astype(np.float64).filled(np.nan)
            # K and °C increments are identical for temperature anomalies.
            if key == "precipitation" and (block < 0).any():
                raise ValueError(f"{path}: negative precipitation rate in {year}")
            weights = [monthrange(year, m)[1] for m in range(1, 13)]
            annual[year] = np.average(block, weights=weights, axis=0)[ys][:, xs]

    if key != "temperature":
        # Normalize each cell to its own 30-year mean.
        reference = np.mean([annual[y] for y in range(1991, 2021)], axis=0)
        annual = {year: values - reference for year, values in annual.items()}
    years = list(range(min(annual), max(annual) + 1))
    empty = np.full((len(ys), len(xs)), np.nan)
    data = np.asarray([annual.get(year, empty) for year in years], dtype="<f4")
    if not np.isfinite(data).any():
        raise ValueError(f"{path}: all annual data are missing")
    return years, step, data


def main():
    parser = ArgumentParser(description=__doc__)
    for key in PRODUCTS:
        parser.add_argument("--" + key, type=Path, required=key in {"temperature", "precipitation"})
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "dist/assets")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    datasets = {}
    for key, meta in PRODUCTS.items():
        path = getattr(args, key)
        if path is None:
            continue
        years, step, data = annual_grid(path, key, meta)
        payload = gzip.compress(data.tobytes(), compresslevel=7, mtime=0)
        filename = f"{key}-{sha256(payload).hexdigest()[:10]}.bin"
        (args.output / filename).write_bytes(payload)
        datasets[key] = {
            **{name: value for name, value in meta.items() if name != "inputUnits"},
            "years": years, "step": step,
            "height": data.shape[1], "width": data.shape[2],
            "file": filename, "sourceSha256": sha256(path.read_bytes()).hexdigest(),
        }
        print(f"{key}: {years[0]}–{years[-1]}, {data.shape}, {len(payload):,} compressed bytes")
    (args.output / "catalog.json").write_text(json.dumps(datasets, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
