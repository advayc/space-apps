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
        "name": "Surface temperature",
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
        xs, ys = np.argsort(longitude), np.argsort(-latitude)
        step = float(360 / len(xs))
        if not (np.allclose(longitude[xs], -180 + step * (0.5 + np.arange(len(xs))))
                and np.allclose(latitude[ys], 90 - step * (0.5 + np.arange(len(ys))))):
            raise ValueError(f"{path}: unexpected grid coordinates")

        field = source[meta["variable"]]
        expected_units = {"temperature": ("K", "degC"), "precipitation": ("mm/day",)}
        if field.units not in expected_units[key]:
            raise ValueError(f"{path}: unexpected units {field.units}")
        for year, months in sorted(months_by_year.items()):
            if len(months) != 12:
                continue
            block = field[[months[m] for m in range(1, 13)]].astype(np.float64).filled(np.nan)
            # K and °C increments are identical for temperature anomalies.
            if key == "precipitation" and (block < 0).any():
                raise ValueError(f"{path}: negative precipitation rate in {year}")
            weights = [monthrange(year, m)[1] for m in range(1, 13)]
            annual[year] = np.average(block, weights=weights, axis=0)[ys][:, xs]

    if key == "precipitation":
        # Normalize each cell to its own 30-year mean annual daily rate.
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
    parser.add_argument("--temperature", type=Path, required=True)
    parser.add_argument("--precipitation", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "dist/assets")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    datasets = {}
    for key, meta in PRODUCTS.items():
        path = getattr(args, key)
        years, step, data = annual_grid(path, key, meta)
        payload = gzip.compress(data.tobytes(), compresslevel=7, mtime=0)
        filename = f"{key}-{sha256(payload).hexdigest()[:10]}.bin"
        (args.output / filename).write_bytes(payload)
        datasets[key] = {
            **meta,
            "years": years, "step": step,
            "height": data.shape[1], "width": data.shape[2],
            "file": filename, "sourceSha256": sha256(path.read_bytes()).hexdigest(),
        }
        print(f"{key}: {years[0]}–{years[-1]}, {data.shape}, {len(payload):,} compressed bytes")
    (args.output / "catalog.json").write_text(json.dumps(datasets, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
