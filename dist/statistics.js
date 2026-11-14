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
//   3. a 95% range: the Student t prediction interval, widened by bandScale(k)
//      because hindcasts showed the textbook interval is too narrow, and more
//      so the further ahead it reaches (trends bend; a straight line cannot).
const T_975 = 2.048407; // t quantile for WINDOW - 2 = 28 degrees of freedom
// Widening for the k-th projected year (k = 0 is the first). Calibrated on
// hindcasts from 8 starting years (temperature, sea surface) and 3 for the
// other layers, so that about 95% of later measurements fall inside at every
// lead time out to 75 years.
export const bandScale = k => Math.min(2, 1.25 + 0.03 * k);

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
  return {mean, slope, sigma, weight, first, complete: true};
}

// A cell with gaps in the window still gets a projection from the years it has.
// Fewer than eight years is held at their mean, so a short sample cannot invent a steep slope.
function partialFit(values, end, stride, offset) {
  const first = end - WINDOW + 1;
  let n = 0, sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
  for (let i = 0; i < WINDOW; i++) {
    const value = values[(first + i) * stride + offset];
    if (!Number.isFinite(value)) continue;
    const x = i - center;
    n++; sumX += x; sumY += value; sumXX += x * x; sumXY += x * value;
  }
  if (!n) {
    for (let i = end; i >= 0; i--) {
      const value = values[i * stride + offset];
      if (Number.isFinite(value)) return {mean: value, slope: 0, sigma: null, weight: 0, first, complete: false};
    }
    return null;
  }
  const mean = sumY / n;
  let slope = 0, weight = 0;
  const denom = n * sumXX - sumX * sumX;
  if (n >= 8 && Math.abs(denom) > 1e-9) {
    slope = (n * sumXY - sumX * sumY) / denom;
    let squares = 0;
    for (let i = 0; i < WINDOW; i++) {
      const value = values[(first + i) * stride + offset];
      if (!Number.isFinite(value)) continue;
      const residual = value - mean - (i - center) * slope;
      squares += residual * residual;
    }
    const sigma = n > 2 ? Math.sqrt(squares / (n - 2)) : 0;
    const sxx = sumXX - sumX * sumX / n;
    const t = sigma > 1e-12 && sxx > 0 ? slope / (sigma / Math.sqrt(sxx)) : Infinity;
    weight = t * t > 1 ? 1 - 1 / (t * t) : 0;
  }
  return {mean, slope, sigma: null, weight, first, complete: false};
}

function projectSteps(f, values, stride, offset, steps, firstYear) {
  return Array.from({length: steps}, (_, k) => {
    const x = center + k + 1;
    const value = f.mean + f.weight * f.slope * x;
    const j = residualIndex(firstYear + k);
    const sample = values[(f.first + j) * stride + offset];
    const residual = Number.isFinite(sample) ? sample - f.mean - (j - center) * f.slope : 0;
    const half = f.sigma == null ? 0
      : bandScale(k) * T_975 * f.sigma * Math.sqrt(1 + 1 / WINDOW + x * x / spread);
    return {value, low: value - half, high: value + half, weight: f.weight,
      complete: f.complete, sim: value + residual};
  });
}

// One {value, low, high, sim} per future step for a single series. `value` is
// the central estimate, `sim` adds the borrowed year-to-year departure.
export function forecast(values, end, steps, firstYear) {
  const f = fit(values, end, 1, 0) || partialFit(values, end, 1, 0);
  if (!f) return null;
  return projectSteps(f, values, 1, 0, steps, firstYear);
}

const NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// Layers that already cover nearly the whole globe (temperature, precipitation,
// winds, …) have their remaining gaps filled from neighboring cells. Ocean-only
// and land-only layers keep that mask, so land stays empty on sea surface
// temperature and sea ice.
function fillProjectedGaps(out, width, height, count, steps, fillAll, had) {
  const size = width * height;
  for (let k = 0; k < steps; k++) {
    const base = (count + k) * size;
    let pending = [];
    for (let cell = 0; cell < size; cell++) {
      if (Number.isFinite(out[base + cell])) continue;
      if (fillAll || had[cell]) pending.push(cell);
    }
    while (pending.length) {
      const next = [];
      let wrote = 0;
      for (const cell of pending) {
        const row = (cell / width) | 0;
        const col = cell - row * width;
        let sum = 0, n = 0;
        for (const [dc, dr] of NEIGHBORS) {
          const nextRow = row + dr;
          if (nextRow < 0 || nextRow >= height) continue;
          let nextCol = col + dc;
          if (nextCol < 0) nextCol += width;
          else if (nextCol >= width) nextCol -= width;
          const value = out[base + nextRow * width + nextCol];
          if (Number.isFinite(value)) { sum += value; n++; }
        }
        if (n) { out[base + cell] = sum / n; wrote++; }
        else next.push(cell);
      }
      if (!wrote) break;
      pending = next;
    }
  }
}

// Append simulated projected grids for every cell to a year-major value array.
export function extendGrid(values, width, count, steps, firstYear) {
  if (steps <= 0 || count < WINDOW) return values;
  const size = values.length / count;
  const height = size / width;
  const out = new Float32Array((count + steps) * size);
  out.set(values);
  out.fill(NaN, values.length);
  const end = count - 1;
  const had = new Uint8Array(size);
  let observed = 0;
  for (let cell = 0; cell < size; cell++) {
    const fitted = fit(values, end, size, cell) || partialFit(values, end, size, cell);
    if (!fitted) continue;
    had[cell] = 1;
    observed++;
    const projected = projectSteps(fitted, values, size, cell, steps, firstYear);
    for (let k = 0; k < steps; k++) out[(count + k) * size + cell] = projected[k].sim;
  }
  fillProjectedGaps(out, width, height, count, steps, observed / size >= 0.9, had);
  return out;
}
