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
let timer, frame, drag, active, width, height, mapBounds, rasterMap, grid;
let cameraFrame, zoomTarget, cellColors;
let flatMap, flatZoom = 1, flatOffset = [0, 0];
let chartData, chartCursor, chartLayout;
let intervalAnchor = null, intervalEnd = null;
let placeMatches = [], placeActive = -1;
const chart = $('chart');
const datasets = new Map();
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
    // Continue every cell's latest 30-year trend so the timeline can run past the record.
    const size = info.width * info.height;
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
  $('raw-source').textContent = info.shortSource;
  $('raw-source').href = info.source;
  renderSources();
  $('layer-baseline').textContent = timeline[0].year + '–' + timeline[Math.max(0, lastObservedIndex())].year + ' · Baseline ' + info.reference;
  for (const id of ['csv', 'chart-png', 'trend-json', 'map-png']) $(id).disabled = true;
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
  $('year-label').value = projectedNow ? label + ' · projected' : label;
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
  $('chart-title').textContent = periodTitle() + ' anomalies';
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
  // For projected years the trend shown is the one the projection continues.
  const basis = Math.min(idx, active.observed - 1);
  const estimate = trend(series, basis);
  const basisYear = active.years[basis];
  const steps = active.years.length - active.observed;
  let future = steps ? forecast(series, active.observed - 1, steps, active.years[active.observed]) : null;
  // A gap with no series of its own takes the value already filled into the map.
  if (!future && steps) {
    const tail = series.slice(active.observed);
    if (tail.length && tail.every(Number.isFinite)) {
      future = tail.map(value => ({value, low: value, high: value, filled: true}));
    }
  }
  // Measured values, then the central projection (the map shows the simulated year instead).
  const central = future ? series.map((value, i) => i < active.observed ? value : future[i - active.observed].value) : series;
  const range = projectedNow && future ? future[idx - active.observed] : null;
  $('place-name').textContent = placeName;
  $('coordinates').textContent = coords(center);
  $('resolution').textContent = active.step + '° grid';
  $('value-label').textContent = labelForYear(year) + (projectedNow ? ' projected anomaly' : ' anomaly');
  $('value').classList.toggle('is-projected', projectedNow);
  setMetric($('value'), central[idx], active.unit);
  if (range && !range.filled && range.high - range.low > 1e-9) {
    const error = document.createElement('small');
    error.className = 'pm';
    error.textContent = '± ' + ((range.high - range.low) / 2).toFixed(2) + ' (95% range)';
    $('value').append(error);
  }
  setMetric($('slope'), estimate?.rate, active.unit);
  $('chart').setAttribute('aria-label', periodTitle() + ' anomalies in ' + active.unit + ' for ' + coords(center) +
    ', measured from ' + active.years[0] + ' to ' + active.years[active.observed - 1] +
    (steps ? ' and projected to ' + active.years.at(-1) : '') + '. Use arrow keys to inspect, Enter to select endpoints, and Escape to clear.');
  const empty = !series.some(Number.isFinite);
  for (const id of ['csv', 'chart-png', 'trend-json']) $(id).disabled = empty;
  $('map-png').disabled = false;
  const hasTest = estimate?.p != null;
  $('trend-details').hidden = !hasTest;
  $('trend-period').textContent = estimate ? (basisYear - WINDOW + 1) + '–' + basisYear : '';
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
    $('inference').textContent = (estimate.p < .05 ? 'Significant at 5%' : 'Not significant at 5%') +
      (projectedNow ? '. The ' + year + ' value is an estimate built on this trend, not a measurement.' : '');
  } else {
    $('inference').textContent = estimate ? 'Uncertainty estimate unavailable.' : 'Trend requires 30 consecutive years.';
  }
  chartData = {series, central, idx, estimate, basis, future};
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

function chartColors(dark) {
  return {
    text: dark ? '#b1c1b4' : '#526258', grid: dark ? '#384a40' : '#dde1d5', zero: '#a0aa9f',
    window: dark ? '#2d4135' : '#e1eadc', line: dark ? '#a6d6b8' : '#2d7655', dot: dark ? '#a6d6b8' : '#24523e',
    fit: dark ? '#f0a880' : '#a7462c', proj: dark ? PROJ.dark : PROJ.light,
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

// Paints the location chart into the rectangle (ox, oy, w, h). `k` scales
// strokes and type so the same routine serves the panel and the PNG export.
function paintChart(g, ox, oy, w, h, {dark, k = 1, interactive = true} = {}) {
  const {series, central, idx, estimate, basis, future} = chartData;
  const c = chartColors(dark);
  const observedCount = active.observed;
  const finite = series.filter(Number.isFinite);
  const left = ox + 37 * k, right = ox + w - 7 * k, top = oy + 8 * k, bottom = oy + h - 20 * k;
  if (!finite.length) {
    g.font = 12 * k + 'px sans-serif'; g.fillStyle = c.text;
    g.fillText('No observations for this grid cell', ox + 5 * k, oy + h / 2);
    return {left, right, bottom, top, x: () => left};
  }
  const extremes = future ? future.flatMap(f => [f.low, f.high]) : [];
  const min = Math.min(0, ...finite, ...extremes), max = Math.max(0, ...finite, ...extremes);
  const x = i => left + i / (series.length - 1) * (right - left);
  const y = value => bottom - (max === min ? .5 : (value - min) / (max - min)) * (bottom - top);
  const lastX = x(observedCount - 1);
  if (future) { g.fillStyle = c.zone; g.fillRect(lastX, top, right - lastX, bottom - top); }
  if (interactive && intervalAnchor !== null) {
    const other = intervalEnd ?? chartCursor ?? intervalAnchor;
    g.fillStyle = c.intervalFill;
    g.fillRect(Math.min(x(intervalAnchor), x(other)), top, Math.abs(x(intervalAnchor) - x(other)), bottom - top);
  } else if (estimate) {
    g.fillStyle = c.window;
    g.fillRect(x(basis - WINDOW + 1), top, x(basis) - x(basis - WINDOW + 1), bottom - top);
  }
  g.font = 9 * k + 'px "IBM Plex Mono", monospace'; g.fillStyle = c.text; g.textAlign = 'left';
  for (const tick of [...new Set([min, 0, max])]) {
    const ty = y(tick);
    g.beginPath(); g.moveTo(left, ty); g.lineTo(right, ty);
    g.strokeStyle = tick === 0 ? c.zero : c.grid; g.lineWidth = k; g.stroke();
    g.fillText(signed(tick, 1), ox, clamp(ty + 3 * k, oy + 9 * k, bottom + 2 * k));
  }
  const axisY = oy + h - 3 * k;
  g.fillText(active.years[0], left, axisY);
  g.textAlign = 'right'; g.fillText(active.years.at(-1), right, axisY);
  if (future) {
    g.textAlign = lastX > right - 60 * k ? 'right' : 'center';
    g.fillText(active.years[observedCount - 1], Math.min(lastX, right - 30 * k), axisY);
  }
  g.textAlign = 'left';
  if (future) {
    g.beginPath();
    future.forEach((f, i) => g.lineTo(x(observedCount + i), y(f.high)));
    for (let i = future.length - 1; i >= 0; i--) g.lineTo(x(observedCount + i), y(future[i].low));
    g.closePath(); g.fillStyle = c.band; g.fill();
  }
  g.beginPath();
  let connected = false;
  for (let i = 0; i < observedCount; i++) {
    const value = series[i];
    if (!Number.isFinite(value)) { connected = false; continue; }
    if (connected) g.lineTo(x(i), y(value)); else g.moveTo(x(i), y(value));
    connected = true;
  }
  g.strokeStyle = c.line; g.lineWidth = 1.35 * k; g.lineJoin = 'round'; g.stroke();
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
  return {left, right, bottom, top, x, y, c};
}

function chartPointLabel(index) {
  const {central, future} = chartData;
  if (!Number.isFinite(central[index])) return labelForYear(active.years[index]) + ' · No data';
  const f = index >= active.observed ? future?.[index - active.observed] : null;
  return labelForYear(active.years[index]) + ' · ' + signed(central[index]) + ' ' + active.unit +
    (f ? ' ± ' + ((f.high - f.low) / 2).toFixed(2) + ' (projected)' : '');
}

function drawChart() {
  if (!active || !chartData) return;
  const {series, central, idx} = chartData;
  const g = chart.getContext('2d');
  const [w, h] = sizeCanvas(chart);
  g.clearRect(0, 0, w, h);
  const dark = document.documentElement.dataset.theme === 'dark';
  const inspected = chartCursor ?? idx;
  const label = chartPointLabel(inspected);
  $('chart-readout').textContent = label;
  const tooltip = $('chart-tooltip');
  tooltip.textContent = label;
  const hasData = series.some(Number.isFinite);
  tooltip.hidden = chartCursor == null || !hasData;
  const {left, right, bottom, top, x, y, c} = paintChart(g, 0, 0, w, h, {dark});
  chartLayout = {left, right, bottom};
  if (!hasData) return;
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
  const startValue = chartData.central[start];
  const endValue = chartData.central[end];
  $('interval-summary').textContent = startYear + '–' + endYear + ' · ' +
    (endYear - startYear) + (endYear - startYear === 1 ? ' year' : ' years') +
    (end >= active.observed ? ' · includes projected values' : '');
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

function nearestCityPhrase(lon, lat) {
  let closest = null;
  let closestKm = Infinity;
  for (const city of majorCities) {
    const km = kmBetween(lon, lat, city.lon, city.lat);
    if (km < closestKm) {
      closestKm = km;
      closest = city;
    }
  }
  if (!closest) return '';
  // Among cities almost as close, prefer a capital, then a larger city.
  const windowKm = Math.max(closestKm * 1.35, closestKm + 40);
  let chosen = closest;
  let chosenKm = closestKm;
  let best = cityWeight(closest) / (closestKm + 25);
  for (const city of majorCities) {
    const km = kmBetween(lon, lat, city.lon, city.lat);
    if (km > windowKm) continue;
    const score = cityWeight(city) / (km + 25);
    if (score > best) {
      best = score;
      chosen = city;
      chosenKm = km;
    }
  }
  const km = Math.round(chosenKm);
  return km < 45 ? chosen.name : km + ' km ' + compassFrom(lon, lat, chosen) + ' of ' + chosen.name;
}

// Name a clicked cell by the nearest major city, plus the province and country
// the point actually falls in. Open water, Antarctica, and the poles are named
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
  const near = nearestCityPhrase(lon, lat);
  if (!near) return region || 'Land';
  return region ? near + ' · ' + region : near;
}

function selectMapCell(location) {
  clearChartInterval();
  point = location;
  placeName = locateCell(location[0], location[1]);
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
  selectDate(Number(event.target.value), {scrub: true});
});
$('year').addEventListener('change', () => { if (active) update(120); });
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
  g.fillText(periodTitle() + ' anomaly in ' + active.unit + ', relative to ' + active.reference + '. Grid cell centered at ' +
    coords(center).replace(' · ', ', ') + '.', pad, 116);
  const {future, central} = chartData;
  const fit = chartFit(central);
  const legend = [[c.line, 'Measured', false]];
  if (fit) legend.push([c.fit, 'Trend line ' + active.years[fit.start] + '–' + active.years[fit.end], false]);
  if (future) legend.push([c.proj, 'Projection to ' + active.years.at(-1) + ' with 95% range', true]);
  let lx = pad;
  g.font = '20px "IBM Plex Sans", sans-serif';
  for (const [color, label, dashed] of legend) {
    g.beginPath(); g.moveTo(lx, 160); g.lineTo(lx + 38, 160);
    g.strokeStyle = color; g.lineWidth = 4; g.setLineDash(dashed ? [10, 6] : []); g.stroke(); g.setLineDash([]);
    g.fillStyle = ink; g.fillText(label, lx + 48, 167);
    lx += 48 + g.measureText(label).width + 40;
  }
  paintChart(g, pad, 190, W - 2 * pad, H - 190 - 86, {dark, k, interactive: false});
  g.fillStyle = c.text; g.font = '18px "IBM Plex Sans", sans-serif';
  g.fillText('Data: ' + active.agency + ', ' + active.product + '. ' + active.source, pad, H - 34);
  g.textAlign = 'right'; g.fillText('GQ Atlas', W - pad, H - 34);
  canvas.toBlob(blob => saveBlob(blob, exportName('chart', 'png')), 'image/png');
});

$('map-png').addEventListener('click', () => {
  if (!active || !rendered) return;
  const head = 96, foot = 54;
  const [canvas, g] = exportCanvas(earth.width, earth.height + head + foot, true);
  g.fillStyle = '#0b191d'; g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(earth, 0, head);
  g.fillStyle = '#edf0e8'; g.font = '600 30px "Bricolage Grotesque", "IBM Plex Sans", sans-serif';
  g.fillText(active.name + ', ' + $('map-year').textContent + (projectedNow ? ' (projected)' : ''), 24, 44);
  g.fillStyle = '#afbfb5'; g.font = '17px "IBM Plex Sans", sans-serif';
  const scale = mode === 'trend' ? active.trendScale : active.scale;
  g.fillText((mode === 'trend' ? 'Change per decade' : 'Anomaly relative to ' + active.reference) +
    '. Color scale −' + scale + ' to +' + scale + ' ' + active.unit + '.', 24, 74);
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
    goToPlace(match);
  } else {
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
  $('layer').value = layer;
  $('layer').disabled = false;
}

document.addEventListener('atlas-theme-change', () => { if (active) updateInspector(); });
new ResizeObserver(queueDraw).observe(earth);
new ResizeObserver(() => { if (active) updateInspector(); }).observe($('chart'));

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
