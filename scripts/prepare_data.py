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
        "description": "NASA combines air temperatures over land with water temperatures at the ocean surface to show how much warmer or cooler each area was than its historical average.",
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
    "wind": reanalysis("wspd", "Wind speed at 10 m", "Wind",
        "How fast air moves 10 meters above the surface, averaged over time.",
        "m/s", "m/s", "surface_gauss", "wspd.10m.mon.mean.nc", 1.5, 0.6),
    "uwnd": reanalysis("uwnd", "East–west wind at 10 m", "Wind",
        "Change in east–west airflow 10 meters above the surface. Positive anomalies mean a shift toward the east, negative anomalies a shift toward the west.",
        "m/s", "m/s", "surface_gauss", "uwnd.10m.mon.mean.nc", 2, 0.7),
    "vwnd": reanalysis("vwnd", "North–south wind at 10 m", "Wind",
        "Change in north–south airflow 10 meters above the surface. Positive anomalies mean a shift toward the north, negative anomalies a shift toward the south.",
        "m/s", "m/s", "surface_gauss", "vwnd.10m.mon.mean.nc", 2, 0.7),
    "cloud": reanalysis("tcdc", "Total cloud cover", "Atmosphere",
        "The share of the sky covered by clouds at any height. Differences are in percentage points.",
        "pp", "%", "other_gauss", "tcdc.eatm.mon.mean.nc", 15, 5),
    "air": reanalysis("air", "Air temperature at 2 m", "Temperature",
        "Temperature of the air two meters above land or ocean. The map shows how it differs from the cell’s 1991–2020 average.",
        "°C", "degK", "surface_gauss", "air.2m.mon.mean.nc", 3, 1),
    "skin": reanalysis("skt", "Surface skin temperature", "Temperature",
        "Temperature of Earth’s outermost surface, such as soil, vegetation, snow, or the ocean surface.",
        "°C", "degC", "surface_gauss", "skt.sfc.mon.mean.nc", 3, 1),
    "soil": {**reanalysis("soilw", "Topsoil moisture", "Land & ice",
        "The fraction of the top 10 centimeters of soil occupied by water. Changes are in percentage points.",
        "pp", "fraction", "surface_gauss", "soilw.0-10cm.mon.mean.nc", 8, 4), "multiplier": 100},
    "soiltemp": reanalysis("tmp", "Topsoil temperature", "Land & ice",
        "Average temperature in the top 10 centimeters of soil, where land estimates are available.",
        "°C", "degK", "surface_gauss", "tmp.0-10cm.mon.mean.nc", 3, 1),
    "ice": {
        "variable": "icec", "name": "Sea ice concentration", "group": "Land & ice",
        "description": "The share of each ocean cell covered by sea ice. Changes are in percentage points, and land is gray.",
        "unit": "pp", "inputUnits": ("%",), "reference": "1991–2020", "agency": "NOAA PSL",
        "product": "NOAA OISST v2 monthly sea ice concentration",
        "shortSource": "NOAA PSL · OISST v2", "scale": 25, "trendScale": 15,
        "source": "https://psl.noaa.gov/data/gridded/data.noaa.oisst.v2.html",
        "download": PSL_FILES + "noaa.oisst.v2/icec.mnmean.nc", "displayGrid": 2,
    },
    "shortwave": reanalysis("dswrf", "Incoming sunlight at the surface", "Energy",
        "Solar energy reaching the surface per second and square meter after passing through the atmosphere.",
        "W/m²", "W/m^2", "surface_gauss", "dswrf.sfc.mon.mean.nc", 20, 7),
    "latent": reanalysis("lhtfl", "Latent heat flux at the surface", "Energy",
        "Energy transferred when water changes phase at the surface, mainly through evaporation.",
        "W/m²", "W/m^2", "surface_gauss", "lhtfl.sfc.mon.mean.nc", 20, 7),
    "sensible": reanalysis("shtfl", "Sensible heat flux at the surface", "Energy",
        "Heat exchanged between the surface and the air because of a temperature difference.",
        "W/m²", "W/m^2", "surface_gauss", "shtfl.sfc.mon.mean.nc", 25, 10),
    "olr": reanalysis("ulwrf", "Outgoing longwave radiation", "Energy",
        "Thermal infrared energy leaving Earth at the top of the atmosphere, measured as power per unit area.",
        "W/m²", "W/m^2", "other_gauss", "ulwrf.ntat.mon.mean.nc", 15, 5),
})


SEASONS = {
    "djf": ((-1, 12), (0, 1), (0, 2)),
    "mam": ((0, 3), (0, 4), (0, 5)),
    "jja": ((0, 6), (0, 7), (0, 8)),
    "son": ((0, 9), (0, 10), (0, 11)),
}


def grids(path, key, meta):
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
        monthly = {}
        for year, months in sorted(months_by_year.items()):
            order = sorted(months)
            block = field[[months[m] for m in order]].astype(np.float64).filled(np.nan)
            if key == "precipitation" and (block < 0).any():
                raise ValueError(f"{path}: negative precipitation rate in {year}")
            for month, values in zip(order, block[:, ys][:, :, xs], strict=True):
                monthly[year, month] = values * meta.get("multiplier", 1)

    def aggregate(period):
        result = {}
        for year in months_by_year:
            dates = [(year + offset, month) for offset, month in period]
            if all(date in monthly for date in dates):
                weights = [monthrange(y, m)[1] for y, m in dates]
                result[year] = np.average([monthly[date] for date in dates], weights=weights, axis=0)
        if key != "temperature":
            # Use the same period in every baseline year, including December of
            # the prior year for winters labeled by their January/February year.
            reference = np.mean([result[y] for y in range(1991, 2021)], axis=0)
            result = {year: values - reference for year, values in result.items()}
        years = list(range(min(result), max(result) + 1))
        empty = np.full((len(ys), len(xs)), np.nan)
        data = np.asarray([result.get(year, empty) for year in years], dtype="<f4")
        if not np.isfinite(data).any():
            raise ValueError(f"{path}: no finite data for {period}")
        return years, data

    yield "annual", step, aggregate([(0, m) for m in range(1, 13)])
    for month in range(1, 13):
        yield f"{month:02}", step, aggregate([(0, month)])
    for name, period in SEASONS.items():
        yield name, step, aggregate(period)


def write_grid(output, name, years, data, *, compact=False):
    entry = {"years": years}
    if compact:
        valid = np.isfinite(data)
        # Preserve missing cells and bound rounding to half the recorded step.
        precision = max(0.002, float(np.max(np.abs(data[valid]))) / 32767)
        packed = np.full(data.shape, -32768, dtype="<i2")
        packed[valid] = np.clip(np.rint(data[valid] / precision), -32767, 32767)
        entry["precision"] = precision
        data = packed
    payload = gzip.compress(data.tobytes(), compresslevel=9, mtime=0)
    filename = f"{name}-{sha256(payload).hexdigest()[:10]}.bin"
    (output / filename).write_bytes(payload)
    return {**entry, "file": filename}


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
        periods = grids(path, key, meta)
        _, step, (years, data) = next(periods)
        # Annual grids are packed like the sub-annual ones: about 2.5x smaller to download.
        annual = write_grid(args.output, key, years, data, compact=True)
        subannual = {
            period: write_grid(args.output, f"{key}-{period}", period_years, period_data, compact=True)
            for period, _, (period_years, period_data) in periods
        }
        datasets[key] = {
            **{name: value for name, value in meta.items() if name != "inputUnits"},
            **annual, "periods": subannual, "step": step,
            "height": data.shape[1], "width": data.shape[2],
            "sourceSha256": sha256(path.read_bytes()).hexdigest(),
        }
        print(f"{key}: {years[0]}–{years[-1]} annual, {len(subannual)} monthly and seasonal series")
    (args.output / "catalog.json").write_text(json.dumps(datasets, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
