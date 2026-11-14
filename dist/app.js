import { WINDOW, slopeAt, trend } from './statistics.js';
import { months, seasons, dateLabel, makeTimeline, nearestIndex } from './timeline.js';

const $ = id => document.getElementById(id);
const earth = $('earth');
const ctx = earth.getContext('2d');
const outgoing = $('earth-outgoing');
const outgoingCtx = outgoing.getContext('2d');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let outgoingFade, chartFade, pendingFade = 0, rendered = false;
const raster = document.createElement('canvas');
const rasterCtx = raster.getContext('2d');
const NO_DATA_COLOR = [88, 99, 107];
const DEFAULT_PLACE = {name: 'Canadian Arctic', region: 'Canada', lon: -95, lat: 74, kind: 'region'};
let cities = [DEFAULT_PLACE];
const themes = {
  temperature: ['#3267a5', '#80b8ce', '#eeeacb', '#e28b53', '#af3a2d'],
  water: ['#a14d2c', '#d49c67', '#eeeacb', '#73b5a5', '#28786f'],
  atmosphere: ['#80592c', '#ccaa66', '#efead4', '#9aadd7', '#4d5c9b'],
  land: ['#a25836', '#cc9c6a', '#f0ead4', '#8bbab7', '#326b81'],
  energy: ['#356e96', '#84b9cd', '#f1ead1', '#d99e71', '#933f3d'],
};
const palette = Object.fromEntries(Object.entries(themes).map(([key, colors]) => [
  key, Array.from({length: 256}, (_, i) => {
    const fraction = i / 255 * (colors.length - 1);
    const a = rgb(colors[Math.floor(fraction)]);
    const b = rgb(colors[Math.ceil(fraction)]);
    return a.map((x, channel) => x + (b[channel] - x) * (fraction % 1));
  }),
]));
const themeFor = data => data.group === 'Water' ? 'water'
  : ['Atmosphere', 'Wind'].includes(data.group) ? 'atmosphere'
  : data.group === 'Energy' ? 'energy'
  : data.group === 'Land & ice' ? 'land' : 'temperature';

function rgb(hex) {
  return hex.slice(1).match(/../g).map(channel => parseInt(channel, 16));
}

let catalog, land, borders, d3, globe, projection;
let layer = 'temperature', view = 'map', mode = 'annual', year = 2025;
let rotation = [93, -46], zoom = 1, placeName = DEFAULT_PLACE.name, point = [DEFAULT_PLACE.lon, DEFAULT_PLACE.lat];
let timer, frame, drag, active, width, height, mapBounds, rasterMap, grid;
let cameraFrame, zoomTarget, cellColors;
let flatMap, flatZoom = 1, flatOffset = [0, 0];
const MAX_FLAT_ZOOM = 16;
const FLAT_ZOOM_STEP = 1.5;
let chartData, chartCursor, chartLayout;
let intervalAnchor = null, intervalEnd = null;
let placeMatches = [], placeActive = -1;
const chart = $('chart');
const datasets = new Map();
let month = '01', season = 'djf', loadVersion = 0;
let timeline = [], timelineIndex = 0, playing = false;
let mapHover = null;

function periodKey() {
  if (mode === 'monthly') return month;
  if (mode === 'seasonal') return season;
  return 'annual';
}

function periodTitle() {
  return months.get(periodKey()) ?? seasons.get(periodKey()) ?? 'Annual';
}

const labelForYear = y => dateLabel(y, periodKey());

function refreshPeriodControl() {
  const subannual = mode === 'monthly' || mode === 'seasonal';
  $('period-control').hidden = !subannual;
  if (subannual) {
    const choices = mode === 'monthly' ? months : seasons;
    $('period-label').textContent = mode === 'monthly' ? 'Month' : 'Season';
    $('period').replaceChildren(...Array.from(choices, ([key, label]) => new Option(label, key)));
    $('period').value = periodKey();
  }
}
const clamp = (x, min, max) => Math.min(max, Math.max(min, x));
const wrap = lon => ((lon + 180) % 360 + 360) % 360 - 180;
const signed = (x, digits = 2) => {
  const display = Math.abs(x).toFixed(digits);
  return (Number(display) === 0 ? '' : x < 0 ? '−' : '+') + display;
};

async function fetchAsset(file) {
  const response = await fetch('assets/' + file);
  if (!response.ok) throw new Error(file + ': HTTP ' + response.status);
  return response;
}
async function loadDataset(key, period) {
  const cacheKey = key + ':' + period;
  const existing = datasets.get(cacheKey);
  if (existing) {
    datasets.delete(cacheKey);
    datasets.set(cacheKey, existing);
    return existing;
  }
  const request = (async () => {
    const info = catalog[key];
    const entry = period === 'annual' ? info : info.periods[period];
    const response = await fetchAsset(entry.file);
    const bytes = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    const expected = info.width * info.height * entry.years.length;
    const packed = entry.precision != null;
    if (bytes.byteLength !== (packed ? 2 : 4) * expected) throw new Error('Data size mismatch');

    const decoded = new DataView(bytes);
    let values;
    if (packed) {
      values = new Float32Array(expected);
      for (let i = 0; i < expected; i++) {
        const value = decoded.getInt16(2 * i, true);
        values[i] = value === -32768 ? NaN : value * entry.precision;
      }
    } else {
      values = new Float32Array(bytes);
      if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
        for (let i = 0; i < expected; i++) values[i] = decoded.getFloat32(4 * i, true);
      }
    }
    return { ...info, years: entry.years, values, size: info.width * info.height };
  })().catch(error => {
    if (datasets.get(cacheKey) === request) datasets.delete(cacheKey);
    throw error;
  });
  datasets.set(cacheKey, request);
  if (datasets.size > 8) datasets.delete(datasets.keys().next().value);
  return request;
}

function selectLayer(key) {
  stop();
  stopCamera();
  layer = key;
  timeline = makeTimeline(catalog[layer], mode);
  renderTimelineTicks();
  return selectDate(nearestIndex(timeline, mode, year, periodKey()));
}

async function selectDate(index) {
  const entry = timeline[index];
  if (!entry) return false;
  const {period} = entry;
  const version = ++loadVersion;
  timelineIndex = index;
  year = entry.year;
  if (mode === 'monthly') month = period;
  if (mode === 'seasonal') season = period;
  $('period').value = period;
  updateTimeline();

  if (active?.key === layer && active.period === period) {
    update(160);
    return true;
  }
  active = null;
  chartData = chartCursor = chartLayout = null;
  clearChartInterval();
  $('chart').closest('.inspector').setAttribute('aria-busy', 'true');
  $('chart-tooltip').hidden = true;
  $('chart-readout').textContent = '';
  mapHover = null;
  updateMapReadout();
  $('map-status').hidden = false;
  $('map-status').textContent = 'Loading climate data…';
  const key = layer;
  const info = catalog[key];
  $('layer-description').textContent = info.description;
  $('map-source').textContent = info.shortSource;
  $('map-source').href = info.source;
  $('layer-baseline').textContent = timeline[0].year + '–' + timeline.at(-1).year + ' · Baseline ' + info.reference;
  $('csv').disabled = true;
  try {
    const data = await loadDataset(key, period);
    if (version !== loadVersion) return false;
    active = { ...data, key, period };
    rasterMap = null;
    $('map-status').hidden = true;
    $('chart').closest('.inspector').setAttribute('aria-busy', 'false');
    update(220);
    if (!reducedMotion.matches) {
      chartFade?.cancel();
      chartFade = chart.animate([{ opacity: .55 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
    }
    return true;
  } catch (error) {
    if (version === loadVersion) {
      $('map-status').textContent = 'Climate data could not load.';
      $('chart').closest('.inspector').setAttribute('aria-busy', 'false');
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'utility';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => selectDate(index));
      $('map-status').append(' ', retry);
      console.error(error);
    }
    return false;
  }
}
function cellIndices(lon, lat) {
  const col = clamp(Math.floor((wrap(lon) + 180) / active.step), 0, active.width - 1);
  const row = clamp(Math.floor((90 - lat) / active.step), 0, active.height - 1);
  return [col, row];
}
function cell([lon, lat]) {
  const [col, row] = cellIndices(lon, lat);
  return { index: row * active.width + col,
    center: [-180 + (col + .5) * active.step, 90 - (row + .5) * active.step] };
}
function history(index) {
  return active.years.map((_, i) => active.values[i * active.size + index]);
}
function yearIndex() { return year - active.years[0]; }
function renderTimelineTicks() {
  const last = timeline.length - 1;
  $('time-ticks').replaceChildren(...[...new Set([0, Math.floor(last / 2), last])].map(index => {
    const {year: tickYear, period} = timeline[index];
    const span = document.createElement('span');
    span.textContent = dateLabel(tickYear, period);
    return span;
  }));
}

function updateTimeline() {
  const label = labelForYear(year);
  const last = timeline.length - 1;
  const unit = mode === 'monthly' ? 'month' : mode === 'seasonal' ? 'season' : 'year';
  Object.assign($('year'), {min: 0, max: last, value: timelineIndex});
  $('year').setAttribute('aria-label', 'Timeline ' + unit);
  $('year').setAttribute('aria-valuetext', mode === 'trend' ? (year - WINDOW + 1) + ' to ' + year : label);
  $('year-label').value = label;
  $('previous').disabled = timelineIndex === 0;
  $('next').disabled = timelineIndex === last;
  $('play').disabled = !last;
  $('previous').setAttribute('aria-label', 'Previous ' + unit);
  $('next').setAttribute('aria-label', 'Next ' + unit);
}

function update(fade = 0) {
  if (!active) return;
  const idx = yearIndex();
  const climate = active.values.subarray(idx * active.size, (idx + 1) * active.size);
  grid = mode === 'trend'
    ? Float32Array.from({length: active.size}, (_, i) => slopeAt(active.values, idx, active.size, i) * 10)
    : climate;
  $('map-year').textContent = mode === 'trend' ? (year - WINDOW + 1) + '–' + year : labelForYear(year);
  $('mode-label').textContent = mode === 'trend' ? '30-YEAR LINEAR TREND' : mode.toUpperCase() + ' ANOMALY';
  $('chart-title').textContent = periodTitle() + ' anomalies';
  updateMapReadout();
  $('legend-title').textContent = (mode === 'trend' ? 'Change / decade' : 'Anomaly') + ' (' + active.unit + ')';
  const scale = mode === 'trend' ? active.trendScale : active.scale;
  cellColors = Int16Array.from(grid, value => Number.isFinite(value)
    ? clamp(Math.round((value / scale + 1) * 127.5), 0, 255) : -1);
  $('legend-min').textContent = '≤ −' + scale;
  $('legend-max').textContent = '≥ +' + scale;
  $('ramp').style.background = 'linear-gradient(90deg,' + themes[themeFor(active)].join(',') + ')';
  updateInspector();
  queueDraw(fade);
}

function sizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(rect.width * ratio), h = Math.round(rect.height * ratio);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  canvas.getContext('2d').setTransform(ratio, 0, 0, ratio, 0, 0);
  return [rect.width, rect.height];
}

function queueDraw(fade = 0) {
  if (typeof fade === 'number') pendingFade = Math.max(pendingFade, fade);
  if (!frame) {
    frame = requestAnimationFrame(() => {
      frame = null;
      const duration = pendingFade;
      pendingFade = 0;
      drawMap(duration);
    });
  }
}

function finishMapFade() {
  outgoingFade?.cancel();
  outgoingFade = null;
}

function crossfadeMap(duration) {
  if (!duration || !rendered || reducedMotion.matches || drag?.moved || cameraFrame) return;
  // Let rapid scrubbing finish the current dissolve instead of stacking fades.
  if (outgoingFade?.playState === 'running') return;
  outgoing.width = earth.width;
  outgoing.height = earth.height;
  outgoingCtx.drawImage(earth, 0, 0);
  const timing = {duration, easing: 'ease-out'};
  outgoingFade = outgoing.animate([{opacity: 1}, {opacity: 0}], timing);
}

function geometry() {
  const scale = Math.min(width / 2.06, height / 2.12) * zoom;
  const cx = width * .5, cy = height * .5;
  if (view === 'globe') {
    globe.rotate(rotation).scale(scale).translate([cx, cy]);
    projection = globe;
    mapBounds = [Math.max(0, cx - scale), Math.max(0, cy - scale), Math.min(width, cx + scale), Math.min(height, cy + scale)];
  } else {
    const [mapWidth, mapHeight] = constrainFlatOffset();
    const x = cx + flatOffset[0], y = cy + flatOffset[1];
    flatMap.translate([x, y]).scale(mapWidth / (2 * Math.PI)).clipExtent([[0, 0], [width, height]]);
    projection = flatMap;
    mapBounds = [
      Math.max(0, x - mapWidth / 2), Math.max(0, y - mapHeight / 2),
      Math.min(width, x + mapWidth / 2), Math.min(height, y + mapHeight / 2)
    ];
  }
}

function mapRaster(moving) {
  const [left, top, right, bottom] = mapBounds;
  const sw = right - left, sh = bottom - top;
  // A smaller raster reduces projection work while the camera is moving.
  const scale = Math.min(1.3, (moving ? 260 : 540) / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
  raster.width = w;
  raster.height = h;
  const indices = new Int32Array(w * h).fill(-1);
  const shade = new Float32Array(w * h).fill(1);
  const [cx, cy] = projection.translate();
  const radius = projection.scale();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = left + (x + .5) * sw / w, py = top + (y + .5) * sh / h;
      const dx = (px - cx) / radius, dy = (py - cy) / radius;
      if (view === 'globe' && dx * dx + dy * dy >= 1) continue;
      const location = projection.invert([px, py]);
      if (!location?.every(Number.isFinite)) continue;
      const index = y * w + x;
      const [col, row] = cellIndices(...location);
      indices[index] = row * active.width + col;
      if (view === 'globe') {
        const z = Math.sqrt(1 - dx * dx - dy * dy);
        shade[index] = .72 + .28 * clamp(-dx * .35 - dy * .45 + z * .88, 0, 1);
      }
    }
  }
  return {indices, shade, moving, image: rasterCtx.createImageData(w, h)};
}

function drawMap(fade) {
  if (!active || !d3 || !grid) return;
  crossfadeMap(fade);
  const oldWidth = width, oldHeight = height;
  [width, height] = sizeCanvas(earth);
  if (width < 1 || height < 1) return;
  if (width !== oldWidth || height !== oldHeight) rasterMap = null;
  ctx.clearRect(0, 0, width, height);
  geometry();
  const draw = d3.geoPath(projection, ctx);
  if (view === 'globe') {
    const [x, y] = projection.translate();
    const r = projection.scale();
    const halo = ctx.createRadialGradient(x, y, r * .95, x, y, r * 1.12);
    halo.addColorStop(0, '#609f9e38');
    halo.addColorStop(.43, '#548a8d20');
    halo.addColorStop(1, '#548a8d00');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, width, height);
  }
  const moving = Boolean(drag?.moved || cameraFrame);
  if (!rasterMap || rasterMap.moving !== moving) rasterMap = mapRaster(moving);
  const {indices, shade, image} = rasterMap;
  const colors = palette[themeFor(active)];
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] < 0) continue;
    const colorIndex = cellColors[indices[i]];
    const color = colorIndex < 0 ? NO_DATA_COLOR : colors[colorIndex];
    const pixel = i * 4;
    image.data[pixel] = color[0] * shade[i];
    image.data[pixel + 1] = color[1] * shade[i];
    image.data[pixel + 2] = color[2] * shade[i];
    image.data[pixel + 3] = 255;
  }
  rasterCtx.putImageData(image, 0, 0);
  const [left, top, right, bottom] = mapBounds;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(raster, left, top, right - left, bottom - top);
  drawLine(draw, d3.geoGraticule10(), '#203d402a', .55);
  drawLine(draw, land, '#122e3199', .68);
  drawLine(draw, borders, '#162e3140', .45);
  drawLine(draw, {type: 'Sphere'}, '#a3c5ba78', 1);
  const location = cell(point).center;
  if (view === 'map' || d3.geoDistance(location, projection.invert(projection.translate())) < Math.PI / 2) {
    const [x, y] = projection(location);
    ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.lineWidth = 2; ctx.strokeStyle = '#14282b'; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.strokeStyle = '#fffce8'; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 2.3, 0, Math.PI * 2);
    ctx.fillStyle = '#fffce8'; ctx.fill();
  }
  rendered = true;
}

function drawLine(draw, feature, color, weight) {
  ctx.beginPath();
  draw(feature);
  ctx.strokeStyle = color;
  ctx.lineWidth = weight;
  ctx.stroke();
}

function coords([lon, lat]) {
  return Math.abs(lat).toFixed(2) + '° ' + (lat >= 0 ? 'N' : 'S') + ' · ' +
    Math.abs(lon).toFixed(2) + '° ' + (lon >= 0 ? 'E' : 'W');
}
function updateInspector() {
  if (!active) return;
  const {index, center} = cell(point);
  const series = history(index);
  const idx = yearIndex();
  const current = series[idx];
  const estimate = trend(series, idx);
  $('place-name').textContent = placeName;
  $('coordinates').textContent = coords(center);
  $('resolution').textContent = active.step + '° grid';
  $('value-label').textContent = labelForYear(year) + ' anomaly';
  setMetric($('value'), current, active.unit);
  setMetric($('slope'), estimate?.rate, active.unit);
  $('chart').setAttribute('aria-label', periodTitle() + ' anomalies in ' + active.unit + ' for ' + coords(center) +
    ', from ' + active.years[0] + ' to ' + active.years.at(-1) + '. Use arrow keys to inspect, Enter to select endpoints, and Escape to clear.');
  $('csv').disabled = !series.some(Number.isFinite);
  const hasTest = estimate?.p != null;
  $('trend-details').hidden = !hasTest;
  $('trend-period').textContent = estimate ? (year - WINDOW + 1) + '–' + year : '';
  if (hasTest) {
    const low = mathNumber(estimate.low, 3);
    const high = mathNumber(estimate.high, 3);
    $('interval').replaceChildren(mathExpression(
      mathToken('mo', '['), low, mathToken('mo', ','), high, mathToken('mo', ']')
    ));
    // The trend and interval share the anomaly's unit, per decade.
    $('p-value').replaceChildren(estimate.p < .001
      ? mathExpression(mathToken('mo', '<'), mathNumber(.001, 3, false))
      : mathExpression(mathNumber(estimate.p, Math.abs(estimate.p - .05) < .001 ? 4 : 3, false)));
    $('inference').textContent = estimate.p < .05 ? 'Significant at 5%' : 'Not significant at 5%';
  } else {
    $('inference').textContent = estimate ? 'Uncertainty estimate unavailable.' : 'Trend requires 30 consecutive years.';
  }
  chartData = {series, idx, estimate};
  updateChartInterval();
  drawChart();
}

const MATH_NS = 'http://www.w3.org/1998/Math/MathML';

function mathToken(tag, text) {
  const node = document.createElementNS(MATH_NS, tag);
  node.textContent = text;
  return node;
}

function mathExpression(...tokens) {
  const math = document.createElementNS(MATH_NS, 'math');
  const row = document.createElementNS(MATH_NS, 'mrow');
  row.append(...tokens);
  math.append(row);
  return math;
}

function mathNumber(value, digits, showSign = true) {
  const formatted = showSign ? signed(value, digits) : value.toFixed(digits);
  if (!/^[+−]/.test(formatted)) return mathToken('mn', formatted);
  const row = document.createElementNS(MATH_NS, 'mrow');
  row.append(mathToken('mo', formatted[0]), mathToken('mn', formatted.slice(1)));
  return row;
}

function setMetric(element, value, unit) {
  if (!Number.isFinite(value)) {
    element.textContent = '—';
    return;
  }
  element.replaceChildren(mathExpression(mathNumber(value, 2), mathToken('mtext', ' ' + unit)));
}

function drawChart() {
  if (!active || !chartData) return;
  const {series, idx, estimate} = chartData;
  const g = chart.getContext('2d');
  const [w, h] = sizeCanvas(chart);
  g.clearRect(0, 0, w, h);
  const dark = document.documentElement.dataset.theme === 'dark';
  const textColor = dark ? '#b1c1b4' : '#526258';
  const observed = series.filter(Number.isFinite);
  const left = 37, right = w - 7, top = 8, bottom = h - 20;
  chartLayout = {left, right, bottom};
  const inspected = chartCursor ?? idx;
  const label = labelForYear(active.years[inspected]) + ' · ' + (Number.isFinite(series[inspected])
    ? signed(series[inspected]) + ' ' + active.unit : 'No data');
  $('chart-readout').textContent = label;
  const tooltip = $('chart-tooltip');
  tooltip.textContent = label;
  tooltip.hidden = chartCursor == null || !observed.length;
  if (!observed.length) {
    g.font = '12px sans-serif'; g.fillStyle = textColor; g.fillText('No observations for this grid cell', 5, h / 2);
    return;
  }
  const min = Math.min(0, ...observed), max = Math.max(0, ...observed);
  const x = i => left + i / (series.length - 1) * (right - left);
  const y = value => bottom - (max === min ? .5 : (value - min) / (max - min)) * (bottom - top);
  const intervalColor = dark ? '#eab37c' : '#934926';
  if (intervalAnchor !== null) {
    const other = intervalEnd ?? chartCursor ?? intervalAnchor;
    g.fillStyle = dark ? '#eab37c38' : '#ce8c5033';
    g.fillRect(Math.min(x(intervalAnchor), x(other)), top, Math.abs(x(intervalAnchor) - x(other)), bottom - top);
  } else if (estimate) {
    g.fillStyle = dark ? '#2d4135' : '#e1eadc';
    g.fillRect(x(idx - WINDOW + 1), top, x(idx) - x(idx - WINDOW + 1), bottom - top);
  }
  g.font = '9px monospace'; g.fillStyle = textColor;
  for (const tick of [...new Set([min, 0, max])]) {
    const ty = y(tick);
    g.beginPath(); g.moveTo(left, ty); g.lineTo(right, ty);
    g.strokeStyle = tick === 0 ? '#a0aa9f' : dark ? '#384a40' : '#dde1d5'; g.lineWidth = 1; g.stroke();
    g.fillText(signed(tick, 1), 0, clamp(ty + 3, 9, bottom + 2));
  }
  g.fillText(active.years[0], left, h - 3);
  g.textAlign = 'right'; g.fillText(active.years.at(-1), right, h - 3); g.textAlign = 'left';
  g.beginPath();
  let connected = false;
  series.forEach((value, i) => {
    if (!Number.isFinite(value)) { connected = false; return; }
    if (connected) g.lineTo(x(i), y(value)); else g.moveTo(x(i), y(value));
    connected = true;
  });
  g.strokeStyle = dark ? '#a6d6b8' : '#2d7655'; g.lineWidth = 1.35; g.stroke();
  if (estimate) {
    g.beginPath();
    g.moveTo(x(idx - WINDOW + 1), y(estimate.mean - estimate.slope * (WINDOW - 1) / 2));
    g.lineTo(x(idx), y(estimate.mean + estimate.slope * (WINDOW - 1) / 2));
    g.strokeStyle = dark ? '#f0a880' : '#a7462c'; g.lineWidth = 1.5; g.stroke();
  }
  g.beginPath(); g.moveTo(x(idx), top); g.lineTo(x(idx), bottom);
  g.strokeStyle = '#51675c'; g.lineWidth = 1; g.setLineDash([3, 3]); g.stroke(); g.setLineDash([]);
  if (Number.isFinite(series[idx])) {
    g.beginPath(); g.arc(x(idx), y(series[idx]), 3.5, 0, Math.PI * 2); g.fillStyle = dark ? '#a6d6b8' : '#24523e'; g.fill();
  }
  for (const endpoint of new Set([intervalAnchor, intervalEnd])) {
    if (endpoint === null) continue;
    const px = x(endpoint);
    g.beginPath(); g.moveTo(px, top); g.lineTo(px, bottom);
    g.lineWidth = 1.5; g.strokeStyle = intervalColor; g.stroke();
    if (Number.isFinite(series[endpoint])) {
      g.beginPath(); g.arc(px, y(series[endpoint]), 4.5, 0, Math.PI * 2);
      g.fillStyle = intervalColor; g.fill();
    }
  }
  if (chartCursor != null) {
    const cursorX = x(inspected);
    g.beginPath(); g.moveTo(cursorX, top); g.lineTo(cursorX, bottom);
    g.strokeStyle = textColor; g.lineWidth = 1; g.stroke();
    if (Number.isFinite(series[inspected])) {
      g.beginPath(); g.arc(cursorX, y(series[inspected]), 4.5, 0, Math.PI * 2);
      g.fillStyle = dark ? '#e8eee4' : '#244e3d'; g.fill();
    }
    tooltip.style.left = clamp(cursorX > w / 2 ? cursorX - tooltip.offsetWidth - 8 : cursorX + 8,
      0, Math.max(0, w - tooltip.offsetWidth)) + 'px';
    // Keep the value to the side of the cursor and above the x-axis labels.
    tooltip.style.top = Math.max(0, bottom - tooltip.offsetHeight - 4) + 'px';
  }
}

function chartIndexAt(event) {
  if (!active || !chartLayout || !chartData) return null;
  const {left, right} = chartLayout;
  if (right <= left) return null;
  const x = event.clientX - chart.getBoundingClientRect().left;
  return Math.round(clamp((x - left) / (right - left), 0, 1) * (active.years.length - 1));
}

function inspectChart(index, announce = false) {
  if (index === chartCursor) return;
  chartCursor = index;
  drawChart();
  if (announce) $('chart-announcement').textContent = $('chart-readout').textContent;
}

function updateChartInterval() {
  $('chart-interval').hidden = intervalAnchor === null;
  $('interval-values').hidden = intervalEnd === null;
  if (intervalAnchor === null || !chartData || !active) return;
  if (intervalEnd === null) {
    $('interval-summary').textContent = labelForYear(active.years[intervalAnchor]) + ' selected. Pick another point.';
    return;
  }
  const start = Math.min(intervalAnchor, intervalEnd);
  const end = Math.max(intervalAnchor, intervalEnd);
  const startYear = active.years[start];
  const endYear = active.years[end];
  const startValue = chartData.series[start];
  const endValue = chartData.series[end];
  $('interval-summary').textContent = startYear + '–' + endYear + ' · ' +
    (endYear - startYear) + (endYear - startYear === 1 ? ' year' : ' years');
  setMetric($('interval-start'), startValue, active.unit);
  setMetric($('interval-end'), endValue, active.unit);
  setMetric($('interval-change'), endValue - startValue, active.unit);
}

function clearChartInterval() {
  intervalAnchor = intervalEnd = null;
  updateChartInterval();
}

function selectChartPoint(index) {
  if (index == null || !chartData) return;
  stop();
  if (intervalAnchor === null || intervalEnd !== null) {
    intervalAnchor = index;
    intervalEnd = null;
  } else if (index !== intervalAnchor) {
    intervalEnd = index;
  }
  updateChartInterval();
  drawChart();
}

$('interval-clear').addEventListener('click', () => {
  clearChartInterval();
  chart.focus();
  drawChart();
});
chart.addEventListener('pointermove', event => inspectChart(chartIndexAt(event)));
chart.addEventListener('pointerleave', () => inspectChart(null));
chart.addEventListener('blur', () => inspectChart(null));
chart.addEventListener('click', event => {
  const index = chartIndexAt(event);
  inspectChart(index);
  selectChartPoint(index);
});
chart.addEventListener('keydown', event => {
  if (!active) return;
  const index = chartCursor ?? yearIndex();
  const next = {ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: active.years.length - 1};
  if (Object.hasOwn(next, event.key)) {
    event.preventDefault();
    inspectChart(clamp(next[event.key], 0, active.years.length - 1), true);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    selectChartPoint(index);
  } else if (event.key === 'Escape') {
    clearChartInterval();
    chartCursor = null;
    drawChart();
  }
});

let playbackRun = 0;

function stop() {
  playing = false;
  playbackRun++;
  clearTimeout(timer);
  $('play').textContent = '▶';
  $('play').setAttribute('aria-label', 'Play timeline');
}

function play() {
  if (playing) { stop(); return; }
  if (timeline.length < 2) return;
  playing = true;
  const run = ++playbackRun;
  $('play').textContent = 'Ⅱ';
  $('play').setAttribute('aria-label', 'Pause timeline');

  async function advance(index) {
    const started = performance.now();
    const next = timeline[index + 1];
    if (next && next.period !== timeline[index].period) {
      // Warm the next period while the current frame is loading or visible.
      loadDataset(layer, next.period).catch(() => {});
    }
    const ready = await selectDate(index);
    if (run !== playbackRun) return;
    if (!ready || !next) { stop(); return; }
    timer = setTimeout(() => advance(index + 1), Math.max(120, 360 - (performance.now() - started)));
  }

  if (timelineIndex === timeline.length - 1) advance(0);
  else timer = setTimeout(() => advance(timelineIndex + 1), 0);
}

function rotate(x, y) {
  rotation = [wrap(x), clamp(y, -89, 89)];
  rasterMap = null; queueDraw();
}
function stopCamera() {
  cancelAnimationFrame(cameraFrame);
  cameraFrame = null;
  zoomTarget = null;
}

function animateCamera(longitude, latitude, targetZoom, duration) {
  stopCamera();
  finishMapFade();
  if (reducedMotion.matches || view !== 'globe' || !active) {
    zoom = targetZoom;
    rotate(longitude, latitude);
    return;
  }

  const [startLon, startLat] = rotation;
  const startZoom = zoom;
  const deltaLon = wrap(longitude - startLon);
  const started = performance.now();
  zoomTarget = targetZoom;
  function step(now) {
    const progress = clamp((now - started) / duration, 0, 1);
    const eased = 1 - (1 - progress) ** 3;
    zoom = startZoom + (targetZoom - startZoom) * eased;
    cameraFrame = progress < 1 ? requestAnimationFrame(step) : null;
    if (!cameraFrame) zoomTarget = null;
    rotate(startLon + deltaLon * eased, startLat + (latitude - startLat) * eased);
  }
  cameraFrame = requestAnimationFrame(step);
}

function coast(velocityX, velocityY) {
  if (reducedMotion.matches || Math.hypot(velocityX, velocityY) < .025) return;
  let last = performance.now();
  const started = last;
  function step(now) {
    const elapsed = Math.min(now - last, 32);
    last = now;
    const decay = Math.exp(-elapsed / 115);
    const distance = 115 * (1 - decay);
    const [longitude, latitude] = rotation;
    const nextLat = latitude + velocityY * distance;
    const nextLon = longitude + velocityX * distance;
    velocityX *= decay;
    velocityY = nextLat < -89 || nextLat > 89 ? 0 : velocityY * decay;
    cameraFrame = now - started < 480 && Math.hypot(velocityX, velocityY) >= .015
      ? requestAnimationFrame(step) : null;
    rotate(nextLon, nextLat);
  }
  cameraFrame = requestAnimationFrame(step);
}

function flatWorldWidth() {
  return Math.max(1, Math.min(width - 18, (height - 16) * 2)) * flatZoom;
}

function constrainFlatOffset() {
  const mapWidth = flatWorldWidth();
  const mapHeight = mapWidth / 2;
  const maxX = Math.max(0, (mapWidth - width) / 2);
  const maxY = Math.max(0, (mapHeight - height) / 2);
  flatOffset = [clamp(flatOffset[0], -maxX, maxX), clamp(flatOffset[1], -maxY, maxY)];
  return [mapWidth, mapHeight];
}

function updateFlatMap() {
  constrainFlatOffset();
  earth.classList.toggle('grab', flatZoom > 1);
  $('map-zoom-out').disabled = flatZoom === 1;
  $('map-zoom-in').disabled = flatZoom === MAX_FLAT_ZOOM;
  $('map-zoom-reset').disabled = flatZoom === 1;
  mapHover = null;
  updateMapReadout();
  finishMapFade();
  rasterMap = null;
  queueDraw();
}

function zoomFlatMap(factor, x = width / 2, y = height / 2) {
  if (view !== 'map' || !width || !height) return;
  const nextZoom = clamp(flatZoom * factor, 1, MAX_FLAT_ZOOM);
  if (nextZoom === flatZoom) return;
  const scale = nextZoom / flatZoom;
  const dx = x - width / 2, dy = y - height / 2;
  flatOffset = [dx + (flatOffset[0] - dx) * scale, dy + (flatOffset[1] - dy) * scale];
  flatZoom = nextZoom;
  updateFlatMap();
}

function resetFlatMap() {
  flatZoom = 1;
  flatOffset = [0, 0];
  updateFlatMap();
}

function recenter() {
  if (view === 'map' && width && height) {
    flatZoom = Math.max(3, flatZoom);
    const mapWidth = flatWorldWidth();
    flatOffset = [-point[0] * mapWidth / 360, point[1] * mapWidth / 360];
    updateFlatMap();
    return;
  }
  animateCamera(-point[0], -point[1], 1, 420);
}

reducedMotion.addEventListener('change', () => {
  if (!reducedMotion.matches) return;
  finishMapFade();
  chartFade?.cancel();
  stopCamera();
  rasterMap = null;
  queueDraw();
});

function locationAt(event) {
  if (!active || !projection || !mapBounds) return null;
  if (!rasterMap) geometry();
  const rect = earth.getBoundingClientRect();
  const x = event.clientX - rect.left, y = event.clientY - rect.top;
  const [left, top, right, bottom] = mapBounds;
  if (x < left || x > right || y < top || y > bottom) return null;
  const [cx, cy] = projection.translate();
  if (view === 'globe' && Math.hypot(x - cx, y - cy) > projection.scale()) return null;
  const location = projection.invert([x, y]);
  return location?.every(Number.isFinite) ? location : null;
}

function updateMapReadout() {
  const output = $('map-readout');
  if (!active || !grid || !mapHover) {
    output.textContent = 'Hover over the map to inspect a cell.';
    return;
  }
  const {index, center} = cell(mapHover);
  const value = grid[index];
  output.textContent = coords(center) + ' · ' + (Number.isFinite(value)
    ? signed(value) + ' ' + active.unit + (mode === 'trend' ? '/decade' : '')
    : 'No data');
}
earth.addEventListener('pointerdown', event => {
  if (!event.isPrimary || event.button !== 0) return;
  stopCamera();
  finishMapFade();
  drag = {id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX,
    lastY: event.clientY, time: event.timeStamp, velocityX: 0, velocityY: 0, moved: false, rotation, flatOffset,
    degreesPerPixel: 180 / Math.PI / Math.max(1, projection?.scale() ?? 150)};
  earth.setPointerCapture(event.pointerId);
  mapHover = null;
  updateMapReadout();
});
earth.addEventListener('pointermove', event => {
  if (drag && event.pointerId !== drag.id) return;
  if (drag) {
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    if (drag.moved && view === 'map' && flatZoom > 1) {
      earth.classList.add('dragging');
      flatOffset = [drag.flatOffset[0] + dx, drag.flatOffset[1] + dy];
      updateFlatMap();
    } else if (drag.moved && view === 'globe') {
      const scale = drag.degreesPerPixel;
      const elapsed = Math.max(1, event.timeStamp - drag.time);
      drag.velocityX = clamp((event.clientX - drag.lastX) * scale / elapsed, -.4, .4);
      drag.velocityY = clamp((drag.lastY - event.clientY) * scale / elapsed, -.4, .4);
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      drag.time = event.timeStamp;
      earth.classList.add('dragging');
      rotate(drag.rotation[0] + dx * scale, drag.rotation[1] - dy * scale);
    }
    return;
  }
  mapHover = event.pointerType === 'mouse' ? locationAt(event) : null;
  updateMapReadout();
});
function releaseDrag(event) {
  if (event.pointerId !== drag?.id) return;
  drag = null;
  earth.classList.remove('dragging');
  queueDraw();
}
earth.addEventListener('pointerup', event => {
  if (event.pointerId !== drag?.id) return;
  const finished = drag;
  releaseDrag(event);
  if (finished.moved) {
    if (view === 'globe' && event.timeStamp - finished.time < 75) coast(finished.velocityX, finished.velocityY);
    return;
  }
  const target = locationAt(event);
  if (target) selectMapCell(target);
});
earth.addEventListener('pointercancel', releaseDrag);
earth.addEventListener('lostpointercapture', releaseDrag);
earth.addEventListener('pointerleave', () => { mapHover = null; updateMapReadout(); });
earth.addEventListener('wheel', event => {
  if (!width || !height || drag || document.activeElement !== earth || event.ctrlKey || event.metaKey) return;
  event.preventDefault();
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1;
  if (view === 'map') {
    const rect = earth.getBoundingClientRect();
    zoomFlatMap(Math.exp(-event.deltaY * unit * .002), event.clientX - rect.left, event.clientY - rect.top);
    return;
  }
  const target = clamp((zoomTarget ?? zoom) * Math.exp(-event.deltaY * unit * .001), 1, 2.6);
  animateCamera(...rotation, target, 130);
}, {passive: false});
function selectMapCell(location) {
  clearChartInterval();
  point = location;
  placeName = 'Selected grid cell';
  $('place-query').value = '';
  updateInspector();
  queueDraw();
}

earth.addEventListener('keydown', event => {
  if (event.key === 'Enter' && active && projection) {
    event.preventDefault();
    if (view === 'map') {
      geometry();
      selectMapCell(projection.invert([width / 2, height / 2]));
    } else {
      selectMapCell([-rotation[0], -rotation[1]]);
    }
    return;
  }
  if (view === 'map') {
    const pan = {ArrowLeft: [48, 0], ArrowRight: [-48, 0], ArrowUp: [0, 48], ArrowDown: [0, -48]}[event.key];
    if (pan && flatZoom > 1) {
      event.preventDefault();
      flatOffset = [flatOffset[0] + pan[0], flatOffset[1] + pan[1]];
      updateFlatMap();
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomFlatMap(FLAT_ZOOM_STEP);
    } else if (event.key === '-') {
      event.preventDefault();
      zoomFlatMap(1 / FLAT_ZOOM_STEP);
    } else if (event.key === 'Home') {
      event.preventDefault();
      resetFlatMap();
    }
    return;
  }
  const directions = {ArrowLeft: [-8,0], ArrowRight: [8,0], ArrowUp: [0,8], ArrowDown: [0,-8]};
  const direction = directions[event.key];
  if (direction) {
    event.preventDefault();
    animateCamera(rotation[0] + direction[0], clamp(rotation[1] + direction[1], -89, 89), zoom, 150);
  }
});

function changeView(next) {
  if (view === next && rendered) return;
  stopCamera();
  view = next;
  mapHover = null;
  updateMapReadout();
  for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', button.dataset.view === view);
  earth.classList.toggle('grab', view === 'globe' || flatZoom > 1);
  earth.setAttribute('aria-label', view === 'globe'
    ? 'Climate globe. Use arrow keys to rotate and Enter to select the center cell. Click a cell to select it.'
    : 'Flat climate map. Use plus and minus to zoom, drag or use arrows to pan, and press Enter to inspect the center cell.');
  $('flat-tools').hidden = view !== 'map';
  if (view === 'map' && width && height) updateFlatMap();
  $('map').dataset.view = view;
  rasterMap = null;
  queueDraw(200);
}

function normalizePlace(query) {
  return query.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

function searchPlaces(query) {
  const needle = normalizePlace(query);
  if (!needle) {
    return cities.filter(place => place.kind === 'region').concat(
      cities.filter(place => place.kind !== 'region').slice(0, 12)
    );
  }
  const scored = [];
  for (const place of cities) {
    const name = normalizePlace(place.name);
    const region = normalizePlace(place.region || '');
    const haystack = name + ' ' + region;
    if (!haystack.includes(needle)) continue;
    const score = (name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : 2)
      + (place.kind === 'region' ? -.1 : 0);
    scored.push({place, score});
  }
  scored.sort((a, b) => a.score - b.score || a.place.name.localeCompare(b.place.name));
  return scored.slice(0, 12).map(entry => entry.place);
}

function closePlaceResults() {
  placeMatches = [];
  placeActive = -1;
  $('place-results').hidden = true;
  $('place-results').replaceChildren();
  $('place-query').setAttribute('aria-expanded', 'false');
}

function renderPlaceResults(matches) {
  placeMatches = matches;
  placeActive = matches.length ? 0 : -1;
  const list = $('place-results');
  if (!matches.length) {
    list.replaceChildren(Object.assign(document.createElement('li'), {
      className: 'place-empty',
      textContent: 'No matching city. Try another name, or click the map.',
      role: 'presentation',
    }));
    list.hidden = false;
    $('place-query').setAttribute('aria-expanded', 'true');
    return;
  }
  list.replaceChildren(...matches.map((place, index) => {
    const item = document.createElement('li');
    item.setAttribute('role', 'option');
    item.id = 'place-option-' + index;
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-selected', index === placeActive ? 'true' : 'false');
    button.innerHTML = '<span class="place-name"></span><span class="place-region"></span>';
    button.querySelector('.place-name').textContent = place.name;
    button.querySelector('.place-region').textContent = place.region || '';
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => goToPlace(place));
    item.append(button);
    return item;
  }));
  list.hidden = false;
  $('place-query').setAttribute('aria-expanded', 'true');
  $('place-query').setAttribute('aria-activedescendant', placeActive >= 0 ? 'place-option-' + placeActive : '');
}

function highlightPlace(index) {
  if (!placeMatches.length) return;
  placeActive = (index + placeMatches.length) % placeMatches.length;
  for (const [i, item] of [...$('place-results').children].entries()) {
    const button = item.querySelector('button');
    if (button) button.setAttribute('aria-selected', i === placeActive ? 'true' : 'false');
  }
  $('place-query').setAttribute('aria-activedescendant', 'place-option-' + placeActive);
  $('place-option-' + placeActive)?.scrollIntoView({block: 'nearest'});
}

function goToPlace(place) {
  clearChartInterval();
  placeName = place.name;
  point = [place.lon, place.lat];
  $('place-query').value = place.name;
  closePlaceResults();
  recenter();
  updateInspector();
  queueDraw();
}

$('place-query').addEventListener('focus', () => {
  renderPlaceResults(searchPlaces($('place-query').value));
});
$('place-query').addEventListener('input', () => {
  renderPlaceResults(searchPlaces($('place-query').value));
});
$('place-query').addEventListener('keydown', event => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if ($('place-results').hidden) renderPlaceResults(searchPlaces($('place-query').value));
    else highlightPlace(placeActive + 1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (!$('place-results').hidden) highlightPlace(placeActive - 1);
  } else if (event.key === 'Enter') {
    if (placeActive >= 0 && placeMatches[placeActive]) {
      event.preventDefault();
      goToPlace(placeMatches[placeActive]);
    }
  } else if (event.key === 'Escape') {
    closePlaceResults();
    $('place-query').blur();
  }
});
$('place-query').addEventListener('blur', () => {
  setTimeout(closePlaceResults, 120);
});
$('mode').addEventListener('change', event => {
  mode = event.target.value;
  refreshPeriodControl();
  if (catalog) selectLayer(layer);
});
$('period').addEventListener('change', event => {
  stop();
  const period = event.target.value;
  let bestIndex = timelineIndex;
  let bestDistance = Infinity;
  timeline.forEach((entry, index) => {
    const distance = Math.abs(entry.year - year);
    if (entry.period === period && distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  });
  selectDate(bestIndex);
});
$('year').addEventListener('input', event => {
  stop();
  selectDate(Number(event.target.value));
});
$('play').addEventListener('click', play);
$('previous').addEventListener('click', () => { stop(); selectDate(timelineIndex - 1); });
$('next').addEventListener('click', () => { stop(); selectDate(timelineIndex + 1); });
$('recenter').addEventListener('click', recenter);
$('map-zoom-in').addEventListener('click', () => zoomFlatMap(FLAT_ZOOM_STEP));
$('map-zoom-out').addEventListener('click', () => zoomFlatMap(1 / FLAT_ZOOM_STEP));
$('map-zoom-reset').addEventListener('click', resetFlatMap);
$('csv').addEventListener('click', () => {
  if (!active) return;
  const {index, center} = cell(point);
  const series = history(index);
  const rows = ['year,anomaly,unit,latitude,longitude,baseline,product,period',
    ...active.years.map((y, i) => [y, Number.isFinite(series[i]) ? series[i].toFixed(5) : '',
      active.unit, center[1], center[0], active.reference, active.product, periodKey()].join(','))];
  const url = URL.createObjectURL(new Blob([rows.join('\n') + '\n'], {type: 'text/csv;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url; link.download = layer + '-' + periodKey() + '-' + center[1] + '-' + center[0] + '.csv';
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => changeView(button.dataset.view));
$('layer').addEventListener('change', event => selectLayer(event.target.value));

function populateLayers() {
  const groups = new Map();
  for (const [key, data] of Object.entries(catalog)) {
    if (!groups.has(data.group)) {
      const group = document.createElement('optgroup');
      group.label = data.group;
      groups.set(data.group, group);
    }
    groups.get(data.group).append(new Option(data.name, key));
  }
  $('layer').replaceChildren(...groups.values());
  $('layer').value = layer;
  $('layer').disabled = false;
}

document.addEventListener('atlas-theme-change', () => { if (active) updateInspector(); });
new ResizeObserver(queueDraw).observe(earth);
new ResizeObserver(() => { if (active) updateInspector(); }).observe($('chart'));

try {
  [catalog, land, borders, cities] = await Promise.all(
    ['catalog.json', 'land.json', 'countries.json', 'cities.json'].map(async file => (await fetchAsset(file)).json())
  );
  d3 = window.d3;
  globe = d3.geoOrthographic().clipAngle(90);
  flatMap = d3.geoEquirectangular();
  land = window.topojson.feature(land, land.objects.land);
  borders = window.topojson.mesh(borders, borders.objects.countries, (a, b) => a !== b);
  populateLayers();
  changeView(view);
  await selectLayer(layer);
} catch (error) {
  $('map-status').textContent = 'The atlas could not initialize. Reload to retry.';
  console.error(error);
}
