import { WINDOW, slopeAt, trend, forecast, extendGrid } from './statistics.js';
import { months, seasons, dateLabel, makeTimeline, nearestIndex, futureYears } from './timeline.js';

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
let countryFeatures = [];
let provinces = [];
let majorCities = [];
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

const MAX_FLAT_ZOOM = 16;
const MAX_GLOBE_ZOOM = 2.6;
const GLOBE_ZOOM_STEP = 1.35;
const FLAT_ZOOM_STEP = 1.5;
const DEFAULT_ROTATION = [93, -46];
let catalog, land, borders, d3, globe, projection;
let layer = 'temperature', view = 'map', mode = 'annual', year = 2025;
let rotation = [...DEFAULT_ROTATION], zoom = 1, placeName = DEFAULT_PLACE.name, point = [DEFAULT_PLACE.lon, DEFAULT_PLACE.lat];
let comparisons = [], choosingComparison = false, primaryQuery = '';
// Comparison places are lettered B, C, D… and take a color each, cycling after eight.
const COMPARE_COLORS = {
  light: ['#14688b', '#b5479b', '#a87900', '#00857a', '#7a5c3e', '#d1457a', '#5a6a7a', '#6b7a1e'],
  dark: ['#8ed9f3', '#f4a3df', '#f0cf6b', '#7fe0d4', '#d9b896', '#ff9dbd', '#b9c7d4', '#c9d67a'],
};
const compareLabel = i => i < 25 ? String.fromCharCode(66 + i) : 'P' + (i + 2);
const compareColor = (i, dark = document.documentElement.dataset.theme === 'dark') =>
  COMPARE_COLORS[dark ? 'dark' : 'light'][i % COMPARE_COLORS.light.length];
// Lets CSS pick the light or dark color without re-rendering on a theme change.
function tint(element, i) {
  element.style.setProperty('--cl', compareColor(i, false));
  element.style.setProperty('--cd', compareColor(i, true));
  return element;
}
function make(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
let timer, frame, drag, active, width, height, mapBounds, rasterMap, grid;
let cameraFrame, zoomTarget, cellColors;
let flatMap, flatZoom = 1, flatOffset = [0, 0];
let chartData, chartCursor;
const chartLayouts = new Map();
// Visible slice of the chart in index units, or null for the whole record.
let chartView = null;
const MIN_CHART_SPAN = 8;
let intervalAnchor = null, intervalEnd = null;
let placeMatches = [], placeActive = -1;
const chart = $('chart');
const datasets = new Map();
const baselineRequests = new Map();
let month = '01', season = 'djf', loadVersion = 0;
let timeline = [], timelineIndex = 0, playing = false;
let mapHover = null;
let projectedNow = false;
const PROJ = {light: '#6a4fd0', dark: '#b7a6ff'};
const lastObservedIndex = () => timeline.findLastIndex(entry => !entry.projected);

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
  const base = file.endsWith('.bin') && window.ATLAS_DATA_BASE
    ? window.ATLAS_DATA_BASE : 'assets/';
  const response = await fetch(base + file);
  if (!response.ok) throw new Error(file + ': HTTP ' + response.status);
  return response;
}

async function decodeGrid(entry, size) {
  const response = await fetchAsset(entry.file);
  const bytes = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const packed = entry.precision != null;
  if (bytes.byteLength !== size * (packed ? 2 : 4)) throw new Error('Data size mismatch');
  if (!packed && new Uint8Array(new Uint16Array([1]).buffer)[0] === 1) return new Float32Array(bytes);

  const decoded = new DataView(bytes);
  const values = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    if (packed) {
      const value = decoded.getInt16(2 * i, true);
      values[i] = value === -32768 ? NaN : value * entry.precision;
    } else {
      values[i] = decoded.getFloat32(4 * i, true);
    }
  }
  return values;
}

async function loadBaseline(info, period) {
  const entry = info.climatology;
  const frame = entry?.periods.indexOf(period);
  if (frame == null || frame < 0) return null;
  const size = info.width * info.height;
  let request = baselineRequests.get(entry.file);
  if (!request) {
    request = decodeGrid(entry, size * entry.periods.length).catch(error => {
      if (baselineRequests.get(entry.file) === request) baselineRequests.delete(entry.file);
      console.warn('Historical baseline could not load:', error);
      return null;
    });
  }
  baselineRequests.delete(entry.file);
  baselineRequests.set(entry.file, request);
  if (baselineRequests.size > 4) baselineRequests.delete(baselineRequests.keys().next().value);
  const baselines = await request;
  return baselines?.subarray(frame * size, (frame + 1) * size) ?? null;
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
    // Continue every cell's latest 30-year trend so the timeline can run past the record.
    const size = info.width * info.height;
    const values = await decodeGrid(entry, size * entry.years.length);
    const future = futureYears(entry.years);
    return { ...info, years: entry.years.concat(future), observed: entry.years.length,
      values: extendGrid(values, info.width, entry.years.length, future.length, future[0]), size };
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
  const wasProjected = projectedNow;
  let index = nearestIndex(timeline, mode, year, periodKey());
  // A layer with a shorter record should open on its latest data, not a projection.
  if (!wasProjected) while (index > 0 && timeline[index].projected) index--;
  return selectDate(index);
}

async function selectDate(index, {scrub = false} = {}) {
  const entry = timeline[index];
  if (!entry) return false;
  const {period} = entry;
  const version = ++loadVersion;
  timelineIndex = index;
  year = entry.year;
  projectedNow = Boolean(entry.projected);
  if (mode === 'monthly') month = period;
  if (mode === 'seasonal') season = period;
  $('period').value = period;
  updateTimeline();

  if (active?.key === layer && active.period === period) {
    update(scrub ? 0 : 160, {scrub});
    return true;
  }
  active = null;
  chartData = chartCursor = chartView = null;
  chartLayouts.clear();
  monthlyDetailVersion++;
  monthlyWindow = null;
  if (showMonthly) drawMonthlyDetail();
  clearChartInterval();
  updateZoomControls();
  $('chart').closest('.inspector').setAttribute('aria-busy', 'true');
  $('historical-averages').hidden = true;
  $('chart-tooltip').hidden = $('preview-tooltip').hidden = true;
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
  $('raw-source').textContent = info.shortSource;
  $('raw-source').href = info.source;
  renderSources();
  $('layer-baseline').textContent = timeline[0].year + '–' + timeline[Math.max(0, lastObservedIndex())].year + ' · Baseline ' + info.reference;
  for (const id of ['csv', 'chart-png', 'trend-json', 'map-png']) $(id).disabled = true;
  try {
    const [data, baselineGrid] = await Promise.all([loadDataset(key, period), loadBaseline(info, period)]);
    if (version !== loadVersion) return false;
    active = { ...data, key, period, baselineGrid };
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
  const lastObserved = lastObservedIndex();
  const hasFuture = lastObserved < last;
  $('zone-proj').style.width = last ? (1 - lastObserved / last) * 100 + '%' : '0';
  $('timeline-note').hidden = !hasFuture;
  $('time-ticks').classList.toggle('with-future', hasFuture);
  $('time-ticks').replaceChildren(...[...new Set(hasFuture ? [0, lastObserved, last] : [0, Math.floor(last / 2), last])].map(index => {
    const {year: tickYear, period} = timeline[index];
    const span = document.createElement('span');
    span.textContent = dateLabel(tickYear, period);
    if (hasFuture) span.style.left = index / last * 100 + '%';
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
  Object.assign($('year-entry'), {value: year, disabled: false});
  $('timeline-period').textContent = label.slice(0, -String(year).length).trim();
  $('timeline-period').hidden = periodKey() === 'annual';
  $('timeline-projected').hidden = !projectedNow;
  setYearEntryStatus('');
  $('year').closest('.timeline').classList.toggle('is-projected', projectedNow);
  $('jump-latest').hidden = !projectedNow;
  $('projected-badge').hidden = !projectedNow;
  $('map').closest('.map-panel').classList.toggle('is-projected', projectedNow);
  $('previous').disabled = timelineIndex === 0;
  $('next').disabled = timelineIndex === last;
  $('play').disabled = !last;
  $('previous').setAttribute('aria-label', 'Previous ' + unit);
  $('next').setAttribute('aria-label', 'Next ' + unit);
}

function setYearEntryStatus(message) {
  $('year-entry-status').textContent = message;
  $('year-entry-status').hidden = !message;
}

function jumpToTypedYear() {
  const input = $('year-entry');
  const typed = input.value.trim();
  if (typed === String(year) || !timeline.length) return;
  if (!/^\d{4}$/.test(typed)) {
    input.value = year;
    setYearEntryStatus('Enter a four-digit year.');
    return;
  }
  const period = periodKey();
  const entries = timeline.filter(entry => entry.period === period);
  const requested = Number(typed);
  const target = clamp(requested, entries[0].year, entries.at(-1).year);
  stop();
  selectDate(nearestIndex(timeline, mode, target, period));
  if (target !== requested) {
    setYearEntryStatus('Available years ' + entries[0].year + '–' + entries.at(-1).year + '. Showing ' + target + '.');
  }
}

function update(fade = 0, {scrub = false} = {}) {
  if (!active) return;
  const idx = yearIndex();
  const climate = active.values.subarray(idx * active.size, (idx + 1) * active.size);
  grid = mode === 'trend'
    ? Float32Array.from({length: active.size}, (_, i) => slopeAt(active.values, idx, active.size, i) * 10)
    : climate;
  $('map-year').textContent = mode === 'trend' ? (year - WINDOW + 1) + '–' + year : labelForYear(year);
  $('mode-label').textContent = mode === 'trend' ? '30-YEAR LINEAR TREND'
    : (projectedNow ? 'PROJECTED ' : '') + mode.toUpperCase() + ' ANOMALY';
  $('chart-preview-title').textContent = periodTitle() + ' anomalies';
  $('chart-title').textContent = showMonthly ? 'Monthly anomalies' : $('chart-preview-title').textContent;
  updateMapReadout();
  $('legend-title').textContent = (mode === 'trend' ? 'Change / decade' : 'Anomaly') + ' (' + active.unit + ')';
  const scale = mode === 'trend' ? active.trendScale : active.scale;
  cellColors = Int16Array.from(grid, value => Number.isFinite(value)
    ? clamp(Math.round((value / scale + 1) * 127.5), 0, 255) : -1);
  $('legend-min').textContent = '≤ −' + scale;
  $('legend-max').textContent = '≥ +' + scale;
  $('ramp').style.background = 'linear-gradient(90deg,' + themes[themeFor(active)].join(',') + ')';
  // The chart is the slow part. While the thumb is moving, keep the map in step
  // and paint the chart once the year is released.
  if (!scrub) updateInspector();
  else if (chartData?.other) {
    updateLocationValues(chartData, idx);
    const basis = Math.min(idx, active.observed - 1);
    updateComparisonTrend(chartData, basis, slopeAt(chartData.series, basis) * 10);
  }
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
  comparisons.forEach((place, i) => drawPlaceMarker(cell(place.point).center, i));
  drawPlaceMarker(cell(point).center);
  rendered = true;
}

function drawPlaceMarker(location, n = -1) {
  if (view === 'globe' && d3.geoDistance(location, projection.invert(projection.translate())) >= Math.PI / 2) return;
  const [x, y] = projection(location);
  const other = n >= 0;
  const color = other ? compareColor(n, true) : '#fffce8';
  ctx.beginPath();
  if (other) {
    ctx.moveTo(x, y - 11);
    ctx.lineTo(x + 11, y);
    ctx.lineTo(x, y + 11);
    ctx.lineTo(x - 11, y);
    ctx.closePath();
  } else {
    ctx.arc(x, y, 7, 0, Math.PI * 2);
  }
  ctx.lineWidth = 5; ctx.strokeStyle = '#14282b'; ctx.stroke();
  ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, 2.3, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
  if (!comparisons.length) return;
  ctx.font = '700 12px "IBM Plex Mono", monospace';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const letter = other ? compareLabel(n) : 'A';
  ctx.lineWidth = 4; ctx.strokeStyle = '#14282b'; ctx.lineJoin = 'round'; ctx.strokeText(letter, x + 14, y);
  ctx.fillText(letter, x + 14, y);
  ctx.textBaseline = 'alphabetic';
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
  // For projected years the trend shown is the one the projection continues.
  const basis = Math.min(idx, active.observed - 1);
  const estimate = trend(series, basis);
  const basisYear = active.years[basis];
  const steps = active.years.length - active.observed;
  let future = steps ? forecast(series, active.observed - 1, steps, active.years[active.observed]) : null;
  // Only the single-place view shows values filled from neighboring cells.
  if (!future && steps) {
    if (comparisons.length) {
      series.fill(NaN, active.observed);
    } else {
      const tail = series.slice(active.observed);
      if (tail.every(Number.isFinite)) {
        future = tail.map(value => ({value, low: value, high: value, filled: true}));
      }
    }
  }
  // Measured values, then the central projection (the map shows the simulated year instead).
  const central = future ? series.map((value, i) => i < active.observed ? value : future[i - active.observed].value) : series;
  const others = comparisons.map((place, n) => {
    const otherIndex = cell(place.point).index;
    const measured = history(otherIndex).slice(0, active.observed);
    const projected = steps ? forecast(measured, active.observed - 1, steps, active.years[active.observed]) : null;
    return {index: otherIndex, name: place.name, label: compareLabel(n), n,
      values: measured.concat(projected?.map(f => f.value) ?? []), future: projected};
  });
  const other = others[0] ?? null;
  const otherFuture = others.some(o => o.future);
  chartData = {series, central, idx, index, estimate, basis, future, other, others};
  updateZoomControls();
  updateScatter();
  $('place-name').textContent = placeName;
  $('coordinates').textContent = coords(point);
  $('resolution').textContent = active.step + '° grid';
  updateLocationValues(chartData, idx);
  updateHistoricalAverages(chartData);
  setMetric($('slope'), estimate?.rate, active.unit, {stackUnit: active.unit.length > 3});
  $('chart').setAttribute('aria-label', periodTitle() + ' anomalies in ' + active.unit + ' for ' + placeName +
    comparisons.map(place => ' and ' + place.name).join('') +
    ', measured from ' + active.years[0] + ' to ' + active.years[active.observed - 1] +
    (steps ? ' and projected to ' + active.years.at(-1) : '') + '. Use arrow keys to inspect, Enter to select endpoints, and Escape to clear.');
  $('chart-primary-legend').textContent = other ? 'A record' : 'Measured';
  $('chart-fit-legend').textContent = other ? 'A trend line' : 'Trend line';
  $('chart-projection-legend').hidden = !future;
  $('chart-path-legend').hidden = !future;
  $('chart-projection-text').textContent = other ? 'A projection and range' : 'Projection, with 95% range';
  $('chart-path-text').textContent = other ? 'A possible path' : 'One possible path';
  for (const id of ['chart-compare-legend', 'preview-compare-legend']) {
    $(id).hidden = !other;
    $(id).replaceChildren(...others.map(o => make('span', {},
      tint(make('i', {className: 'lg lg-cmp'}), o.n), o.label + ' ' + o.name)));
  }
  $('chart-compare-projection').hidden = !otherFuture;
  $('chart-compare-projection').lastChild.textContent = others.length > 1 ? 'Comparison projections' : 'B projection';
  $('preview-primary-legend').textContent = other ? 'A record' : 'Measured';
  $('preview-projection-legend').hidden = !future && !otherFuture;
  $('chart-preview').setAttribute('aria-label', periodTitle() + ' anomalies for ' + placeName +
    comparisons.map(place => ' and ' + place.name).join(''));
  $('chart-help').textContent = (other ? 'Select two points to fit that span for A. All records share the same scale.'
    : 'The line fits this place’s measured record. Select two points to fit that span.') +
    ' Zoom with + and −, a pinch, or Ctrl + scroll, then drag to move along the years.';
  $('trend-title').textContent = other ? 'Trend significance for A' : 'Trend significance';
  $('map-places').replaceChildren(
    make('span', {}, make('i', {className: 'place-symbol primary-symbol'}), make('b', {}, 'A'), ' ' + placeName),
    ...others.map(o => tint(make('span', {className: 'cmp-map'},
      make('i', {className: 'place-symbol comparison-symbol'}), make('b', {}, o.label), ' ' + o.name), o.n)));
  const empty = !series.some(Number.isFinite);
  for (const id of ['csv', 'trend-json']) $(id).disabled = empty;
  $('chart-png').disabled = empty && !others.some(o => o.values.some(Number.isFinite));
  $('csv').querySelector('b').textContent = other ? 'Primary data and projection' : 'Data, trend line and projection';
  $('trend-json').querySelector('b').textContent = other ? 'Primary trend statistics' : 'Trend statistics';
  $('map-png').disabled = false;
  const hasTest = estimate?.p != null;
  const significant = hasTest && estimate.p < .05;
  $('trend-details').hidden = !hasTest;
  $('trend-period').textContent = estimate ? (basisYear - WINDOW + 1) + '–' + basisYear : '';
  $('trend-status').textContent = hasTest ? (significant ? 'Significant at 5%' : 'Inconclusive at 5%') : 'Test unavailable';
  $('trend-status').toggleAttribute('data-significant', significant);
  $('trend-projection-note').hidden = !projectedNow || !estimate;
  $('trend-projection-note').textContent = projectedNow && estimate
    ? 'For a projected year, the test uses the latest ' + WINDOW + ' historical years.' : '';
  if (hasTest) {
    const low = mathNumber(estimate.low, 3);
    const high = mathNumber(estimate.high, 3);
    $('interval').replaceChildren(mathExpression(
      mathToken('mo', '['), low, mathToken('mo', ','), high, mathToken('mo', ']')
    ));
    $('trend-unit').textContent = active.unit + '/decade';
    const p = estimate.p;
    const digits = Math.abs(p - .05) <= .001 ? 4 : 3;
    const roundsToCutoff = Number(p.toFixed(digits)) === .05 && p !== .05;
    const probability = p < .001 ? [mathToken('mo', '<'), mathNumber(.001, 3, false)]
      : roundsToCutoff ? [mathToken('mo', significant ? '<' : '>'), mathNumber(.05, digits, false)]
      : [mathNumber(p, digits, false)];
    $('p-value').replaceChildren(mathExpression(...probability));
    const direction = estimate.rate > 0 ? 'upward' : 'downward';
    $('inference').textContent = significant
      ? 'The p-value is below 0.05. This period shows evidence of a ' + direction + ' trend.'
      : 'The p-value is 0.05 or higher. The data are consistent with a flat trend in this period.';
  } else {
    $('inference').textContent = estimate
      ? 'The fit has too little residual variation to estimate uncertainty with this test.'
      : 'This test needs ' + WINDOW + ' consecutive historical values for the selected period.';
  }
  updateComparisonTrend(chartData, basis, estimate?.rate);
  updateChartInterval();
  drawChart();
  updateMonthlyDetail();
}

function historicalAverage(values, cellIndex) {
  let count = 0, sum = 0, firstYear = null, lastYear = null;
  for (let i = 0; i < active.observed; i++) {
    if (!Number.isFinite(values[i])) continue;
    sum += values[i];
    count++;
    firstYear ??= active.years[i];
    lastYear = active.years[i];
  }
  return {
    anomaly: count ? sum / count : null,
    baseline: active.key === 'temperature' && count ? 0 : active.baselineGrid?.[cellIndex] ?? null,
    count, firstYear, lastYear,
  };
}

function updateHistoricalAverages({series, index, others}) {
  $('historical-averages').hidden = false;
  $('average-places').hidden = !others.length;
  for (const row of [$('average-head'), $('average-baseline-a').parentNode, $('average-record-a').parentNode]) {
    row.querySelectorAll('.cmp').forEach(cell => cell.remove());
  }
  const columns = others.map(o => {
    $('average-head').append(tint(make('th', {className: 'cmp cmp-fg', scope: 'col', title: o.name}, o.label), o.n));
    const cells = [make('td', {className: 'cmp'}, '—'), make('td', {className: 'cmp'}, '—')];
    $('average-baseline-a').parentNode.append(cells[0]);
    $('average-record-a').parentNode.append(cells[1]);
    return [cells, historicalAverage(o.values, o.index)];
  });
  $('average-period').textContent = periodTitle() + ' baseline';
  $('average-reference').textContent = active.reference;
  const nasa = active.key === 'temperature';
  $('average-baseline-note').textContent = nasa
    ? 'NASA GISTEMP supplies anomalies. Zero is its reference level.'
    : active.baselineGrid ? '' : 'Historical baseline unavailable for this layer.';
  $('average-baseline-note').hidden = !nasa && Boolean(active.baselineGrid);

  const a = historicalAverage(series, index);
  const unit = active.climatology?.unit ?? active.unit;
  for (const [[baselineCell, record], average] of [[[$('average-baseline-a'), $('average-record-a')], a], ...columns]) {
    setMetric(baselineCell, average.baseline, unit, {showSign: false});
    setMetric(record, average.anomaly, active.unit);
    if (average.count) {
      const coverage = document.createElement('small');
      const years = average.firstYear === average.lastYear ? average.firstYear : average.firstYear + '–' + average.lastYear;
      coverage.textContent = years + ' · ' + average.count + (average.count === 1 ? ' value' : ' values');
      record.append(coverage);
    }
  }
}

function updateLocationValues({central, index, future, other, others}, idx) {
  const trendMode = mode === 'trend';
  const date = labelForYear(year);
  const range = projectedNow ? future?.[idx - active.observed] : null;
  const primary = other && trendMode ? grid[index] : central[idx];
  // The sidebar columns are narrow, so units longer than °C go on their own line.
  const options = {stackUnit: active.unit.length > 3};
  $('value-label').textContent = other ? 'A This place' : date + (projectedNow ? ' projected anomaly' : ' anomaly');
  $('value').classList.toggle('is-projected', projectedNow);
  setMetric($('value'), primary, active.unit, options);
  if (!other && range && !range.filled && range.high - range.low > 1e-9) {
    const error = document.createElement('small');
    error.className = 'pm';
    error.textContent = '± ' + ((range.high - range.low) / 2).toFixed(2) + ' (95% range)';
    $('value').append(error);
  }
  if (!other) return;
  $('compare-period').textContent = (trendMode ? (year - WINDOW + 1) + '–' + year + ' trend per decade'
    : date + (projectedNow ? ' projected anomaly' : ' anomaly')) + ' · ' + active.unit;
  const text = value => Number.isFinite(value) ? signed(value) : '—';
  const row = (label, name, value, difference, n) => {
    const tr = make('tr', {},
      make('th', {scope: 'row'}, make('b', {className: n == null ? '' : 'cmp-fg'}, label), make('span', {title: name}, name)),
      make('td', {}, text(value)), make('td', {}, difference));
    return n == null ? tr : tint(tr, n);
  };
  $('compare-rows').replaceChildren(row('A', placeName, primary, ''),
    ...others.map(o => {
      const value = trendMode ? grid[o.index] : o.values[idx];
      return row(o.label, o.name, value, text(value - primary), o.n);
    }));
}

function updateComparisonTrend({index, others}, basis, rate) {
  const output = $('compare-trend');
  output.hidden = !others.length;
  if (output.hidden) return;
  const rates = [['A', rate], ...others.map(o => [o.label, slopeAt(o.values, basis) * 10])];
  const finite = rates.filter(([, value]) => Number.isFinite(value)).sort((a, b) => b[1] - a[1]);
  const span = (active.years[basis] - WINDOW + 1) + '–' + active.years[basis];
  let text = span + ' trend per decade: ' +
    rates.map(([label, value]) => label + ' ' + (Number.isFinite(value) ? signed(value) : 'no data')).join(', ') + ' ' + active.unit + '.';
  if (finite.length > 1 && signed(finite[0][1]) !== signed(finite[1][1])) {
    const most = finite.length > 2;
    text += ' ' + finite[0][0] + (finite.every(([, value]) => value > 0) && active.unit === '°C'
      ? ' warmed ' + (most ? 'fastest' : 'faster') : ' had the ' + (most ? 'highest' : 'higher') + ' fitted trend') + '.';
  }
  const same = others.filter(o => o.index === index).map(o => o.label);
  if (same.length) text += ' ' + same.join(', ') + (same.length > 1 ? ' are' : ' is') + ' in the same grid cell as A.';
  output.textContent = text;
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
  const formatted = showSign ? signed(value, digits) : value.toFixed(digits).replace(/^-/, '−');
  if (!/^[+−]/.test(formatted)) return mathToken('mn', formatted);
  const row = document.createElementNS(MATH_NS, 'mrow');
  row.append(mathToken('mo', formatted[0]), mathToken('mn', formatted.slice(1)));
  return row;
}

function setMetric(element, value, unit, {showSign = true, stackUnit = false} = {}) {
  if (!Number.isFinite(value)) {
    element.textContent = '—';
    return;
  }
  const number = mathNumber(value, 2, showSign);
  if (stackUnit) {
    const label = document.createElement('small');
    label.className = 'metric-unit';
    label.textContent = unit;
    element.replaceChildren(mathExpression(number), label);
  } else {
    element.replaceChildren(mathExpression(number, mathToken('mtext', ' ' + unit)));
  }
}

function chartColors(dark) {
  return {
    text: dark ? '#b1c1b4' : '#526258', grid: dark ? '#384a40' : '#dde1d5', zero: '#a0aa9f',
    window: dark ? '#2d4135' : '#e1eadc', line: dark ? '#a6d6b8' : '#2d7655', dot: dark ? '#a6d6b8' : '#24523e',
    fit: dark ? '#f0a880' : '#a7462c', proj: dark ? PROJ.dark : PROJ.light,
    other: dark ? '#8ed9f3' : '#14688b',
    band: dark ? '#b7a6ff2e' : '#6a4fd024', zone: dark ? '#b7a6ff12' : '#6a4fd00d',
    interval: dark ? '#eab37c' : '#934926', intervalFill: dark ? '#eab37c38' : '#ce8c5033',
    cursor: dark ? '#e8eee4' : '#244e3d', marker: '#51675c',
  };
}

// Ordinary least squares over indexes [start, end], skipping gaps.
function lineFit(values, start, end) {
  let n = 0, sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
  const lo = Math.max(0, start), hi = Math.min(values.length - 1, end);
  for (let i = lo; i <= hi; i++) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    n++;
    sumX += i; sumY += value; sumXX += i * i; sumXY += i * value;
  }
  if (n < 2) return null;
  const denom = n * sumXX - sumX * sumX;
  if (!(Math.abs(denom) > 1e-9)) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return {start: lo, end: hi, at: i => intercept + slope * i};
}

// Selected chart interval when both ends are set; otherwise the measured record.
function chartFit(values) {
  if (intervalAnchor !== null && intervalEnd !== null) {
    return lineFit(values, Math.min(intervalAnchor, intervalEnd), Math.max(intervalAnchor, intervalEnd));
  }
  let first = -1, last = -1;
  for (let i = 0; i < active.observed; i++) {
    if (!Number.isFinite(values[i])) continue;
    if (first < 0) first = i;
    last = i;
  }
  return first < 0 ? null : lineFit(values, first, last);
}

function paintSeries(g, values, start, end, x, y, color, weight) {
  g.beginPath();
  let connected = false;
  for (let i = start; i < end; i++) {
    const value = values[i];
    if (!Number.isFinite(value)) { connected = false; continue; }
    if (connected) g.lineTo(x(i), y(value)); else g.moveTo(x(i), y(value));
    connected = true;
  }
  g.strokeStyle = color; g.lineWidth = weight; g.lineJoin = 'round'; g.stroke();
}

// Paints the location chart into the rectangle (ox, oy, w, h). `k` scales
// strokes and type so the same routine serves the panel and the PNG export.
function paintChart(g, ox, oy, w, h, {dark, k = 1, interactive = true} = {}) {
  const {series, central, idx, index, estimate, basis, future, other, others} = chartData;
  const c = chartColors(dark);
  const otherFuture = others.some(o => o.future);
  const observedCount = active.observed;
  const finite = series.concat(...others.map(o => o.values)).filter(Number.isFinite);
  const left = ox + 37 * k, right = ox + w - 7 * k, top = oy + 8 * k, bottom = oy + h - 20 * k;
  if (!finite.length) {
    g.font = 12 * k + 'px sans-serif'; g.fillStyle = c.text;
    g.fillText(other ? 'No observations for any of these grid cells' : 'No observations for this grid cell', ox + 5 * k, oy + h / 2);
    return {left, right, bottom, top, x: () => left};
  }
  const [v0, v1] = viewRange();
  const lo = Math.floor(v0), hi = Math.ceil(v1);
  const inView = (value, i) => i >= lo && i <= hi && Number.isFinite(value);
  const visible = series.filter(inView).concat(...others.map(o => o.values.filter(inView)));
  const extremes = future ? future.flatMap((f, i) => inView(f.value, observedCount + i) ? [f.low, f.high] : []) : [];
  const shown = visible.length ? visible : finite;
  const min = Math.min(0, ...shown, ...extremes), max = Math.max(0, ...shown, ...extremes);
  const x = i => left + (i - v0) / (v1 - v0) * (right - left);
  const y = value => bottom - (max === min ? .5 : (value - min) / (max - min)) * (bottom - top);
  const lastX = x(observedCount - 1);
  g.save();
  g.beginPath(); g.rect(left, oy, right - left, bottom - oy + 1); g.clip();
  if (future || otherFuture) { g.fillStyle = c.zone; g.fillRect(lastX, top, right - lastX, bottom - top); }
  if (interactive && intervalAnchor !== null) {
    const endpoint = intervalEnd ?? chartCursor ?? intervalAnchor;
    g.fillStyle = c.intervalFill;
    g.fillRect(Math.min(x(intervalAnchor), x(endpoint)), top, Math.abs(x(intervalAnchor) - x(endpoint)), bottom - top);
  } else if (estimate) {
    g.fillStyle = c.window;
    g.fillRect(x(basis - WINDOW + 1), top, x(basis) - x(basis - WINDOW + 1), bottom - top);
  }
  const yTicks = [...new Set([min, 0, max])];
  for (const tick of yTicks) {
    const ty = y(tick);
    g.beginPath(); g.moveTo(left, ty); g.lineTo(right, ty);
    g.strokeStyle = tick === 0 ? c.zero : c.grid; g.lineWidth = k; g.stroke();
  }
  if (future) {
    g.beginPath();
    future.forEach((f, i) => g.lineTo(x(observedCount + i), y(f.high)));
    for (let i = future.length - 1; i >= 0; i--) g.lineTo(x(observedCount + i), y(future[i].low));
    g.closePath(); g.fillStyle = c.band; g.fill();
  }
  for (const o of others) {
    const color = compareColor(o.n, dark);
    paintSeries(g, o.values, 0, observedCount, x, y, color, (o.index === index ? 3.3 : 1.6) * k);
    if (o.future) {
      g.setLineDash([5 * k, 3 * k]);
      paintSeries(g, o.values, observedCount, series.length, x, y, color, 1.5 * k);
      g.setLineDash([]);
    }
  }
  paintSeries(g, series, 0, observedCount, x, y, c.line, 1.35 * k);
  const fit = chartFit(central);
  if (fit) {
    g.beginPath();
    g.moveTo(x(fit.start), y(fit.at(fit.start)));
    g.lineTo(x(fit.end), y(fit.at(fit.end)));
    g.strokeStyle = c.fit; g.lineWidth = 1.5 * k; g.stroke();
  }
  if (future) {
    // One simulated path with year-to-year swings, then the central estimate.
    g.beginPath();
    let started = false;
    if (Number.isFinite(series[observedCount - 1])) {
      g.moveTo(lastX, y(series[observedCount - 1]));
      started = true;
    }
    for (let i = observedCount; i < series.length; i++) {
      const value = series[i];
      if (!Number.isFinite(value)) { started = false; continue; }
      if (started) g.lineTo(x(i), y(value)); else g.moveTo(x(i), y(value));
      started = true;
    }
    g.globalAlpha = .55; g.strokeStyle = c.proj; g.lineWidth = k; g.stroke(); g.globalAlpha = 1;
    g.beginPath();
    future.forEach((f, i) => g.lineTo(x(observedCount + i), y(f.value)));
    g.strokeStyle = c.proj; g.lineWidth = 1.6 * k; g.setLineDash([5 * k, 3 * k]); g.stroke(); g.setLineDash([]);
  }
  const marker = idx >= observedCount ? c.proj : c.marker;
  g.beginPath(); g.moveTo(x(idx), top); g.lineTo(x(idx), bottom);
  g.strokeStyle = marker; g.lineWidth = k; g.setLineDash([3 * k, 3 * k]); g.stroke(); g.setLineDash([]);
  if (Number.isFinite(central[idx])) {
    g.beginPath(); g.arc(x(idx), y(central[idx]), 3.5 * k, 0, Math.PI * 2);
    g.fillStyle = idx >= observedCount ? c.proj : c.dot; g.fill();
  }
  for (const o of others) {
    if (!Number.isFinite(o.values[idx])) continue;
    g.strokeStyle = compareColor(o.n, dark); g.lineWidth = 1.5 * k;
    g.strokeRect(x(idx) - 3.5 * k, y(o.values[idx]) - 3.5 * k, 7 * k, 7 * k);
  }
  g.restore();
  g.font = 9 * k + 'px "IBM Plex Mono", monospace'; g.fillStyle = c.text; g.textAlign = 'left';
  for (const tick of yTicks) g.fillText(signed(tick, 1), ox, clamp(y(tick) + 3 * k, oy + 9 * k, bottom + 2 * k));
  const axisY = oy + h - 3 * k;
  if (chartView) {
    // Zoomed: round-number years spaced so the labels never touch.
    const maxTicks = Math.max(2, Math.floor((right - left) / (46 * k)));
    const step = [1, 2, 5, 10, 20, 25, 50].find(s => (v1 - v0) / s <= maxTicks) ?? 50;
    g.textAlign = 'center';
    for (let i = Math.ceil(v0); i <= Math.floor(v1); i++) {
      const year = active.years[i], px = x(i);
      if (year % step || px < left + 12 * k || px > right - 12 * k) continue;
      g.beginPath(); g.moveTo(px, bottom); g.lineTo(px, bottom + 3 * k);
      g.strokeStyle = c.grid; g.lineWidth = k; g.stroke();
      g.fillText(year, px, axisY);
    }
  } else {
    g.fillText(active.years[0], left, axisY);
    g.textAlign = 'right'; g.fillText(active.years.at(-1), right, axisY);
    if (future || otherFuture) {
      g.textAlign = lastX > right - 60 * k ? 'right' : 'center';
      g.fillText(active.years[observedCount - 1], Math.min(lastX, right - 30 * k), axisY);
    }
  }
  g.textAlign = 'left';
  return {left, right, bottom, top, x, y, c};
}

function chartPointLabel(index) {
  const {central, future, others} = chartData;
  const label = labelForYear(active.years[index]) + (index >= active.observed ? ' (projected)' : '');
  const f = index >= active.observed ? future?.[index - active.observed] : null;
  const valueText = value => Number.isFinite(value) ? signed(value) + ' ' + active.unit : 'No data';
  const a = valueText(central[index]) +
    (f && f.high > f.low ? ' ± ' + ((f.high - f.low) / 2).toFixed(2) : '');
  return others.length ? label + '\nA ' + a + others.map(o => '\n' + o.label + ' ' + valueText(o.values[index])).join('')
    : label + ' · ' + a;
}

function drawChart() {
  if (showMonthly) drawMonthlyDetail();
  else drawChartSurface(chart, $('chart-tooltip'));
  drawChartSurface($('chart-preview'), $('preview-tooltip'));
}

function drawChartSurface(canvas, tooltip) {
  if (!active || !chartData) return;
  const {series, central, idx, others} = chartData;
  const g = canvas.getContext('2d');
  const [w, h] = sizeCanvas(canvas);
  if (!w || !h) return;
  g.clearRect(0, 0, w, h);
  const dark = document.documentElement.dataset.theme === 'dark';
  const inspected = chartCursor ?? idx;
  const label = chartPointLabel(inspected);
  $('chart-readout').textContent = label;
  tooltip.textContent = label;
  const hasData = series.some(Number.isFinite) || others.some(o => o.values.some(Number.isFinite));
  tooltip.hidden = chartCursor == null || !hasData;
  const {left, right, bottom, top, x, y, c} = paintChart(g, 0, 0, w, h, {dark, k: w >= 480 ? 1.25 : 1});
  chartLayouts.set(canvas, {left, right});
  if (!hasData) return;
  g.save();
  g.beginPath(); g.rect(left, 0, right - left, h); g.clip();
  for (const endpoint of new Set([intervalAnchor, intervalEnd])) {
    if (endpoint === null) continue;
    const px = x(endpoint);
    g.beginPath(); g.moveTo(px, top); g.lineTo(px, bottom);
    g.lineWidth = 1.5; g.strokeStyle = c.interval; g.stroke();
    if (Number.isFinite(central[endpoint])) {
      g.beginPath(); g.arc(px, y(central[endpoint]), 4.5, 0, Math.PI * 2);
      g.fillStyle = c.interval; g.fill();
    }
  }
  if (chartCursor != null) {
    const cursorX = x(inspected);
    g.beginPath(); g.moveTo(cursorX, top); g.lineTo(cursorX, bottom);
    g.strokeStyle = c.text; g.lineWidth = 1; g.stroke();
    if (Number.isFinite(central[inspected])) {
      g.beginPath(); g.arc(cursorX, y(central[inspected]), 4.5, 0, Math.PI * 2);
      g.fillStyle = inspected >= active.observed ? c.proj : c.cursor; g.fill();
    }
    for (const o of others) {
      if (!Number.isFinite(o.values[inspected])) continue;
      g.strokeStyle = compareColor(o.n, dark); g.lineWidth = 1.5;
      g.strokeRect(cursorX - 4, y(o.values[inspected]) - 4, 8, 8);
    }
    g.restore();
    tooltip.style.left = clamp(cursorX > w / 2 ? cursorX - tooltip.offsetWidth - 8 : cursorX + 8,
      0, Math.max(0, w - tooltip.offsetWidth)) + 'px';
    // Keep the value to the side of the cursor and above the x-axis labels.
    tooltip.style.top = Math.max(0, bottom - tooltip.offsetHeight - 4) + 'px';
  } else {
    g.restore();
  }
}

function chartIndexAt(canvas, event) {
  const chartLayout = chartLayouts.get(canvas);
  if (!active || !chartLayout || !chartData) return null;
  const {left, right} = chartLayout;
  if (right <= left) return null;
  return Math.round(chartIndexFloat(canvas, event.clientX));
}

// Fractional index under a screen x, inside the current view.
function chartIndexFloat(canvas, clientX) {
  const {left, right} = chartLayouts.get(canvas);
  const [v0, v1] = viewRange();
  const x = clientX - canvas.getBoundingClientRect().left;
  return v0 + clamp((x - left) / (right - left), 0, 1) * (v1 - v0);
}

function viewRange() {
  const last = (active?.years.length ?? 2) - 1;
  if (!chartView) return [0, last];
  return [clamp(chartView.start, 0, last), clamp(chartView.end, 0, last)];
}

function setChartView(start, end) {
  if (!active) return;
  const last = active.years.length - 1;
  const span = clamp(end - start, Math.min(MIN_CHART_SPAN, last), last);
  if (span >= last - 1e-6) {
    chartView = null;
  } else {
    const from = clamp(start, 0, last - span);
    chartView = {start: from, end: from + span};
  }
  updateZoomControls();
  drawChart();
}

// Zoom by `factor` (<1 zooms in) keeping `anchor` (an index) under the same pixel.
function zoomChart(factor, anchor) {
  const [v0, v1] = viewRange();
  const at = anchor ?? (chartCursor ?? (v0 + v1) / 2);
  const t = v1 > v0 ? (at - v0) / (v1 - v0) : .5;
  const span = (v1 - v0) * factor;
  setChartView(at - t * span, at - t * span + span);
}

function panChart(deltaIndex) {
  if (!chartView) return;
  setChartView(chartView.start + deltaIndex, chartView.end + deltaIndex);
}

function updateZoomControls() {
  const last = (active?.years.length ?? 2) - 1;
  const [v0, v1] = viewRange();
  for (const prefix of showMonthly ? ['preview-'] : ['', 'preview-']) {
    $(prefix + 'zoom-in').disabled = !active || v1 - v0 <= Math.min(MIN_CHART_SPAN, last) + 1e-6;
    $(prefix + 'zoom-out').disabled = $(prefix + 'zoom-reset').disabled = !chartView;
    $(prefix + 'zoom-range').textContent = chartView && active
      ? active.years[Math.ceil(v0)] + '–' + active.years[Math.floor(v1)] : '';
  }
}

function inspectChart(index, announce = false) {
  if (index === chartCursor) return;
  chartCursor = index;
  drawChart();
  if (announce) $('chart-announcement').textContent = $('chart-readout').textContent;
}

function updateChartInterval() {
  $('chart-interval').hidden = intervalAnchor === null;
  $('preview-interval').hidden = intervalAnchor === null;
  $('interval-values').hidden = intervalEnd === null;
  if (intervalAnchor === null || !chartData || !active) return;
  if (intervalEnd === null) {
    $('interval-summary').textContent = labelForYear(active.years[intervalAnchor]) + ' selected. Pick another point.';
    $('preview-interval-summary').textContent = $('interval-summary').textContent;
    return;
  }
  const start = Math.min(intervalAnchor, intervalEnd);
  const end = Math.max(intervalAnchor, intervalEnd);
  const startYear = active.years[start];
  const endYear = active.years[end];
  const startValue = chartData.central[start];
  const endValue = chartData.central[end];
  $('interval-summary').textContent = startYear + '–' + endYear + ' · ' +
    (endYear - startYear) + (endYear - startYear === 1 ? ' year' : ' years') +
    (end >= active.observed ? ' · includes projected values' : '');
  $('preview-interval-summary').textContent = $('interval-summary').textContent;
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
$('preview-interval-clear').addEventListener('click', () => {
  clearChartInterval();
  $('chart-preview').focus();
  drawChart();
});
function bindChart(canvas, prefix = '') {
  const monthly = () => canvas === chart && showMonthly;
  // Drag sideways to pan a zoomed chart; pinch with two fingers to zoom.
  const chartPointers = new Map();
  let chartGesture = null, chartDragged = false;
  canvas.addEventListener('pointerdown', event => {
    if (monthly()) return;
    const chartLayout = chartLayouts.get(canvas);
    if (!chartLayout || !active) return;
    chartPointers.set(event.pointerId, event.clientX);
    chartDragged = false;
    if (chartPointers.size === 2) {
      const [a, b] = [...chartPointers.values()];
      chartGesture = {pinch: true, distance: Math.abs(a - b) || 1, view: viewRange(),
        anchor: chartIndexFloat(canvas, (a + b) / 2)};
    } else {
      chartGesture = {pinch: false, x: event.clientX, view: viewRange()};
    }
  });
  canvas.addEventListener('pointermove', event => {
    if (monthly()) return;
    const chartLayout = chartLayouts.get(canvas);
    if (chartPointers.has(event.pointerId) && chartGesture && chartLayout) {
      chartPointers.set(event.pointerId, event.clientX);
      const [v0, v1] = chartGesture.view;
      const perPixel = (v1 - v0) / (chartLayout.right - chartLayout.left);
      if (chartGesture.pinch && chartPointers.size === 2) {
        const [a, b] = [...chartPointers.values()];
        const factor = chartGesture.distance / (Math.abs(a - b) || 1);
        const {anchor} = chartGesture, t = (anchor - v0) / (v1 - v0), span = (v1 - v0) * factor;
        chartDragged = true;
        setChartView(anchor - t * span, anchor - t * span + span);
        return;
      }
      const dx = event.clientX - chartGesture.x;
      if (!chartGesture.pinch && chartView && (chartDragged || Math.abs(dx) > 4)) {
        if (!chartDragged) canvas.setPointerCapture(event.pointerId);
        chartDragged = true;
        canvas.classList.add('panning');
        setChartView(v0 - dx * perPixel, v1 - dx * perPixel);
        return;
      }
    }
    inspectChart(chartIndexAt(canvas, event));
  });
  const endChartPointer = event => {
    chartPointers.delete(event.pointerId);
    if (!chartPointers.size) { chartGesture = null; canvas.classList.remove('panning'); }
  };
  canvas.addEventListener('pointerup', endChartPointer);
  canvas.addEventListener('pointercancel', endChartPointer);
  canvas.addEventListener('wheel', event => {
    if (monthly()) return;
    const chartLayout = chartLayouts.get(canvas);
    if (!chartLayout || !active) return;
    const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey;
    if (event.ctrlKey || event.metaKey) {
      // Trackpad pinch arrives as ctrl+wheel.
      event.preventDefault();
      zoomChart(Math.exp(clamp(event.deltaY, -60, 60) * .01), chartIndexFloat(canvas, event.clientX));
    } else if (sideways && chartView) {
      event.preventDefault();
      const [v0, v1] = viewRange();
      const delta = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
      panChart(delta * (v1 - v0) / (chartLayout.right - chartLayout.left));
    }
  }, {passive: false});
  canvas.addEventListener('dblclick', event => {
    if (monthly()) return;
    event.preventDefault();
    if (chartView) setChartView(0, Infinity);
  });
  $(prefix + 'zoom-in').addEventListener('click', () => monthly() ? zoomMonthly(-1) : zoomChart(.6));
  $(prefix + 'zoom-out').addEventListener('click', () => monthly() ? zoomMonthly(1) : zoomChart(1 / .6));
  $(prefix + 'zoom-reset').addEventListener('click', () => monthly() ? resetMonthly() : setChartView(0, Infinity));
  canvas.addEventListener('pointerleave', () => { if (!monthly()) inspectChart(null); });
  canvas.addEventListener('blur', () => { if (!monthly()) inspectChart(null); });
  canvas.addEventListener('click', event => {
    if (monthly()) return;
    if (chartDragged) { chartDragged = false; return; }
    const index = chartIndexAt(canvas, event);
    inspectChart(index);
    selectChartPoint(index);
  });
  canvas.addEventListener('keydown', event => {
    if (monthly()) return;
    if (!active) return;
    const index = chartCursor ?? yearIndex();
    const next = {ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: active.years.length - 1};
    if (Object.hasOwn(next, event.key)) {
      event.preventDefault();
      const target = clamp(next[event.key], 0, active.years.length - 1);
      const [v0, v1] = viewRange();
      if (chartView && (target < v0 || target > v1)) {
        const span = v1 - v0;
        setChartView(target < v0 ? target : target - span, target < v0 ? target + span : target);
      }
      inspectChart(target, true);
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomChart(.6);
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      zoomChart(1 / .6);
    } else if (event.key === '0') {
      event.preventDefault();
      setChartView(0, Infinity);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      selectChartPoint(index);
    } else if (event.key === 'Escape') {
      clearChartInterval();
      chartCursor = null;
      drawChart();
    }
  });
}

bindChart(chart);
bindChart($('chart-preview'), 'preview-');


let monthlyDetailVersion = 0;
let monthlyData, monthlyRequest, monthlyKey, monthlyDate, monthlyWindow, monthlyCursor, monthlyDrag;
let showMonthly = false, monthlyError = false, monthlyZoom = 1;
const monthlySpans = [12, 24, 60];

async function monthlyHistory(key, primaryIndex, otherIndexes) {
  const info = catalog[key];
  const size = info.width * info.height;
  const records = [];
  for (const [period] of months) {
    const entry = info.periods[period];
    const grid = await decodeGrid(entry, size * entry.years.length);
    for (const [i, year] of entry.years.entries()) {
      records.push({
        date: year * 12 + Number(period) - 1,
        primary: grid[i * size + primaryIndex],
        others: otherIndexes.map(otherIndex => grid[i * size + otherIndex]),
      });
    }
  }
  records.sort((a, b) => a.date - b.date);
  return records;
}

async function updateMonthlyDetail() {
  if (!showMonthly || !chartData || !active) return;
  const version = ++monthlyDetailVersion;
  const {index, others} = chartData;
  const key = [active.key, index, ...others.map(o => o.index)].join(':');
  if (key !== monthlyKey) {
    monthlyKey = key;
    clearMonthlySelection();
    monthlyData = null;
    monthlyError = false;
    drawMonthlyDetail();
    monthlyRequest = monthlyHistory(active.key, index, others.map(o => o.index));
  }
  const detailDate = year * 12 + (mode === 'monthly' ? Number(periodKey()) - 1 : 11);
  try {
    const records = await monthlyRequest;
    if (version !== monthlyDetailVersion) return;
    if (monthlyData?.timelineDate !== detailDate) {
      monthlyDate = detailDate;
      monthlyCursor = null;
    }
    monthlyData = {records, timelineDate: detailDate};
    drawMonthlyDetail();
  } catch {
    if (version !== monthlyDetailVersion) return;
    monthlyKey = null;
    monthlyError = true;
    drawMonthlyDetail();
  }
}

function monthlyLabel(index) {
  return dateLabel(Math.floor(index / 12), String(index % 12 + 1).padStart(2, '0'));
}

function monthlyRecords() {
  if (!monthlyData || !active) return [];
  const {records} = monthlyData;
  const span = monthlySpans[monthlyZoom];
  const first = records[0].date, last = records.at(-1).date;
  monthlyDate = clamp(monthlyDate, Math.min(first + span - 1, last), last);
  return records.filter(record => record.date > monthlyDate - span && record.date <= monthlyDate);
}

// Two clicked months (as dates) that bound the fitted span, like the yearly chart's two-point trend.
let monthlyAnchor = null, monthlyEnd = null;

// Least-squares line through A's values in `records`; null with fewer than 3 values.
function monthlyFit(records) {
  if (!records.length) return null;
  const t0 = records[0].date;
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const record of records) {
    if (!Number.isFinite(record.primary)) continue;
    const t = record.date - t0;
    n++; sx += t; sy += record.primary; sxx += t * t; sxy += t * record.primary;
  }
  const spread = n * sxx - sx * sx;
  if (n < 3 || !spread) return null;
  const slope = (n * sxy - sx * sy) / spread;
  const intercept = (sy - slope * sx) / n;
  return {perYear: slope * 12, count: n, start: t0, end: records.at(-1).date, at: date => intercept + slope * (date - t0)};
}

// The span the line covers: the two picked months, or else the months on screen.
function monthlySelection() {
  if (monthlyAnchor === null || monthlyEnd === null) return null;
  return [Math.min(monthlyAnchor, monthlyEnd), Math.max(monthlyAnchor, monthlyEnd)];
}

function pickMonth(date) {
  if (monthlyAnchor === null || monthlyEnd !== null) { monthlyAnchor = date; monthlyEnd = null; }
  else if (date !== monthlyAnchor) monthlyEnd = date;
  drawMonthlyDetail();
  $('chart-announcement').textContent = $('month-interval-summary').textContent;
}

function clearMonthlySelection() {
  monthlyAnchor = monthlyEnd = null;
}

function paintMonthlyPlot(g, w, h, records, dark, k = 1) {
  const a = records.map(record => record.primary);
  const rest = (records[0]?.others ?? []).map((_, n) => records.map(record => record.others[n]));
  const finite = a.concat(...rest).filter(Number.isFinite);
  const min = Math.min(0, ...finite), max = Math.max(0, ...finite);
  const c = chartColors(dark);
  const left = 38 * k, right = w - 8 * k, top = 10 * k, bottom = h - 22 * k;
  const x = i => left + i / Math.max(1, records.length - 1) * (right - left);
  const y = v => max === min ? (top + bottom) / 2 : bottom - (v - min) / (max - min) * (bottom - top);
  g.font = 10 * k + 'px "IBM Plex Mono", monospace';
  g.fillStyle = c.text;
  g.textAlign = 'left';
  for (const tick of new Set([min, 0, max])) {
    const ty = y(tick);
    g.beginPath(); g.moveTo(left, ty); g.lineTo(right, ty);
    g.strokeStyle = tick === 0 ? c.zero : c.grid; g.lineWidth = k; g.stroke();
    g.fillText(signed(tick, 1), 0, ty + 3 * k);
  }
  rest.forEach((b, n) => paintSeries(g, b, 0, b.length, x, y, compareColor(n, dark), 1.5 * k));
  paintSeries(g, a, 0, a.length, x, y, c.line, 1.5 * k);
  const selection = monthlySelection();
  const fit = monthlyFit(selection && monthlyData
    ? monthlyData.records.filter(record => record.date >= selection[0] && record.date <= selection[1]) : records);
  const xd = date => x(date - records[0].date);
  g.save();
  g.beginPath(); g.rect(left, top - 4 * k, right - left, bottom - top + 8 * k); g.clip();
  if (monthlyAnchor !== null) {
    const endpoint = monthlyEnd ?? monthlyCursor ?? monthlyAnchor;
    g.fillStyle = c.intervalFill;
    g.fillRect(Math.min(xd(monthlyAnchor), xd(endpoint)), top, Math.abs(xd(monthlyAnchor) - xd(endpoint)), bottom - top);
    for (const date of new Set([monthlyAnchor, monthlyEnd])) {
      if (date === null) continue;
      g.beginPath(); g.moveTo(xd(date), top); g.lineTo(xd(date), bottom);
      g.strokeStyle = c.marker; g.lineWidth = k; g.stroke();
    }
  }
  if (fit) {
    g.beginPath(); g.moveTo(xd(fit.start), y(fit.at(fit.start))); g.lineTo(xd(fit.end), y(fit.at(fit.end)));
    g.strokeStyle = c.fit; g.lineWidth = 2 * k; g.stroke();
  }
  g.restore();
  const ticks = Math.max(2, Math.floor((right - left) / (70 * k)));
  for (let j = 0; j < ticks; j++) {
    const i = Math.round(j * (records.length - 1) / (ticks - 1));
    g.textAlign = j === 0 ? 'left' : j === ticks - 1 ? 'right' : 'center';
    g.fillText(monthlyLabel(records[i].date), x(i), h - 4 * k);
  }
  return {left, right, top, bottom, x, y, c, fit, hasData: finite.length > 0};
}

function drawMonthlyDetail() {
  if (!showMonthly) return;
  const [w, h] = sizeCanvas(chart);
  if (!w || !h) return;
  const g = chart.getContext('2d');
  g.clearRect(0, 0, w, h);
  const records = monthlyRecords();
  const ready = records.length > 0;
  $('chart-title').textContent = 'Monthly anomalies';
  $('chart').setAttribute('aria-label', 'Historical monthly anomalies for ' + placeName +
    comparisons.map(place => ' and ' + place.name).join(''));
  $('zoom-in').disabled = !ready || monthlyZoom === 0;
  $('zoom-out').disabled = !ready || monthlyZoom === monthlySpans.length - 1;
  $('zoom-reset').disabled = !ready && !monthlyError;
  $('zoom-reset').textContent = monthlyError ? 'Retry' : 'Reset';
  $('zoom-range').textContent = ready ? records.length + ' months' : '';
  const tooltip = $('chart-tooltip');
  tooltip.hidden = true;
  monthlyWindow = null;
  $('chart-month-fit').hidden = true;
  $('month-interval').hidden = true;
  $('chart-png').disabled = true;
  if (!ready) {
    $('chart-help').textContent = monthlyError ? 'Monthly data could not load. Choose Retry.' : 'Loading monthly observations…';
    return;
  }
  const dark = document.documentElement.dataset.theme === 'dark';
  const layout = paintMonthlyPlot(g, w, h, records, dark);
  $('chart-png').disabled = !layout.hasData;
  monthlyWindow = {records, ...layout};
  $('chart-month-fit').hidden = !layout.fit;
  const selection = monthlySelection();
  if (layout.fit) $('chart-month-fit-text').textContent = 'Line of best fit' + (records[0].others.length ? ' for A' : '') +
    ' · ' + signed(layout.fit.perYear) + ' ' + active.unit + ' per year ' +
    (selection ? monthlyLabel(selection[0]) + '–' + monthlyLabel(selection[1]) : 'over these ' + records.length + ' months');
  $('month-interval').hidden = monthlyAnchor === null;
  if (monthlyAnchor !== null) {
    const value = date => monthlyData.records.find(record => record.date === date)?.primary;
    const metric = n => Number.isFinite(n) ? signed(n) + ' ' + active.unit : 'no data';
    $('month-interval-summary').textContent = !selection ? monthlyLabel(monthlyAnchor) + ' selected. Pick another month.'
      : monthlyLabel(selection[0]) + '–' + monthlyLabel(selection[1]) + ' · ' +
        (layout.fit ? 'trend ' + signed(layout.fit.perYear) + ' ' + active.unit + ' per year' : 'not enough data for a trend') +
        ' · start ' + metric(value(selection[0])) + ', end ' + metric(value(selection[1])) +
        (Number.isFinite(value(selection[1]) - value(selection[0])) ? ', change ' + metric(value(selection[1]) - value(selection[0])) : '');
  }
  $('chart-help').textContent = layout.hasData
    ? 'The line of best fit covers the months shown. Click two months to fit just that span. Use + and − to zoom from 12 to 60 months, drag to browse, or use the arrow keys and Enter.'
    : 'No observations in this window. Drag or zoom out to browse other months.';
  const i = records.findIndex(record => record.date === monthlyCursor);
  if (i < 0) return;
  const record = records[i], px = layout.x(i);
  g.beginPath(); g.moveTo(px, layout.top); g.lineTo(px, layout.bottom);
  g.strokeStyle = layout.c.marker; g.lineWidth = 1; g.stroke();
  const metric = n => Number.isFinite(n) ? signed(n) + ' ' + active.unit : 'No data';
  const label = monthlyLabel(record.date) + '\n' + (record.others.length ? 'A ' : '') + metric(record.primary) +
    record.others.map((value, n) => '\n' + compareLabel(n) + ' ' + metric(value)).join('');
  $('chart-readout').textContent = label;
  tooltip.textContent = label;
  tooltip.hidden = false;
  tooltip.style.left = clamp(px < w / 2 ? px + 8 : px - tooltip.offsetWidth - 8, 0, w - tooltip.offsetWidth) + 'px';
  tooltip.style.top = Math.max(0, layout.bottom - tooltip.offsetHeight - 4) + 'px';
}

function setMonthlyMode(next) {
  showMonthly = next;
  monthlyDetailVersion++;
  monthlyCursor = monthlyDrag = null;
  $('full-chart').classList.toggle('showing-months', next);
  $('chart-years').setAttribute('aria-pressed', !next);
  $('chart-months').setAttribute('aria-pressed', next);
  if (next) updateMonthlyDetail();
  else {
    $('zoom-reset').textContent = 'All years';
    if (active) update();
    else updateZoomControls();
  }
}

function zoomMonthly(direction) {
  monthlyZoom = clamp(monthlyZoom + direction, 0, monthlySpans.length - 1);
  drawMonthlyDetail();
}

function resetMonthly() {
  if (monthlyError) { updateMonthlyDetail(); return; }
  if (!monthlyData) return;
  monthlyDate = monthlyData.timelineDate;
  monthlyZoom = 1;
  monthlyCursor = null;
  drawMonthlyDetail();
}

$('chart-years').addEventListener('click', () => setMonthlyMode(false));
$('chart-months').addEventListener('click', () => setMonthlyMode(true));
chart.addEventListener('pointerdown', event => {
  if (!showMonthly || !monthlyWindow || event.button !== 0) return;
  chart.setPointerCapture(event.pointerId);
  monthlyDrag = {x: event.clientX, end: monthlyDate};
});
chart.addEventListener('pointerup', event => {
  if (!showMonthly || !monthlyWindow || !monthlyDrag || Math.abs(event.clientX - monthlyDrag.x) > 4) return;
  const {left, right, records} = monthlyWindow;
  const x = event.clientX - chart.getBoundingClientRect().left;
  monthlyDrag = null;
  monthlyCursor = records[Math.round(clamp((x - left) / (right - left), 0, 1) * (records.length - 1))].date;
  pickMonth(monthlyCursor);
});
$('month-interval-clear').addEventListener('click', () => {
  clearMonthlySelection();
  drawMonthlyDetail();
  chart.focus();
});
chart.addEventListener('pointermove', event => {
  if (!showMonthly || !monthlyWindow) return;
  const {left, right, records} = monthlyWindow;
  if (monthlyDrag && Math.abs(event.clientX - monthlyDrag.x) <= 4) return;
  if (monthlyDrag) {
    monthlyDate = monthlyDrag.end - Math.round((event.clientX - monthlyDrag.x) / (right - left) * (records.length - 1));
    monthlyCursor = null;
  } else {
    const x = event.clientX - chart.getBoundingClientRect().left;
    const i = Math.round(clamp((x - left) / (right - left), 0, 1) * (records.length - 1));
    if (monthlyCursor === records[i].date) return;
    monthlyCursor = records[i].date;
  }
  drawMonthlyDetail();
});
chart.addEventListener('lostpointercapture', () => { monthlyDrag = null; });
for (const event of ['pointerleave', 'blur']) {
  chart.addEventListener(event, () => {
    if (!showMonthly) return;
    monthlyCursor = null;
    drawMonthlyDetail();
  });
}
chart.addEventListener('wheel', event => {
  if (!showMonthly || !monthlyWindow || !(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  zoomMonthly(Math.sign(event.deltaY));
}, {passive: false});
chart.addEventListener('keydown', event => {
  if (!showMonthly || !monthlyWindow) return;
  if (event.key === '+' || event.key === '=') zoomMonthly(-1);
  else if (event.key === '-') zoomMonthly(1);
  else if (event.key === '0') resetMonthly();
  else if (event.key === 'Enter' && monthlyCursor !== null) pickMonth(monthlyCursor);
  else if (event.key === 'Escape' && monthlyAnchor !== null) { clearMonthlySelection(); drawMonthlyDetail(); }
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    const {records} = monthlyWindow;
    const offset = event.key === 'ArrowLeft' ? -1 : 1;
    const first = monthlyData.records[0].date, last = monthlyData.records.at(-1).date;
    monthlyCursor = clamp((monthlyCursor ?? records.at(-1).date) + offset, first, last);
    if (monthlyCursor < records[0].date) monthlyDate += offset;
    if (monthlyCursor > records.at(-1).date) monthlyDate += offset;
    drawMonthlyDetail();
    $('chart-announcement').textContent = $('chart-readout').textContent;
  } else return;
  event.preventDefault();
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
    updateViewTools();
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
    if (!cameraFrame) updateViewTools();
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

function updateViewTools() {
  const globeView = view === 'globe';
  const level = globeView ? (zoomTarget ?? zoom) : flatZoom;
  const max = globeView ? MAX_GLOBE_ZOOM : MAX_FLAT_ZOOM;
  $('map-zoom-out').disabled = level <= 1 + 1e-6;
  $('map-zoom-in').disabled = level >= max - 1e-6;
  $('map-zoom-reset').disabled = globeView
    ? Math.abs(zoom - 1) < 1e-6 && Math.abs(wrap(rotation[0] - DEFAULT_ROTATION[0])) < 0.5 && Math.abs(rotation[1] - DEFAULT_ROTATION[1]) < 0.5
    : flatZoom === 1 && flatOffset[0] === 0 && flatOffset[1] === 0;
  $('flat-tools').setAttribute('aria-label', globeView ? 'Globe view' : 'Flat map zoom');
}

function updateFlatMap() {
  constrainFlatOffset();
  earth.classList.toggle('grab', flatZoom > 1);
  updateViewTools();
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

function zoomGlobe(factor) {
  if (view !== 'globe') return;
  const current = zoomTarget ?? zoom;
  const target = clamp(current * factor, 1, MAX_GLOBE_ZOOM);
  if (Math.abs(target - current) < 1e-4) return;
  animateCamera(rotation[0], rotation[1], target, 180);
  updateViewTools();
}

function resetGlobe() {
  animateCamera(DEFAULT_ROTATION[0], DEFAULT_ROTATION[1], 1, 420);
  updateViewTools();
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
    ? signed(value) + ' ' + active.unit + (mode === 'trend' ? '/decade' : projectedNow ? ' (projected, one possible year)' : '')
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
  const target = clamp((zoomTarget ?? zoom) * Math.exp(-event.deltaY * unit * .001), 1, MAX_GLOBE_ZOOM);
  animateCamera(...rotation, target, 130);
  updateViewTools();
}, {passive: false});
function kmBetween(lon1, lat1, lon2, lat2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function compassFrom(lon, lat, city) {
  const toRad = Math.PI / 180;
  const dLon = (lon - city.lon) * toRad;
  const lat1 = city.lat * toRad;
  const lat2 = lat * toRad;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return names[Math.round((Math.atan2(y, x) * 180 / Math.PI + 360) % 360 / 45) % 8];
}

function featureHits(features, lon, lat) {
  for (const feature of features) {
    const box = feature.bbox;
    if (box && (lon < box[0] || lat < box[1] || lon > box[2] || lat > box[3])) continue;
    if (d3.geoContains(feature, [lon, lat])) return feature;
  }
  return null;
}

function rememberBounds(feature) {
  let minLon = 180, minLat = 90, maxLon = -180, maxLat = -90;
  const walk = coordinates => {
    if (typeof coordinates[0] === 'number') {
      minLon = Math.min(minLon, coordinates[0]);
      maxLon = Math.max(maxLon, coordinates[0]);
      minLat = Math.min(minLat, coordinates[1]);
      maxLat = Math.max(maxLat, coordinates[1]);
      return;
    }
    coordinates.forEach(walk);
  };
  walk(feature.geometry.coordinates);
  feature.bbox = [minLon, minLat, maxLon, maxLat];
  return feature;
}

function oceanName(lon, lat) {
  const x = wrap(lon);
  if (lat > 66) return 'Arctic Ocean';
  if (lat < -55) return 'Southern Ocean';
  if (x >= -100 && x <= -5 && lat >= 0 && lat <= 70) return 'North Atlantic';
  if (x >= -70 && x <= 20 && lat < 0 && lat >= -55) return 'South Atlantic';
  if (x >= 100 || x <= -100) return lat >= 0 ? 'North Pacific' : 'South Pacific';
  if (x > 20 && x < 120 && lat < 30) return 'Indian Ocean';
  return lat >= 0 ? 'North Atlantic' : 'South Atlantic';
}

function onLand(lon, lat) {
  return Boolean(land && d3.geoContains(land, [lon, lat]));
}

function cityWeight(city) {
  const pop = city.pop || 1;
  if (city.cap === 2) return Math.max(pop, 1500000) * 3;
  if (city.cap === 1) return Math.max(pop, 150000) * 1.7;
  return pop;
}

// Returns the phrase for the nearest notable city and the city itself. A city in the
// clicked country (and province) wins over a bigger one just across a border.
function nearestCity(lon, lat, country = '', province = '') {
  const local = city => (country && city.country === country ? 6 : 1) * (province && city.region === province ? 3 : 1);
  let closest = null;
  let closestKm = Infinity;
  for (const city of majorCities) {
    const km = kmBetween(lon, lat, city.lon, city.lat);
    if (km < closestKm) {
      closestKm = km;
      closest = city;
    }
  }
  if (!closest) return null;
  // Among cities almost as close, prefer a capital, then a larger city.
  const windowKm = Math.max(closestKm * 1.35, closestKm + 40);
  let chosen = closest;
  let chosenKm = closestKm;
  let best = local(closest) * cityWeight(closest) / (closestKm + 25);
  for (const city of majorCities) {
    const km = kmBetween(lon, lat, city.lon, city.lat);
    if (km > windowKm) continue;
    const score = local(city) * cityWeight(city) / (km + 25);
    if (score > best) {
      best = score;
      chosen = city;
      chosenKm = km;
    }
  }
  const km = Math.round(chosenKm);
  // Across a border the click is not "in" that city, so give the distance instead.
  const elsewhere = (country && chosen.country !== country) || (province && chosen.region !== province);
  return {city: chosen, phrase: km < (elsewhere ? 8 : 45) ? chosen.name : km + ' km ' + compassFrom(lon, lat, chosen) + ' of ' + chosen.name};
}

function nearestCityPhrase(lon, lat) {
  return nearestCity(lon, lat)?.phrase ?? '';
}

// Name a clicked cell by the nearest major city, plus the province and country
// that city is in, so the two always agree. Open water, Antarctica, and the poles are named
// as those places first.
function locateCell(lon, lat) {
  if (lat >= 85) return 'North Pole · Arctic Ocean';
  if (lat <= -85) return 'South Pole · Antarctica';
  const landHit = onLand(lon, lat);
  if (!landHit) {
    const ocean = oceanName(lon, lat);
    const near = nearestCityPhrase(lon, lat);
    return near ? ocean + ' · ' + near : ocean;
  }
  const country = featureHits(countryFeatures, lon, lat)?.properties.name || '';
  if (country === 'Antarctica' || lat <= -60) {
    if (lat <= -85) return 'South Pole · Antarctica';
    return 'Antarctica';
  }
  const province = featureHits(provinces, lon, lat)?.properties;
  const regionName = province && province.admin === country ? province.name : '';
  const region = [regionName, country].filter(Boolean).join(', ');
  const near = nearestCity(lon, lat, country, regionName);
  if (!near) return region || 'Land';
  const cityRegion = [near.city.region, near.city.country].filter(Boolean).join(', ');
  return near.phrase + ' · ' + (cityRegion || region);
}

function selectMapCell(location) {
  const name = locateCell(location[0], location[1]);
  if (choosingComparison) {
    addComparison(name, location);
    return;
  }
  clearChartInterval();
  point = location;
  placeName = name;
  $('place-query').value = primaryQuery = '';
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
  if (event.key === '+' || event.key === '=') {
    event.preventDefault();
    zoomGlobe(GLOBE_ZOOM_STEP);
    return;
  }
  if (event.key === '-') {
    event.preventDefault();
    zoomGlobe(1 / GLOBE_ZOOM_STEP);
    return;
  }
  if (event.key === 'Home') {
    event.preventDefault();
    resetGlobe();
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
  updateViewTools();
  if (view === 'map' && width && height) updateFlatMap();
  $('map').dataset.view = view;
  rasterMap = null;
  queueDraw(200);
}

function normalizePlace(query) {
  return query.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

function coordinatePlace(query) {
  const part = '([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+))\\s*°?\\s*([NSEW]?)';
  const match = query.trim().match(new RegExp('^\\(?\\s*' + part + '(?:\\s*,\\s*|\\s+)' + part + '\\s*\\)?$', 'i'));
  if (!match) return null;
  const latitude = Number(match[1]), longitude = Number(match[3]);
  const ns = match[2].toUpperCase(), ew = match[4].toUpperCase();
  if (!['', 'N', 'S'].includes(ns) || !['', 'E', 'W'].includes(ew) ||
      (ns && /^[+-]/.test(match[1])) || (ew && /^[+-]/.test(match[3])) ||
      Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  const lat = ns === 'S' ? -latitude : latitude;
  const lon = ew === 'W' ? -longitude : longitude;
  if ((ns && latitude < 0) || (ew && longitude < 0)) return null;
  return {name: locateCell(lon, lat), region: coords([lon, lat]), lat, lon, kind: 'coordinates'};
}

function searchPlaces(query) {
  const coordinates = coordinatePlace(query);
  if (coordinates) return [coordinates];
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
  $('place-query').removeAttribute('aria-activedescendant');
}

function renderPlaceResults(matches) {
  placeMatches = matches;
  placeActive = matches.length ? 0 : -1;
  const list = $('place-results');
  if (!matches.length) {
    $('place-query').removeAttribute('aria-activedescendant');
    list.replaceChildren(Object.assign(document.createElement('li'), {
      className: 'place-empty',
      textContent: 'No match. Enter a city or latitude, longitude, such as 43.65, -79.38.',
      role: 'presentation',
    }));
    list.hidden = false;
    $('place-query').setAttribute('aria-expanded', 'true');
    return;
  }
  list.replaceChildren(...matches.map((place, index) => {
    const item = document.createElement('li');
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', index === placeActive);
    item.id = 'place-option-' + index;
    const button = document.createElement('button');
    button.type = 'button';
    button.tabIndex = -1;
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
    item.setAttribute('aria-selected', i === placeActive);
  }
  $('place-query').setAttribute('aria-activedescendant', 'place-option-' + placeActive);
  $('place-option-' + placeActive)?.scrollIntoView({block: 'nearest'});
}

function goToPlace(place, asComparison = choosingComparison) {
  if (asComparison) {
    addComparison(place.name, [place.lon, place.lat]);
    return;
  }
  if (choosingComparison) setChoosingComparison(false);
  clearChartInterval();
  placeName = place.name;
  point = [place.lon, place.lat];
  $('place-query').value = primaryQuery = place.name;
  closePlaceResults();
  recenter();
  updateInspector();
  queueDraw();
}

function setChoosingComparison(choosing) {
  if (choosing && !choosingComparison) primaryQuery = $('place-query').value;
  choosingComparison = choosing;
  closePlaceResults();
  const input = $('place-query');
  input.value = choosing ? '' : primaryQuery;
  input.placeholder = choosing ? 'Search a place or coordinates…' : 'Search a place or coordinates…';
  $('place-query-label').textContent = choosing ? 'Search for a comparison place or coordinates' : 'Search places or coordinates';
  $('compare').setAttribute('aria-pressed', choosing);
  $('compare-hint').hidden = !choosing;
  earth.setAttribute('aria-describedby', choosing ? 'compare-hint' : 'map-readout');
  earth.classList.toggle('picking-comparison', choosing);
  if (choosing) {
    input.focus();
    if ($('place-results').hidden) renderPlaceResults(searchPlaces(''));
  }
}

function refreshComparisons(status) {
  const comparing = comparisons.length > 0;
  setChoosingComparison(false);
  $('compare').textContent = comparing ? 'Add another place' : 'Compare';
  $('compare-status').textContent = status;
  $('comparison-list').replaceChildren(...comparisons.map((place, n) => tint(make('li', {},
    make('i', {className: 'cmp-bg'}), make('b', {className: 'cmp-fg'}, compareLabel(n)), make('span', {title: place.name}, place.name),
    Object.assign(make('button', {type: 'button', title: 'Remove ' + place.name}, '×'),
      {ariaLabel: 'Remove ' + place.name, value: n})), n)));
  for (const id of ['comparison-list', 'compare-clear', 'compare-period', 'compare-values', 'map-places']) $(id).hidden = !comparing;
  $('numbers').hidden = comparing;
  updateInspector();
  queueDraw();
}

function addComparison(name, location) {
  const index = cell(location).index;
  if (comparisons.some(place => place.name === name && cell(place.point).index === index)) {
    setChoosingComparison(false);
    return;
  }
  comparisons.push({name, point: location});
  refreshComparisons('Added ' + name + ' as ' + compareLabel(comparisons.length - 1) + '. Comparing ' + (comparisons.length + 1) + ' places.');
}

$('compare').addEventListener('click', () => setChoosingComparison(!choosingComparison));
$('compare-clear').addEventListener('click', () => {
  comparisons = [];
  refreshComparisons('Comparisons cleared.');
  $('compare').focus();
});
$('comparison-list').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  const [removed] = comparisons.splice(Number(button.value), 1);
  refreshComparisons('Removed ' + removed.name + '.');
  $('compare').focus();
});
$('compare-map').addEventListener('click', event => {
  event.preventDefault();
  closePlaceResults();
  earth.focus({preventScroll: true});
  $('map-panel-heading').scrollIntoView({block: 'start'});
});

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
    if (choosingComparison) {
      setChoosingComparison(false);
      $('compare').focus();
    } else {
      closePlaceResults();
      $('place-query').blur();
    }
  }
});
$('place-query').addEventListener('blur', () => {
  setTimeout(() => { if (document.activeElement !== $('place-query')) closePlaceResults(); }, 120);
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
  selectDate(Number(event.target.value), {scrub: true});
});
$('year').addEventListener('change', () => { if (active) update(120); });
$('timeline-date').addEventListener('submit', event => {
  event.preventDefault();
  jumpToTypedYear();
  $('year-entry').select();
});
$('year-entry').addEventListener('focus', event => {
  stop();
  event.target.select();
});
$('year-entry').addEventListener('input', () => setYearEntryStatus(''));
$('year-entry').addEventListener('change', jumpToTypedYear);
$('year-entry').addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  event.target.value = year;
  setYearEntryStatus('');
  event.target.blur();
});
$('play').addEventListener('click', play);
$('previous').addEventListener('click', () => { stop(); selectDate(timelineIndex - 1); });
$('next').addEventListener('click', () => { stop(); selectDate(timelineIndex + 1); });
$('recenter').addEventListener('click', recenter);
$('map-zoom-in').addEventListener('click', () => view === 'map' ? zoomFlatMap(FLAT_ZOOM_STEP) : zoomGlobe(GLOBE_ZOOM_STEP));
$('map-zoom-out').addEventListener('click', () => view === 'map' ? zoomFlatMap(1 / FLAT_ZOOM_STEP) : zoomGlobe(1 / GLOBE_ZOOM_STEP));
$('map-zoom-reset').addEventListener('click', () => view === 'map' ? resetFlatMap() : resetGlobe());
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- Scatterplot: two variables at the same place, one point per year ----------
let scatterKey = '', scatterVersion = 0, scatterData = null, scatterHover = null, scatterLayout = null;

function detrend(values) {
  const n = values.length, mx = (n - 1) / 2, my = values.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  values.forEach((v, i) => { sxy += (i - mx) * (v - my); sxx += (i - mx) ** 2; });
  const slope = sxx ? sxy / sxx : 0;
  return values.map((v, i) => v - slope * (i - mx));
}

function correlation(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  if (!sxx || !syy) return null;
  const slope = sxy / sxx;
  return {r: sxy / Math.sqrt(sxx * syy), slope, intercept: my - slope * mx, n};
}

// One place's measured record for any layer, keyed by year. Layers use different grids,
// so the cell is looked up from the selected coordinates each time.
async function scatterSeries(key) {
  const data = key === layer ? active : await loadDataset(key, periodKey());
  const step = 360 / data.width;
  const [lon, lat] = cell(point).center;
  const col = clamp(Math.floor((((lon + 180) % 360 + 360) % 360) / step), 0, data.width - 1);
  const row = clamp(Math.floor((90 - lat) / step), 0, data.height - 1);
  const index = row * data.width + col;
  const byYear = new Map();
  for (let i = 0; i < data.observed; i++) byYear.set(data.years[i], data.values[i * data.size + index]);
  return {name: data.name, unit: data.unit, byYear};
}

async function updateScatter() {
  const xKey = $('scatter-x').value || layer, yKey = $('scatter-layer').value;
  $('scatter-x').options[0].textContent = 'On the map: ' + (catalog[layer]?.name ?? '');
  for (const option of $('scatter-layer').options) option.disabled = option.value === xKey;
  const version = ++scatterVersion;
  scatterData = scatterHover = null;
  $('scatter-body').hidden = !yKey;
  $('scatter-csv').disabled = true;
  if (!yKey || !active || !chartData) { $('scatter-summary').textContent = ''; return; }
  $('scatter-r').textContent = '—';
  $('scatter-facts').replaceChildren();
  if (yKey === xKey) {
    $('scatter-summary').textContent = 'Pick two different variables.';
    drawScatter();
    return;
  }
  $('scatter-summary').textContent = 'Loading…';
  drawScatter();
  let first, second;
  try {
    [first, second] = await Promise.all([scatterSeries(xKey), scatterSeries(yKey)]);
  } catch {
    if (version === scatterVersion) $('scatter-summary').textContent = 'One of these variables could not load for this period.';
    return;
  }
  if (version !== scatterVersion) return;
  const points = [];
  for (const [year, x] of first.byYear) {
    const y = second.byYear.get(year);
    if (Number.isFinite(x) && Number.isFinite(y)) points.push({year, x, y});
  }
  points.sort((p, q) => p.year - q.year);
  scatterData = {key: xKey + '-vs-' + yKey, first, second, points};
  drawScatter();
}

function drawScatter() {
  const canvas = $('scatter');
  const [w, h] = sizeCanvas(canvas);
  if (!w || !h) return;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, w, h);
  scatterLayout = null;
  $('scatter-tooltip').hidden = true;
  if (!scatterData) return;
  const dark = document.documentElement.dataset.theme === 'dark';
  const c = chartColors(dark);
  const {first, second, points} = scatterData;
  const flat = $('scatter-detrend').checked;
  const xs = flat ? detrend(points.map(p => p.x)) : points.map(p => p.x);
  const ys = flat ? detrend(points.map(p => p.y)) : points.map(p => p.y);
  const fit = correlation(xs, ys);
  $('scatter-csv').disabled = !points.length;
  const fact = (label, value) => make('div', {}, make('dt', {}, label), make('dd', {}, value));
  if (!fit) {
    $('scatter-r').textContent = '—';
    $('scatter-facts').replaceChildren();
    $('scatter-summary').textContent = points.length
      ? 'Only ' + points.length + ' years have both variables here, too few for a correlation.'
      : 'No years have both variables at this place. Sea-only and land-only layers do not overlap.';
    if (!points.length) return;
  } else {
    const size = Math.abs(fit.r), strength = size < .2 ? 'No clear' : size < .4 ? 'Weak' : size < .7 ? 'Moderate' : 'Strong';
    $('scatter-r').textContent = signed(fit.r);
    $('scatter-summary').textContent = strength + (size < .2 ? '' : fit.r > 0 ? ' positive' : ' negative') + ' relationship' +
      (flat ? ', after removing each variable’s own trend.' : '.');
    $('scatter-facts').replaceChildren(
      fact('Years compared', fit.n + ' · ' + points[0].year + '–' + points.at(-1).year),
      fact('Variation shared (r²)', Math.round(fit.r * fit.r * 100) + '%'),
      fact('Line of best fit', signed(fit.slope) + ' ' + second.unit + ' per ' + first.unit));
  }
  const pad = (lo, hi) => { const m = (hi - lo || 1) * .06; return [lo - m, hi + m]; };
  const [x0, x1] = pad(Math.min(...xs), Math.max(...xs)), [y0, y1] = pad(Math.min(...ys), Math.max(...ys));
  const left = 52, right = w - 10, top = 10, bottom = h - 38;
  const px = v => left + (v - x0) / (x1 - x0) * (right - left), py = v => bottom - (v - y0) / (y1 - y0) * (bottom - top);
  g.font = '10px "IBM Plex Mono", monospace'; g.fillStyle = c.text; g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const vx = x0 + (x1 - x0) * i / 4, vy = y0 + (y1 - y0) * i / 4;
    g.strokeStyle = c.grid;
    g.beginPath(); g.moveTo(px(vx), top); g.lineTo(px(vx), bottom); g.moveTo(left, py(vy)); g.lineTo(right, py(vy)); g.stroke();
    g.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center'; g.fillText(signed(vx, 1), px(vx), bottom + 13);
    g.textAlign = 'right'; g.fillText(signed(vy, 1), left - 6, py(vy) + 3);
  }
  for (const [zero, vertical] of [[0, true], [0, false]]) {
    g.strokeStyle = c.zero; g.beginPath();
    if (vertical && x0 < 0 && x1 > 0) { g.moveTo(px(zero), top); g.lineTo(px(zero), bottom); }
    if (!vertical && y0 < 0 && y1 > 0) { g.moveTo(left, py(zero)); g.lineTo(right, py(zero)); }
    g.stroke();
  }
  g.font = '11px "IBM Plex Sans", sans-serif'; g.textAlign = 'center';
  g.fillText(first.name + ' (' + first.unit + ')', (left + right) / 2, h - 5);
  g.save(); g.translate(11, (top + bottom) / 2); g.rotate(-Math.PI / 2);
  g.fillText(second.name + ' (' + second.unit + ')', 0, 0); g.restore();
  if (fit) {
    g.save(); g.beginPath(); g.rect(left, top, right - left, bottom - top); g.clip();
    g.beginPath(); g.moveTo(px(x0), py(fit.intercept + fit.slope * x0)); g.lineTo(px(x1), py(fit.intercept + fit.slope * x1));
    g.strokeStyle = c.fit; g.lineWidth = 2; g.stroke(); g.restore();
  }
  // Older years are faint and recent years solid, so a drift over time shows up.
  points.forEach((point, i) => {
    g.globalAlpha = .25 + .75 * i / Math.max(1, points.length - 1);
    g.beginPath(); g.arc(px(xs[i]), py(ys[i]), i === scatterHover ? 5.5 : 3.2, 0, Math.PI * 2);
    g.fillStyle = c.line; g.fill();
  });
  g.globalAlpha = 1;
  scatterLayout = {px, py, xs, ys};
  if (scatterHover != null && points[scatterHover]) {
    const i = scatterHover, tooltip = $('scatter-tooltip');
    g.beginPath(); g.arc(px(xs[i]), py(ys[i]), 5.5, 0, Math.PI * 2); g.strokeStyle = c.marker; g.lineWidth = 1.5; g.stroke();
    tooltip.textContent = points[i].year + '\n' + first.name + ' ' + signed(points[i].x) + ' ' + first.unit +
      '\n' + second.name + ' ' + signed(points[i].y) + ' ' + second.unit;
    tooltip.hidden = false;
    tooltip.style.left = clamp(px(xs[i]) < w / 2 ? px(xs[i]) + 10 : px(xs[i]) - tooltip.offsetWidth - 10, 0, w - tooltip.offsetWidth) + 'px';
    tooltip.style.top = clamp(py(ys[i]) - tooltip.offsetHeight - 8, 0, h - tooltip.offsetHeight) + 'px';
  }
}

$('scatter-layer').addEventListener('change', updateScatter);
$('scatter-x').addEventListener('change', updateScatter);
$('scatter-detrend').addEventListener('change', drawScatter);
$('scatter').addEventListener('pointermove', event => {
  if (!scatterLayout) return;
  const box = $('scatter').getBoundingClientRect(), mx = event.clientX - box.left, my = event.clientY - box.top;
  let best = null, bestD = 18 * 18;
  scatterLayout.xs.forEach((x, i) => {
    const d = (scatterLayout.px(x) - mx) ** 2 + (scatterLayout.py(scatterLayout.ys[i]) - my) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  });
  if (best !== scatterHover) { scatterHover = best; drawScatter(); }
});
$('scatter').addEventListener('pointerleave', () => { if (scatterHover != null) { scatterHover = null; drawScatter(); } });
new ResizeObserver(() => { if (scatterData) drawScatter(); }).observe($('scatter'));
$('scatter-csv').addEventListener('click', () => {
  if (!scatterData) return;
  const {first, second, points, key} = scatterData;
  const rows = [['year', first.name + ' (' + first.unit + ')', second.name + ' (' + second.unit + ')']]
    .concat(points.map(p => [p.year, p.x, p.y]));
  saveBlob(new Blob([rows.map(row => row.map(v => typeof v === 'string' ? '"' + v + '"' : v).join(',')).join('\n') + '\n'],
    {type: 'text/csv'}), exportName(key, 'csv'));
});

function exportName(kind, extension) {
  const {center} = cell(point);
  return [layer, periodKey(), center[1], center[0], kind].join('-') + '.' + extension;
}

// Everything a spreadsheet or notebook needs to redo the fit: the measured
// series, the fitted line over its 30-year window, and the projection.
function exportRows() {
  const {center} = cell(point);
  const {series, estimate, basis, future} = chartData;
  const fitted = (fit, end, i) => fit && i > end - WINDOW && i <= end
    ? fit.mean + fit.slope * (i - (end - (WINDOW - 1) / 2)) : null;
  return active.years.map((y, i) => {
    const projected = i >= active.observed;
    const f = projected ? future?.[i - active.observed] : null;
    return {
      year: y, period: periodKey(), kind: projected ? 'projected' : 'observed',
      anomaly: !projected && Number.isFinite(series[i]) ? series[i] : null,
      trend_line: fitted(estimate, basis, i),
      projection: f?.value ?? null,
      projection_low_95: f?.low ?? null, projection_high_95: f?.high ?? null,
      projection_one_possible_year: f ? series[i] : null,
      unit: active.unit, latitude: center[1], longitude: center[0],
    };
  });
}

function trendSummary() {
  const {center} = cell(point);
  const {series, central, estimate, basis, future} = chartData;
  const basisYear = active.years[basis];
  const lastYear = active.years[active.observed - 1];
  const round = value => value == null || !Number.isFinite(value) ? null : Number(value.toFixed(5));
  return {
    place: placeName, latitude: center[1], longitude: center[0], grid_degrees: active.step,
    layer: active.name, period: periodKey(), unit: active.unit, baseline: active.reference,
    database: {agency: active.agency, product: active.product, page: active.source, original_file: active.download},
    record: {first_year: active.years[0], last_year: lastYear},
    selected_year: {year, kind: projectedNow ? 'projected' : 'observed', anomaly: round(central[yearIndex()])},
    trend: estimate && {
      method: 'Ordinary least squares over 30 consecutive years; Newey-West standard error, 3 lags',
      window: [basisYear - WINDOW + 1, basisYear],
      slope_per_year: round(estimate.slope), slope_per_decade: round(estimate.rate),
      // line(year) = value_at_mid_year + slope_per_year * (year - mid_year)
      mid_year: basisYear - (WINDOW - 1) / 2, value_at_mid_year: round(estimate.mean),
      ci95_per_decade: [round(estimate.low), round(estimate.high)], p_value: round(estimate.p),
      significant_at_5_percent: estimate.p == null ? null : estimate.p < .05,
    },
    projection: future && {
      method: future[0].filled
        ? 'No complete record in this cell, so the projected map is filled from neighboring cells'
        : future[0].complete === false
          ? 'Years present in the latest 30-year window, continued forward. No 95% range: the window is incomplete'
          : 'Trend of ' + (lastYear - WINDOW + 1) + '-' + lastYear + ' continued, damped by 1 - 1/t^2 when weak; ' +
            '95% range is the Student t prediction interval (28 degrees of freedom) widened by min(2, 1.25 + 0.03k) for the k-th projected year, calibrated on hindcasts',
      trend_weight: round(future[0].weight),
      one_possible_year: 'value plus the departure from trend of a past year in the window; this is what the map shows',
      caution: 'Statistical extrapolation of past data. Not a climate model forecast.',
      values: future.map((f, i) => ({year: active.years[active.observed + i], value: round(f.value),
        low_95: round(f.low), high_95: round(f.high), one_possible_year: round(series[active.observed + i])})),
    },
    generated: new Date().toISOString(),
  };
}

// Spreadsheet apps often open CSVs as Windows-1252. Fancy Unicode (° en-dash)
// then becomes mojibake like ¬∞ or ‚Äì. Keep the file UTF-8 with a BOM, and
// also flatten those characters to plain ASCII so the cells stay readable.
function csvText(value) {
  if (value == null) return '';
  const raw = typeof value === 'number' && !Number.isInteger(value) ? value.toFixed(5) : String(value);
  return raw
    .replaceAll('\u00b0C', 'degC')
    .replaceAll('\u00b0', 'deg')
    .replaceAll(/[\u2012\u2013\u2014\u2212]/g, '-')
    .replaceAll(/[\u2018\u2019]/g, "'")
    .replaceAll(/[\u201c\u201d]/g, '"')
    .replaceAll(/[\u00a0\u2009\u202f]/g, ' ')
    .replaceAll('\u00b7', ' | ');
}

$('csv').addEventListener('click', () => {
  if (!active || !chartData) return;
  const rows = exportRows();
  const columns = Object.keys(rows[0]);
  const quote = value => /[",\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
  const extra = {baseline: active.reference, product: active.product, source: active.source};
  const lines = [[...columns, ...Object.keys(extra)].join(','),
    ...rows.map(row => [...columns.map(key => csvText(row[key])), ...Object.values(extra).map(csvText)].map(quote).join(','))];
  // BOM helps Excel detect UTF-8; ASCII flattening covers other importers.
  saveBlob(new Blob(['\uFEFF' + lines.join('\n') + '\n'], {type: 'text/csv;charset=utf-8'}), exportName('series', 'csv'));
});

$('trend-json').addEventListener('click', () => {
  if (!active || !chartData) return;
  saveBlob(new Blob([JSON.stringify(trendSummary(), null, 2) + '\n'], {type: 'application/json'}), exportName('trend', 'json'));
});

function exportCanvas(width, height, dark) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const g = canvas.getContext('2d');
  g.fillStyle = dark ? '#18241f' : '#ffffff';
  g.fillRect(0, 0, width, height);
  return [canvas, g];
}

$('chart-png').addEventListener('click', () => {
  if (!active || !chartData) return;
  const dark = document.documentElement.dataset.theme === 'dark';
  const W = 1600, H = 900, pad = 56, k = 2.2;
  const [canvas, g] = exportCanvas(W, H, dark);
  const {center} = cell(point);
  const c = chartColors(dark);
  const ink = dark ? '#e8eee4' : '#172721';
  g.fillStyle = ink; g.font = '600 38px "Bricolage Grotesque", "IBM Plex Sans", sans-serif';
  g.fillText(placeName + ': ' + active.name.toLowerCase(), pad, 78);
  g.fillStyle = c.text; g.font = '22px "IBM Plex Sans", sans-serif';
  g.fillText((showMonthly ? 'Monthly' : periodTitle()) + ' anomaly in ' + active.unit + ', relative to ' + active.reference + '. Grid cell centered at ' +
    coords(center).replace(' · ', ', ') + '.', pad, 116);
  const {future, central, other, others} = chartData;
  const fit = chartFit(central);
  const legend = [[c.line, other ? 'A · ' + placeName : 'Measured', false]];
  for (const o of others) legend.push([compareColor(o.n, dark), o.label + ' · ' + o.name, false]);
  if (showMonthly && monthlyWindow?.fit) legend.push([c.fit, 'Line of best fit · ' + signed(monthlyWindow.fit.perYear) + ' ' + active.unit + ' per year' +
    (monthlySelection() ? ' · ' + monthlySelection().map(monthlyLabel).join('–') : ''), false]);
  if (fit && !showMonthly) legend.push([c.fit, 'Trend line ' + active.years[fit.start] + '–' + active.years[fit.end], false]);
  if (future && !showMonthly) legend.push([c.proj, other ? 'A projection and range' : 'Projection to ' + active.years.at(-1) + ' with 95% range', true]);
  if (others.some(o => o.future) && !showMonthly) legend.push([c.text, others.length > 1 ? 'Comparison projections' : 'B projection', true]);
  let lx = pad;
  let ly = 160;
  g.font = '20px "IBM Plex Sans", sans-serif';
  for (const [color, label, dashed] of legend) {
    const length = 48 + g.measureText(label).width;
    if (lx + length > W - pad) { lx = pad; ly += 32; }
    g.beginPath(); g.moveTo(lx, ly); g.lineTo(lx + 38, ly);
    g.strokeStyle = color; g.lineWidth = 4; g.setLineDash(dashed ? [10, 6] : []); g.stroke(); g.setLineDash([]);
    g.fillStyle = ink; g.fillText(label, lx + 48, ly + 7);
    lx += length + 40;
  }
  const chartTop = ly + 30;
  if (showMonthly && monthlyWindow) {
    g.save();
    g.translate(pad, chartTop);
    paintMonthlyPlot(g, W - 2 * pad, H - chartTop - 86, monthlyWindow.records, dark, k);
    g.restore();
  } else paintChart(g, pad, chartTop, W - 2 * pad, H - chartTop - 86, {dark, k, interactive: false});
  g.fillStyle = c.text; g.font = '18px "IBM Plex Sans", sans-serif';
  g.fillText('Data: ' + active.agency + ', ' + active.product + '. ' + active.source, pad, H - 34);
  g.textAlign = 'right'; g.fillText('GQ Atlas', W - pad, H - 34);
  canvas.toBlob(blob => saveBlob(blob, exportName('chart', 'png')), 'image/png');
});

$('map-png').addEventListener('click', () => {
  if (!active || !rendered) return;
  const shown = comparisons.slice(0, 8);
  const head = 96, foot = comparisons.length ? 78 + 24 * (shown.length + (comparisons.length > shown.length)) : 54;
  const [canvas, g] = exportCanvas(earth.width, earth.height + head + foot, true);
  g.fillStyle = '#0b191d'; g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(earth, 0, head);
  g.fillStyle = '#edf0e8'; g.font = '600 30px "Bricolage Grotesque", "IBM Plex Sans", sans-serif';
  g.fillText(active.name + ', ' + $('map-year').textContent + (projectedNow ? ' (projected)' : ''), 24, 44);
  g.fillStyle = '#afbfb5'; g.font = '17px "IBM Plex Sans", sans-serif';
  const scale = mode === 'trend' ? active.trendScale : active.scale;
  g.fillText((mode === 'trend' ? 'Change per decade' : 'Anomaly relative to ' + active.reference) +
    '. Color scale −' + scale + ' to +' + scale + ' ' + active.unit + '.', 24, 74);
  if (comparisons.length) {
    let ly = earth.height + head + 30;
    g.fillStyle = '#fffce8'; g.fillText('○ A  ' + placeName, 24, ly, canvas.width - 48);
    shown.forEach((place, n) => {
      g.fillStyle = compareColor(n, true);
      g.fillText('◇ ' + compareLabel(n) + '  ' + place.name, 24, ly += 24, canvas.width - 48);
    });
    g.fillStyle = '#afbfb5';
    if (comparisons.length > shown.length) g.fillText('+ ' + (comparisons.length - shown.length) + ' more places', 24, ly += 24);
  }
  g.fillText('Data: ' + active.agency + ', ' + active.product + '. GQ Atlas.', 24, canvas.height - 20);
  canvas.toBlob(blob => saveBlob(blob, [layer, mode, $('map-year').textContent.replace(/\s+/g, '-'), 'map'].join('-') + '.png'), 'image/png');
});

$('jump-latest').addEventListener('click', () => { stop(); selectDate(lastObservedIndex()); });

function sourceLinks(info) {
  const page = Object.assign(document.createElement('a'), {href: info.source, target: '_blank', rel: 'noopener', textContent: 'Dataset page'});
  const file = Object.assign(document.createElement('a'), {href: info.download, target: '_blank', rel: 'noopener', textContent: 'Original file (NetCDF)'});
  return [page, file];
}

function renderSources() {
  if (!catalog) return;
  const info = catalog[layer];
  const element = (tag, className, text) => Object.assign(document.createElement(tag), {className, textContent: text ?? ''});
  const current = $('source-current');
  const facts = element('dl', 'source-facts');
  for (const [term, value] of [['Provider', info.agency], ['Years', info.years[0] + '–' + info.years.at(-1)],
    ['Compared with', info.reference + ' average'], ['Map grid', info.step + '° cells']]) {
    const row = document.createElement('div');
    row.append(element('dt', '', term), element('dd', '', value));
    facts.append(row);
  }
  const links = element('p', 'source-links');
  links.append(...sourceLinks(info));
  current.replaceChildren(element('p', 'source-kicker', 'On the map now: ' + info.name), element('h3', '', info.product), facts, links);
  if (!$('source-rows').childElementCount) {
    $('source-rows').replaceChildren(...Object.entries(catalog).map(([key, data]) => {
      const row = document.createElement('tr');
      row.dataset.layer = key;
      const name = element('th', '');
      name.scope = 'row';
      const pick = element('button', 'linkish', data.name);
      pick.type = 'button';
      pick.addEventListener('click', () => {
        $('layer').value = key;
        selectLayer(key);
        $('atlas').scrollIntoView({block: 'start'});
      });
      name.append(pick);
      const links = element('td', 'source-links');
      links.append(...sourceLinks(data));
      row.append(name, element('td', '', data.agency + ', ' + data.product),
        element('td', '', data.years[0] + '–' + data.years.at(-1)), links);
      return row;
    }));
  }
  for (const row of $('source-rows').children) row.classList.toggle('current', row.dataset.layer === layer);
}

// Landing page hooks: the hero search and the "show me" buttons in the steps.
document.addEventListener('atlas-find-place', event => {
  const query = event.detail;
  const match = active ? searchPlaces(query)[0] : null;
  $('atlas').scrollIntoView({block: 'start'});
  if (match && query.trim()) {
    goToPlace(match, false);
  } else {
    if (choosingComparison) setChoosingComparison(false);
    $('place-query').value = query;
    $('place-query').focus({preventScroll: true});
  }
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
  $('scatter-layer').replaceChildren(new Option('Choose a variable…', ''),
    ...[...groups.values()].map(group => group.cloneNode(true)));
  $('scatter-x').replaceChildren(new Option('On the map', ''),
    ...[...groups.values()].map(group => group.cloneNode(true)));
  $('layer').value = layer;
  $('layer').disabled = false;
}

document.addEventListener('atlas-theme-change', () => { if (active) updateInspector(); });
new ResizeObserver(queueDraw).observe(earth);
new ResizeObserver(() => { if (active) updateInspector(); }).observe($('chart'));
new ResizeObserver(drawChart).observe($('chart-preview'));

try {
  // Start the default layer's download the moment the catalog arrives,
  // without waiting for coastlines, borders, or the city list.
  const catalogReady = fetchAsset('catalog.json').then(response => response.json()).then(loaded => {
    catalog = loaded;
    loadDataset(layer, 'annual').catch(() => {});
    return loaded;
  });
  let admin1;
  [catalog, land, borders, cities, majorCities, admin1] = await Promise.all([catalogReady,
    ...['land.json', 'countries.json', 'cities.json', 'major-cities.json', 'admin1.json'].map(async file => (await fetchAsset(file)).json())]);
  d3 = window.d3;
  globe = d3.geoOrthographic().clipAngle(90);
  flatMap = d3.geoEquirectangular();
  countryFeatures = window.topojson.feature(borders, borders.objects.countries).features.map(rememberBounds);
  provinces = admin1.features.map(rememberBounds);
  land = window.topojson.feature(land, land.objects.land);
  borders = window.topojson.mesh(borders, borders.objects.countries, (a, b) => a !== b);
  populateLayers();
  changeView(view);
  await selectLayer(layer);
} catch (error) {
  $('map-status').textContent = 'The atlas could not initialize. Reload to retry.';
  console.error(error);
}
