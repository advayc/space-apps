# GQ Atlas

A simple tool for exploring how Earth’s climate has changed over time.

Pick a variable (temperature, rainfall, ice, and more), choose a place, and see whether that place has warmed, cooled, gotten wetter, or dried — and whether the trend looks statistically meaningful.

Live site: [space.advay.ca](https://space.advay.ca)

![GQ Atlas overview](docs/atlas-overview.png)

![30-year trend view](docs/atlas-trend.png)

## How to use

1. Type a city on the landing page, or open the world map.
2. Choose a climate layer.
3. Drag the timeline or type a year in its date field. Years after the latest data are violet: projections to 2100 with a 95% range, explained and tested on the [Projections](dist/projections/) page.
4. In the location analysis below the map, use **Compare** under place search to choose a second city or click a second cell on the map. The selected layer, period, and year apply to both places. Read A minus B and follow the two records on one chart. Use **Clear comparison** to return to one place.
5. Read the trend and significance for the primary cell. When both cells have 30 consecutive years in the same window, the comparison also shows their fitted rates.
6. Download the primary series (CSV), its fit statistics (JSON), or the chart and map (PNG).

Every layer's dataset page and original NetCDF file are linked under **Where this data comes from**.

## How to read it

- **Colors** show anomalies: warmer/cooler or wetter/drier than the usual baseline.
- **Anomaly** means difference from normal, not the absolute value.
- **Historical averages** shows the period baseline and the mean of all available historical anomalies for each selected cell. GISTEMP is supplied in anomalies relative to a zero reference.
- **Trend per decade** is the average rate of change over about 30 years.
- **Significant at 5%** means a flat (no-change) line is unlikely for that grid cell. It does not prove a cause.
- **Projected** values are a statistical estimate from past data with a stated error range, not a climate model forecast.
- Cities jump to the **nearest coarse grid cell** (~2°), not a weather station.

## References

[1] Hansen, J., Ruedy, R., Sato, M., & Lo, K. (2010). “Global surface temperature change.” Reviews of Geophysics, 48(4), RG4004. https://doi.org/10.1029/2010RG000345

[2] Lenssen, N. J. L., Schmidt, G. A., Hansen, J. E., Menne, M. J., Persin, A., Ruedy, R., & Zyss, D. (2019). “Improvements in the GISTEMP uncertainty model.” Journal of Geophysical Research: Atmospheres, 124(12), 6307–6326. https://doi.org/10.1029/2018JD029522

[3] Adler, R. F., Sapiano, M. R. P., Huffman, G. J., Wang, J., Gu, G., Bolvin, D., Chiu, L., Schneider, U., Becker, A., Nelkin, E., Xie, P., Ferraro, R., & Shin, D.-B. (2018). “The Global Precipitation Climatology Project (GPCP) monthly analysis (New Version 2.3) and a review of 2017 global precipitation.” Atmosphere, 9(4), 138. https://doi.org/10.3390/atmos9040138

[4] Huang, B., Thorne, P. W., Banzon, V. F., Boyer, T., Chepurin, G., Lawrimore, J. H., Menne, M. J., Smith, T. M., Vose, R. S., & Zhang, H.-M. (2017). “Extended Reconstructed Sea Surface Temperature, Version 5 (ERSSTv5): Upgrades, validations, and intercomparisons.” Journal of Climate, 30(20), 8179–8205. https://doi.org/10.1175/JCLI-D-16-0836.1

[5] Kalnay, E., Kanamitsu, M., Kistler, R., Collins, W., Deaven, D., Gandin, L., Iredell, M., Saha, S., White, G., Woollen, J., Zhu, Y., Chelliah, M., Ebisuzaki, W., Higgins, W., Janowiak, J., Mo, K. C., Ropelewski, C., Wang, J., Leetmaa, A., Reynolds, R., Jenne, R., & Joseph, D. (1996). “The NCEP/NCAR 40-year reanalysis project.” Bulletin of the American Meteorological Society, 77(3), 437–471. https://doi.org/10.1175/1520-0477(1996)077<0437:TNYRP>2.0.CO;2

[6] Reynolds, R. W., Smith, T. M., Liu, C., Chelton, D. B., Casey, K. S., & Schlax, M. G. (2007). “Daily high-resolution-blended analyses for sea surface temperature.” Journal of Climate, 20(22), 5473–5496. https://doi.org/10.1175/2007JCLI1824.1

[7] Newey, W. K., & West, K. D. (1987). “A simple, positive semi-definite, heteroskedasticity and autocorrelation consistent covariance matrix.” Econometrica, 55(3), 703–708. https://doi.org/10.2307/1913610

[8] Natural Earth. (n.d.). “Natural Earth terms of use.” https://www.naturalearthdata.com/about/terms-of-use/
