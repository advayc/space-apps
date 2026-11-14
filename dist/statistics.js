// Grid histories are one value per calendar year. A gap invalidates the window.
export const WINDOW = 30;
const spread = WINDOW * (WINDOW * WINDOW - 1) / 12;
const center = (WINDOW - 1) / 2;

export function slopeAt(values, end, stride = 1, offset = 0) {
  if (end < WINDOW - 1) return NaN;
  let sum = 0;
  for (let i = 0; i < WINDOW; i++) {
    const value = values[(end - WINDOW + 1 + i) * stride + offset];
    if (!Number.isFinite(value)) return NaN;
    sum += (i - center) * value;
  }
  return sum / spread;
}

export function trend(values, end) {
  const slope = slopeAt(values, end);
  if (!Number.isFinite(slope)) return null;
  const window = values.slice(end - WINDOW + 1, end + 1);
  const mean = window.reduce((a, b) => a + b, 0) / WINDOW;
  const scores = window.map((value, i) => {
    const x = i - center;
    return x * (value - mean - x * slope);
  });
  let variance = scores.reduce((total, score) => total + score * score, 0);
  const lags = 3;
  for (let lag = 1; lag <= lags; lag++) {
    let autocovariance = 0;
    for (let i = lag; i < WINDOW; i++) autocovariance += scores[i] * scores[i - lag];
    variance += 2 * (1 - lag / (lags + 1)) * autocovariance;
  }
  const se = Math.sqrt(Math.max(0, variance) * WINDOW / (WINDOW - 2)) / spread;
  // Undefined inference for exact fits or effectively zero residual variance.
  const inferable = se > 1e-12;
  const p = inferable ? normalTwoSided(Math.abs(slope) / se) : null;
  const delta = 1.95996398454 * se;
  return { rate: slope * 10, mean, slope, p,
    low: inferable ? (slope - delta) * 10 : null,
    high: inferable ? (slope + delta) * 10 : null };
}

// Standard normal upper tail approximation (Abramowitz & Stegun 26.2.17).
function normalTwoSided(z) {
  const t = 1 / (1 + 0.2316419 * z);
  const tail = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return Math.min(1, 2 * Math.exp(-z * z / 2) * tail / Math.sqrt(2 * Math.PI));
}

// ---- Projection ----
// A projected year has three parts, all taken from the WINDOW values ending at `end`:
//   1. the least squares trend, damped by 1 - 1/t² when it is weak relative to
//      its own noise (t = slope / standard error; no trend at all when |t| <= 1);
//   2. year-to-year swings: the departure from the trend line of one past year,
//      the same past year for every cell so the map keeps real spatial patterns;
//   3. a 95% range: the Student t prediction interval, widened by BAND_SCALE
//      because a hindcast showed the textbook interval is too narrow.
const T_975 = 2.048407; // t quantile for WINDOW - 2 = 28 degrees of freedom
export const BAND_SCALE = 1.4;

// Which year of the window lends its departure to a given future year.
export function residualIndex(year) {
  return (Math.imul(year, 2654435761) >>> 0) % WINDOW;
}

function fit(values, end, stride, offset) {
  const slope = slopeAt(values, end, stride, offset);
  if (!Number.isFinite(slope)) return null;
  const first = end - WINDOW + 1;
  let mean = 0;
  for (let i = 0; i < WINDOW; i++) mean += values[(first + i) * stride + offset];
  mean /= WINDOW;
  let squares = 0;
  for (let i = 0; i < WINDOW; i++) {
    const r = values[(first + i) * stride + offset] - mean - (i - center) * slope;
    squares += r * r;
  }
  const sigma = Math.sqrt(squares / (WINDOW - 2));
  const t = sigma > 1e-12 ? slope / (sigma / Math.sqrt(spread)) : Infinity;
  const weight = t * t > 1 ? 1 - 1 / (t * t) : 0;
  return {mean, slope, sigma, weight, first};
}

// One {value, low, high, sim} per future step for a single series. `value` is
// the central estimate, `sim` adds the borrowed year-to-year departure.
export function forecast(values, end, steps, firstYear) {
  const f = fit(values, end, 1, 0);
  if (!f) return null;
  return Array.from({length: steps}, (_, k) => {
    const x = center + k + 1;
    const value = f.mean + f.weight * f.slope * x;
    const j = residualIndex(firstYear + k);
    const half = BAND_SCALE * T_975 * f.sigma * Math.sqrt(1 + 1 / WINDOW + x * x / spread);
    return {value, low: value - half, high: value + half, weight: f.weight,
      sim: value + values[f.first + j] - f.mean - (j - center) * f.slope};
  });
}

// Append simulated projected grids for every cell to a year-major value array.
export function extendGrid(values, size, count, steps, firstYear) {
  if (steps <= 0 || count < WINDOW) return values;
  const out = new Float32Array((count + steps) * size);
  out.set(values);
  const end = count - 1;
  const sources = Array.from({length: steps}, (_, k) => residualIndex(firstYear + k));
  for (let cell = 0; cell < size; cell++) {
    const f = fit(values, end, size, cell);
    for (let k = 0; k < steps; k++) {
      if (!f) { out[(count + k) * size + cell] = NaN; continue; }
      const j = sources[k];
      out[(count + k) * size + cell] = f.mean + f.weight * f.slope * (center + k + 1)
        + values[(f.first + j) * size + cell] - f.mean - (j - center) * f.slope;
    }
  }
  return out;
}
