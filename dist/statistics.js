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

// Straight-line projection: continue the least squares fit of the WINDOW values
// ending at `end`. Returns one {value, low, high} per future step, where
// low/high bound a 95% prediction interval for a single future value
// (Student t, WINDOW - 2 degrees of freedom), or null if the window has gaps.
const T_975 = 2.048407; // t quantile for 28 degrees of freedom
export function forecast(values, end, steps) {
  const slope = slopeAt(values, end);
  if (!Number.isFinite(slope)) return null;
  let mean = 0;
  for (let i = 0; i < WINDOW; i++) mean += values[end - WINDOW + 1 + i];
  mean /= WINDOW;
  let residual = 0;
  for (let i = 0; i < WINDOW; i++) {
    const r = values[end - WINDOW + 1 + i] - mean - (i - center) * slope;
    residual += r * r;
  }
  const sigma = Math.sqrt(residual / (WINDOW - 2));
  return Array.from({length: steps}, (_, k) => {
    const x = center + k + 1;
    const value = mean + slope * x;
    const half = T_975 * sigma * Math.sqrt(1 + 1 / WINDOW + x * x / spread);
    return {value, low: value - half, high: value + half};
  });
}

// Append projected grids for every cell to a year-major value array.
export function extendGrid(values, size, count, steps) {
  if (steps <= 0 || count < WINDOW) return values;
  const out = new Float32Array((count + steps) * size);
  out.set(values);
  const end = count - 1;
  for (let cell = 0; cell < size; cell++) {
    const slope = slopeAt(values, end, size, cell);
    let mean = 0;
    if (Number.isFinite(slope)) {
      for (let i = 0; i < WINDOW; i++) mean += values[(end - WINDOW + 1 + i) * size + cell];
      mean /= WINDOW;
    }
    for (let k = 0; k < steps; k++) {
      out[(count + k) * size + cell] = Number.isFinite(slope) ? mean + slope * (center + k + 1) : NaN;
    }
  }
  return out;
}
