import { WINDOW, slopeAt, trend } from './statistics.js';

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
const places = {
  arctic: ['Canadian Arctic', -95, 74],
  toronto: ['Toronto', -79.38, 43.65],
  pacific: ['Equatorial Pacific', -137, 0],
  amazon: ['Central Amazon', -62, -4],
  sahel: ['West African Sahel', 2, 15],
  india: ['Central India', 79, 22],
  antarctica: ['East Antarctica', 88, -76],
};
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
let layer = 'temperature', view = 'globe', mode = 'annual', year = 2025;
let rotation = [93, -46], zoom = 1, placeKey = 'arctic', point = places.arctic.slice(1);
let timer, frame, drag, active, width, height, mapBounds, rasterMap, grid;
let cameraFrame, zoomTarget, cellColors;
let chartData, chartCursor, chartLayout;
const chart = $('chart');
const datasets = new Map();
const months = new Map([
  ['01', 'January'], ['02', 'February'], ['03', 'March'], ['04', 'April'],
  ['05', 'May'], ['06', 'June'], ['07', 'July'], ['08', 'August'],
  ['09', 'September'], ['10', 'October'], ['11', 'November'], ['12', 'December'],
]);
const seasons = new Map([['djf', 'Dec–Feb'], ['mam', 'Mar–May'], ['jja', 'Jun–Aug'], ['son', 'Sep–Nov']]);
let month = '01', season = 'djf', loadVersion = 0;
let mapHover = null;

function periodKey() {
  if (mode === 'monthly') return month;
  if (mode === 'seasonal') return season;
  return 'annual';
}

function periodTitle() {
  return months.get(periodKey()) ?? seasons.get(periodKey()) ?? 'Annual';
}

function dateLabel(y) {
  const prefix = mode === 'monthly' ? months.get(month).slice(0, 3)
    : mode === 'seasonal' ? seasons.get(season) : '';
  return prefix ? prefix + ' ' + y : String(y);
}

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

async function selectLayer(key) {
  stop();
  stopCamera();
  const version = ++loadVersion;
  layer = key;
  active = null;
  chartData = chartCursor = chartLayout = null;
  $('chart-tooltip').hidden = true;
  $('chart-readout').textContent = '';
  chart.getContext('2d').clearRect(0, 0, chart.width, chart.height);
  mapHover = null;
  updateMapReadout();
  $('map-status').hidden = false;
  $('map-status').textContent = 'Loading climate data…';
  const info = catalog[key];
  $('layer-description').textContent = info.description;
  $('map-source').textContent = info.shortSource;
  $('map-source').href = info.source;
  $('layer-baseline').textContent = '';
  $('csv').disabled = true;
  try {
    const data = await loadDataset(key, periodKey());
    if (version !== loadVersion) return;
    active = data;
    rasterMap = null;
    year = clamp(year, minimumYear(), active.years.at(-1));
    $('map-status').hidden = true;
    update(220);
    if (!reducedMotion.matches) {
      chartFade?.cancel();
      chartFade = chart.animate([{ opacity: .55 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
    }
  } catch (error) {
    if (version === loadVersion) {
      $('map-status').textContent = 'Climate data could not load.';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'utility';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => selectLayer(key));
      $('map-status').append(' ', retry);
      console.error(error);
    }
  }
}

function minimumYear() { return active.years[mode === 'trend' ? WINDOW - 1 : 0]; }
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
function setYear(next) {
  if (!active) return;
  const selected = clamp(next, minimumYear(), active.years.at(-1));
  if (selected === year) return;
  year = selected;
  update(160);
}

function update(fade = 0) {
  if (!active) return;
  const idx = yearIndex();
  const climate = active.values.subarray(idx * active.size, (idx + 1) * active.size);
  grid = mode === 'trend'
    ? Float32Array.from({length: active.size}, (_, i) => slopeAt(active.values, idx, active.size, i) * 10)
    : climate;
  const min = minimumYear();
  const max = active.years.at(-1);
  Object.assign($('year'), {min, max, value: year});
  $('year').setAttribute('aria-valuetext', mode === 'trend' ? (year - WINDOW + 1) + ' to ' + year : dateLabel(year));
  $('year-label').value = dateLabel(year);
  $('time-ticks').replaceChildren(...[min, Math.round((min + max) / 2), max].map(tick => {
    const span = document.createElement('span'); span.textContent = tick; return span;
  }));
  $('previous').disabled = year === min;
  $('next').disabled = year === max;
  $('map-year').textContent = mode === 'trend' ? (year - WINDOW + 1) + '–' + year : dateLabel(year);
  $('mode-label').textContent = mode === 'trend' ? '30-YEAR LINEAR TREND' : mode.toUpperCase() + ' ANOMALY';
  $('layer-baseline').textContent = active.years[0] + '–' + max + ' · Baseline ' + active.reference;
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
    const mapWidth = Math.min(width - 18, (height - 16) * 2);
    projection = d3.geoEquirectangular().translate([cx, cy]).scale(mapWidth / (2 * Math.PI));
    mapBounds = [cx - mapWidth / 2, cy - mapWidth / 4, cx + mapWidth / 2, cy + mapWidth / 4];
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
  const moving = view === 'globe' && Boolean(drag?.moved || cameraFrame);
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
  $('place-name').textContent = places[placeKey]?.[0] ?? 'Selected grid cell';
  $('coordinates').textContent = coords(center);
  $('resolution').textContent = active.step + '° grid';
  $('value-label').textContent = dateLabel(year) + ' anomaly';
  setMetric($('value'), current, active.unit);
  setMetric($('slope'), estimate?.rate, active.unit);
  $('chart').setAttribute('aria-label', periodTitle() + ' anomalies in ' + active.unit + ' for ' + coords(center) +
    ', from ' + active.years[0] + ' to ' + active.years.at(-1) + '. Use the arrow keys to read values and Enter to set the map year.');
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
  const label = dateLabel(active.years[inspected]) + ' · ' + (Number.isFinite(series[inspected])
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
  if (estimate) {
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

function jumpToChartYear(index) {
  if (index == null || !active) return;
  const selected = active.years[index];
  stop();
  if (mode === 'trend' && selected < minimumYear()) {
    mode = 'annual';
    $('mode').value = mode;
  }
  setYear(selected);
}

chart.addEventListener('pointermove', event => inspectChart(chartIndexAt(event)));
chart.addEventListener('pointerleave', () => inspectChart(null));
chart.addEventListener('blur', () => inspectChart(null));
chart.addEventListener('click', event => {
  const index = chartIndexAt(event);
  inspectChart(index);
  jumpToChartYear(index);
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
    jumpToChartYear(index);
  } else if (event.key === 'Escape') {
    inspectChart(null);
  }
});

function stop() {
  clearInterval(timer); timer = undefined;
  $('play').textContent = '▶';
  $('play').setAttribute('aria-label', 'Play timeline');
}
function play() {
  if (!active) return;
  if (timer) { stop(); return; }
  if (year === active.years.at(-1)) setYear(minimumYear());
  $('play').textContent = 'Ⅱ'; $('play').setAttribute('aria-label', 'Pause timeline');
  timer = setInterval(() => {
    if (year < active.years.at(-1)) setYear(year + 1);
    if (year === active.years.at(-1)) stop();
  }, 360);
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

function recenter() {
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
    lastY: event.clientY, time: event.timeStamp, velocityX: 0, velocityY: 0, moved: false, rotation,
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
    if (drag.moved && view === 'globe') {
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
  if (target) {
    point = target; placeKey = 'custom';
    updateInspector(); queueDraw();
  }
});
earth.addEventListener('pointercancel', releaseDrag);
earth.addEventListener('lostpointercapture', releaseDrag);
earth.addEventListener('pointerleave', () => { mapHover = null; updateMapReadout(); });
earth.addEventListener('wheel', event => {
  if (view !== 'globe' || document.activeElement !== earth) return;
  event.preventDefault();
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1;
  const target = clamp((zoomTarget ?? zoom) * Math.exp(-event.deltaY * unit * .001), 1, 2.6);
  animateCamera(...rotation, target, 130);
}, {passive: false});
earth.addEventListener('keydown', event => {
  if (view !== 'globe') return;
  const directions = {ArrowLeft: [-8,0], ArrowRight: [8,0], ArrowUp: [0,8], ArrowDown: [0,-8]};
  const direction = directions[event.key];
  if (direction) {
    event.preventDefault();
    animateCamera(rotation[0] + direction[0], clamp(rotation[1] + direction[1], -89, 89), zoom, 150);
  } else if (event.key === 'Enter') {
    point = [-rotation[0], -rotation[1]]; placeKey = 'custom';
    updateInspector(); queueDraw();
  }
});

function changeView(next) {
  if (view === next && rendered) return;
  stopCamera();
  view = next;
  mapHover = null;
  updateMapReadout();
  for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', button.dataset.view === view);
  earth.classList.toggle('grab', view === 'globe');
  earth.setAttribute('aria-label', view === 'globe'
    ? 'Climate globe. Use arrow keys to rotate and Enter to select the center cell. Click a cell to select it.'
    : 'Flat climate map. Click a cell to select it, or use the location menu.');
  $('recenter').hidden = view === 'map';
  $('map').dataset.view = view;
  rasterMap = null;
  queueDraw(200);
}

$('place').addEventListener('change', event => {
  const selected = event.target.value;
  if (!selected) return;
  event.target.value = '';
  placeKey = selected;
  point = places[placeKey].slice(1);
  recenter(); updateInspector();
});
$('mode').addEventListener('change', event => {
  mode = event.target.value;
  refreshPeriodControl();
  if (catalog) selectLayer(layer);
});
$('period').addEventListener('change', event => {
  if (mode === 'monthly') month = event.target.value;
  if (mode === 'seasonal') season = event.target.value;
  if (catalog) selectLayer(layer);
});
$('year').addEventListener('input', event => { stop(); setYear(Number(event.target.value)); });
$('play').addEventListener('click', play);
$('previous').addEventListener('click', () => { stop(); setYear(year - 1); });
$('next').addEventListener('click', () => { stop(); setYear(year + 1); });
$('recenter').addEventListener('click', recenter);
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
  [catalog, land, borders] = await Promise.all(['catalog.json', 'land.json', 'countries.json'].map(async file => (await fetchAsset(file)).json()));
  d3 = window.d3;
  globe = d3.geoOrthographic().clipAngle(90);
  land = window.topojson.feature(land, land.objects.land);
  borders = window.topojson.mesh(borders, borders.objects.countries, (a, b) => a !== b);
  populateLayers();
  changeView(view);
  await selectLayer(layer);
} catch (error) {
  $('map-status').textContent = 'The atlas could not initialize. Reload to retry.';
  console.error(error);
}
