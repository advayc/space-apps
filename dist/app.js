import { WINDOW, slopeAt, trend } from './statistics.js';

const $ = id => document.getElementById(id);
const earth = $('earth');
const ctx = earth.getContext('2d');
const raster = document.createElement('canvas');
const rasterCtx = raster.getContext('2d');
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
  precipitation: ['#a14d2c', '#d49c67', '#eeeacb', '#73b5a5', '#28786f'],
};
const palette = Object.fromEntries(Object.entries(themes).map(([key, colors]) => [
  key, Array.from({length: 256}, (_, i) => {
    const fraction = i / 255 * (colors.length - 1);
    const a = rgb(colors[Math.floor(fraction)]);
    const b = rgb(colors[Math.ceil(fraction)]);
    return a.map((x, channel) => x + (b[channel] - x) * (fraction % 1));
  }),
]));
function rgb(hex) {
  return hex.slice(1).match(/../g).map(channel => parseInt(channel, 16));
}

let catalog, land, borders, d3, globe, projection;
let layer = 'temperature', view = 'globe', mode = 'annual', year = 2025;
let rotation = [93, -46], zoom = 1, placeKey = 'arctic', point = places.arctic.slice(1);
let timer, frame, drag, active, width, height, mapBounds, rasterMap, grid;
const datasets = new Map();
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
async function loadDataset(key) {
  if (!datasets.has(key)) {
    const request = (async () => {
      const info = catalog[key];
      const response = await fetchAsset(info.file);
      const bytes = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      const expected = info.width * info.height * info.years.length;
      if (bytes.byteLength !== 4 * expected) throw new Error('Data size mismatch');
      // Decode the explicit little-endian format even on a big-endian host.
      const values = new Float32Array(bytes);
      if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
        const decoded = new DataView(bytes);
        for (let i = 0; i < values.length; i++) values[i] = decoded.getFloat32(4 * i, true);
      }
      return { ...info, values, size: info.width * info.height };
    })().catch(error => { datasets.delete(key); throw error; });
    datasets.set(key, request);
  }
  return datasets.get(key);
}

async function selectLayer(key) {
  stop();
  layer = key;
  active = null;
  window.clearTimeout(hoverTimer);
  $('tooltip').hidden = true;
  $('map-status').hidden = false;
  $('map-status').textContent = 'Loading climate data…';
  for (const button of document.querySelectorAll('[data-layer]')) {
    button.setAttribute('aria-pressed', button.dataset.layer === layer);
  }
  $('csv').disabled = true;
  try {
    const data = await loadDataset(key);
    if (layer !== key) return;
    active = data;
    rasterMap = null;
    year = clamp(year, minimumYear(), active.years.at(-1));
    $('map-status').hidden = true;
    update();
  } catch (error) {
    if (layer === key) {
      $('map-status').textContent = 'Climate data could not load. Select the layer to retry.';
      console.error(error);
    }
  }
}

function minimumYear() { return active.years[mode === 'trend' ? WINDOW - 1 : 0]; }
function cell([lon, lat]) {
  const col = clamp(Math.floor((wrap(lon) + 180) / active.step), 0, active.width - 1);
  const row = clamp(Math.floor((90 - lat) / active.step), 0, active.height - 1);
  return { index: row * active.width + col,
    center: [-180 + (col + .5) * active.step, 90 - (row + .5) * active.step] };
}
function history(index) {
  return active.years.map((_, i) => active.values[i * active.size + index]);
}
function yearIndex() { return year - active.years[0]; }
function setYear(next) {
  if (!active) return;
  year = clamp(next, minimumYear(), active.years.at(-1));
  update();
}

function update() {
  if (!active) return;
  const idx = yearIndex();
  const climate = active.values.subarray(idx * active.size, (idx + 1) * active.size);
  grid = mode === 'trend'
    ? Float32Array.from({length: active.size}, (_, i) => slopeAt(active.values, idx, active.size, i) * 10)
    : climate;
  const min = minimumYear();
  const max = active.years.at(-1);
  Object.assign($('year'), {min, max, value: year});
  $('year').setAttribute('aria-valuetext', mode === 'trend' ? (year - WINDOW + 1) + ' to ' + year : String(year));
  $('year-label').value = year;
  $('time-ticks').replaceChildren(...[min, Math.round((min + max) / 2), max].map(tick => {
    const span = document.createElement('span'); span.textContent = tick; return span;
  }));
  $('previous').disabled = year === min;
  $('next').disabled = year === max;
  $('map-year').textContent = mode === 'trend' ? (year - WINDOW + 1) + '–' + year : year;
  $('mode-label').textContent = mode === 'trend' ? '30-YEAR LINEAR TREND' : 'ANNUAL ANOMALY';
  $('map-source').textContent = active.agency + ' / ' + (layer === 'temperature' ? 'GISTEMP v4' : 'GPCP v2.3');
  $('legend-title').textContent = (mode === 'trend' ? 'Change / decade' : 'Anomaly') + ' (' + active.unit + ')';
  const scale = mode === 'trend' ? active.trendScale : active.scale;
  $('legend-min').textContent = '≤ −' + scale;
  $('legend-max').textContent = '≥ +' + scale;
  $('ramp').style.background = 'linear-gradient(90deg,' + themes[layer].join(',') + ')';
  updateInspector();
  queueDraw();
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

function queueDraw() {
  if (!frame) frame = requestAnimationFrame(() => { frame = null; drawMap(); });
}

function geometry() {
  const scale = Math.min(width / 2.06, height / 2.12) * zoom;
  const cx = width * .5, cy = height * .52;
  if (view === 'globe') {
    globe.rotate(rotation).scale(scale).translate([cx, cy]);
    projection = globe;
    mapBounds = [Math.max(0, cx - scale), Math.max(0, cy - scale), Math.min(width, cx + scale), Math.min(height, cy + scale)];
  } else {
    const mapWidth = Math.min(width - 18, (height - 126) * 2);
    projection = d3.geoEquirectangular().translate([cx, cy]).scale(mapWidth / (2 * Math.PI));
    mapBounds = [cx - mapWidth / 2, cy - mapWidth / 4, cx + mapWidth / 2, cy + mapWidth / 4];
  }
}

function mapRaster() {
  const [left, top, right, bottom] = mapBounds;
  const sw = right - left, sh = bottom - top;
  const scale = Math.min(1.3, 540 / Math.max(sw, sh));
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
      indices[index] = cell(location).index;
      if (view === 'globe') {
        const z = Math.sqrt(1 - dx * dx - dy * dy);
        shade[index] = .72 + .28 * clamp(-dx * .35 - dy * .45 + z * .88, 0, 1);
      }
    }
  }
  return {indices, shade, image: rasterCtx.createImageData(w, h)};
}

function drawMap() {
  if (!active || !d3 || !grid) return;
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
  rasterMap ??= mapRaster();
  const {indices, shade, image} = rasterMap;
  const colors = palette[layer];
  const scale = mode === 'trend' ? active.trendScale : active.scale;
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] < 0) continue;
    const value = grid[indices[i]];
    const color = Number.isFinite(value) ? colors[clamp(Math.round((value / scale + 1) * 127.5), 0, 255)] : [88, 99, 107];
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
  $('coordinates').textContent = coords(center) + ' · cell center';
  $('resolution').textContent = active.step + '° GRID';
  $('value-label').textContent = year + ' ANOMALY';
  setMetric($('value'), current, active.unit);
  setMetric($('slope'), estimate?.rate, active.unit + ' / decade');
  $('chart-period').textContent = active.years[0] + '–' + active.years.at(-1);
  $('chart').setAttribute('aria-label', 'Annual anomalies in ' + active.unit + ' for ' + coords(center) +
    ', from ' + active.years[0] + ' to ' + active.years.at(-1) + '. Data available as CSV.');
  $('csv').disabled = !series.some(Number.isFinite);
  if (estimate?.p != null) {
    $('inference').textContent = estimate.p < .05 ? 'SIGNIFICANT AT 5% · LOCAL TEST' : 'NOT SIGNIFICANT AT 5%';
    const p = estimate.p < .001 ? 'p < 0.001' : 'p = ' + estimate.p.toFixed(3);
    $('interval').textContent = '95% CI ' + signed(estimate.low, 3) + ' to ' + signed(estimate.high, 3) + ' ' +
      active.unit + '/decade. ' + p + ' · ' + (year - WINDOW + 1) + '–' + year + '.';
  } else {
    $('inference').textContent = 'TREND TEST UNAVAILABLE';
    $('interval').textContent = estimate
      ? 'The regression residuals are too small to estimate uncertainty.'
      : 'The trend needs 30 consecutive annual observations ending in ' + year + '.';
  }
  drawChart(series, idx, estimate);
}

function setMetric(element, value, unit) {
  element.textContent = Number.isFinite(value) ? signed(value) : '—';
  const small = document.createElement('small');
  small.textContent = unit;
  element.append(small);
}

function drawChart(series, idx, estimate) {
  const chart = $('chart');
  const g = chart.getContext('2d');
  const [w, h] = sizeCanvas(chart);
  g.clearRect(0, 0, w, h);
  const observed = series.filter(Number.isFinite);
  if (!observed.length) {
    g.font = '12px sans-serif'; g.fillStyle = '#55635a'; g.fillText('No observations for this grid cell', 5, h / 2);
    return;
  }
  const min = Math.min(0, ...observed), max = Math.max(0, ...observed);
  const left = 34, right = w - 6, top = 6, bottom = h - 20;
  const x = i => left + i / (series.length - 1) * (right - left);
  const y = value => bottom - (max === min ? .5 : (value - min) / (max - min)) * (bottom - top);
  if (estimate) {
    g.fillStyle = '#e1eadc';
    g.fillRect(x(idx - WINDOW + 1), top, x(idx) - x(idx - WINDOW + 1), bottom - top);
  }
  g.font = '9px monospace'; g.fillStyle = '#526258';
  for (const tick of [...new Set([min, 0, max])]) {
    const ty = y(tick);
    g.beginPath(); g.moveTo(left, ty); g.lineTo(right, ty);
    g.strokeStyle = tick === 0 ? '#a0aa9f' : '#dde1d5'; g.lineWidth = 1; g.stroke();
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
  g.strokeStyle = '#2d7655'; g.lineWidth = 1.35; g.stroke();
  if (estimate) {
    g.beginPath();
    g.moveTo(x(idx - WINDOW + 1), y(estimate.mean - estimate.slope * (WINDOW - 1) / 2));
    g.lineTo(x(idx), y(estimate.mean + estimate.slope * (WINDOW - 1) / 2));
    g.strokeStyle = '#a7462c'; g.lineWidth = 1.5; g.stroke();
  }
  g.beginPath(); g.moveTo(x(idx), top); g.lineTo(x(idx), bottom);
  g.strokeStyle = '#51675c'; g.lineWidth = 1; g.setLineDash([3, 3]); g.stroke(); g.setLineDash([]);
  if (Number.isFinite(series[idx])) {
    g.beginPath(); g.arc(x(idx), y(series[idx]), 3.5, 0, Math.PI * 2); g.fillStyle = '#24523e'; g.fill();
  }
}

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
function recenter() {
  zoom = 1;
  rotate(-point[0], -point[1]);
}
function locationAt(event) {
  if (!active || !projection || !mapBounds) return null;
  const rect = earth.getBoundingClientRect();
  const x = event.clientX - rect.left, y = event.clientY - rect.top;
  const [left, top, right, bottom] = mapBounds;
  if (x < left || x > right || y < top || y > bottom) return null;
  const [cx, cy] = projection.translate();
  if (view === 'globe' && Math.hypot(x - cx, y - cy) > projection.scale()) return null;
  const location = projection.invert([x, y]);
  return location?.every(Number.isFinite) ? {location, x, y} : null;
}

let hoverTimer;
earth.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  drag = {x: event.clientX, y: event.clientY, moved: false, rotation};
  earth.setPointerCapture(event.pointerId);
  $('tooltip').hidden = true;
});
earth.addEventListener('pointermove', event => {
  if (drag) {
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    if (drag.moved && view === 'globe') {
      earth.classList.add('dragging');
      rotate(drag.rotation[0] + dx * .42 / zoom, drag.rotation[1] - dy * .42 / zoom);
    }
    return;
  }
  clearTimeout(hoverTimer);
  const target = locationAt(event);
  $('tooltip').hidden = true;
  if (!target || event.pointerType !== 'mouse') return;
  hoverTimer = setTimeout(() => {
    if (!active || !grid || drag) return;
    const {index, center} = cell(target.location);
    const value = grid[index];
    const tooltip = $('tooltip');
    tooltip.textContent = coords(center) + '  |  ' + (Number.isFinite(value)
      ? signed(value) + ' ' + active.unit + (mode === 'trend' ? '/decade' : '') : 'No data');
    tooltip.hidden = false;
    tooltip.style.left = clamp(target.x + 10, 4, Math.max(4, width - tooltip.offsetWidth - 5)) + 'px';
    tooltip.style.top = clamp(target.y + 12, 4, height - tooltip.offsetHeight - 5) + 'px';
  }, 170);
});
earth.addEventListener('pointerup', event => {
  if (drag && !drag.moved) {
    const target = locationAt(event);
    if (target) {
      point = target.location; placeKey = 'custom'; $('place').value = placeKey;
      updateInspector(); queueDraw();
    }
  }
  drag = null; earth.classList.remove('dragging');
});
earth.addEventListener('lostpointercapture', () => { drag = null; earth.classList.remove('dragging'); });
earth.addEventListener('pointerleave', () => { clearTimeout(hoverTimer); $('tooltip').hidden = true; });
earth.addEventListener('wheel', event => {
  if (view !== 'globe' || document.activeElement !== earth) return;
  event.preventDefault();
  zoom = clamp(zoom * Math.exp(-event.deltaY * .001), 1, 2.6);
  rasterMap = null; queueDraw();
}, {passive: false});
earth.addEventListener('keydown', event => {
  if (view !== 'globe') return;
  const directions = {ArrowLeft: [-8,0], ArrowRight: [8,0], ArrowUp: [0,8], ArrowDown: [0,-8]};
  const direction = directions[event.key];
  if (direction) {
    event.preventDefault(); rotate(rotation[0] + direction[0], rotation[1] + direction[1]);
  } else if (event.key === 'Enter') {
    point = [-rotation[0], -rotation[1]]; placeKey = 'custom'; $('place').value = placeKey;
    updateInspector(); queueDraw();
  }
});

function changeView(next) {
  view = next;
  for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', button.dataset.view === view);
  earth.classList.toggle('grab', view === 'globe');
  earth.setAttribute('aria-label', view === 'globe'
    ? 'Climate globe. Use arrow keys to rotate and Enter to select the center cell. Click a cell to select it.'
    : 'Flat climate map. Click a cell to select it, or use the location menu.');
  $('recenter').hidden = view === 'map';
  $('map-hint').textContent = view === 'globe' ? 'Drag to rotate · Click to inspect' : 'Click a cell to inspect';
  rasterMap = null;
  queueDraw();
}

$('place').addEventListener('change', event => {
  placeKey = event.target.value;
  point = places[placeKey].slice(1);
  recenter(); updateInspector();
});
$('mode').addEventListener('change', event => {
  stop(); mode = event.target.value;
  if (active) setYear(year);
});
$('year').addEventListener('input', event => { stop(); setYear(Number(event.target.value)); });
$('play').addEventListener('click', play);
$('previous').addEventListener('click', () => { stop(); setYear(year - 1); });
$('next').addEventListener('click', () => { stop(); setYear(year + 1); });
$('recenter').addEventListener('click', recenter);
$('open-method').addEventListener('click', () => $('methods').showModal());
$('csv').addEventListener('click', () => {
  if (!active) return;
  const {index, center} = cell(point);
  const series = history(index);
  const rows = ['year,anomaly,unit,latitude,longitude,baseline,product',
    ...active.years.map((y, i) => [y, Number.isFinite(series[i]) ? series[i].toFixed(5) : '',
      active.unit, center[1], center[0], active.reference, active.product].join(','))];
  const url = URL.createObjectURL(new Blob([rows.join('\n') + '\n'], {type: 'text/csv;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url; link.download = layer + '-' + center[1] + '-' + center[0] + '.csv';
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => changeView(button.dataset.view));
for (const button of document.querySelectorAll('[data-layer]')) button.addEventListener('click', () => {
  if (catalog) selectLayer(button.dataset.layer);
});
new ResizeObserver(queueDraw).observe(earth);
new ResizeObserver(() => { if (active) updateInspector(); }).observe($('chart'));

try {
  [catalog, land, borders] = await Promise.all(['catalog.json', 'land.json', 'countries.json'].map(async file => (await fetchAsset(file)).json()));
  d3 = window.d3;
  globe = d3.geoOrthographic().clipAngle(90);
  land = window.topojson.feature(land, land.objects.land);
  borders = window.topojson.mesh(borders, borders.objects.countries, (a, b) => a !== b);
  changeView(view);
  await selectLayer(layer);
} catch (error) {
  $('map-status').textContent = 'The atlas could not initialize. Reload to retry.';
  console.error(error);
}
