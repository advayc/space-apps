// NASA Giovanni point-series downloads are authenticated by Earthdata; CSVs stay in this browser.
const $ = id => document.getElementById(id);
let location = null, imported = null;
const endpoint = 'https://api.giovanni.earthdata.nasa.gov/proxy-timeseries';

function refreshLink() {
  const a = $('hydrology-download'), start = $('hydrology-start').value, end = $('hydrology-end').value;
  const valid = location && start && end && start >= '2000-01-01' && start <= end;
  if (!valid) {
    a.removeAttribute('href'); a.setAttribute('aria-disabled', 'true');
    $('hydrology-status').textContent = location ? 'Choose a valid date range starting in 2000 or later.' : 'Select a place on the map first.';
    return;
  }
  const url = new URL(endpoint);
  url.searchParams.set('data', $('hydrology-variable').value);
  url.searchParams.set('location', `[${location.lat.toFixed(4)},${location.lon.toFixed(4)}]`);
  url.searchParams.set('time', `${start}T00:00:00/${end}T23:59:59`);
  url.searchParams.set('version', '2.0');
  a.href = url.href; a.removeAttribute('aria-disabled');
  $('hydrology-status').textContent = 'NASA may ask you to sign in with Earthdata Login. GLDAS covers land; ocean locations have no data.';
}

export function updateHydrologyPlace(point, name) {
  location = {lon: point[0], lat: point[1], name};
  $('hydrology-location').textContent = `Selected place: ${name} · ${point[1].toFixed(2)}°, ${point[0].toFixed(2)}° (latitude, longitude)`;
  refreshLink();
}

// Giovanni CSV includes metadata rows before a Timestamp (UTC),Data header.
function csvRow(line) {
  const fields = []; let field = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && quoted && line[i + 1] === '"') { field += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { fields.push(field.trim()); field = ''; }
    else field += ch;
  }
  fields.push(field.trim()); return fields;
}
export function parseHydrologyCSV(text) {
  const metadata = {}, points = [];
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = csvRow(line), key = fields[0]?.trim();
    if (!key) continue;
    if (/^\d{4}-\d{2}-\d{2}(?:[ T]|$)/.test(key)) {
      const time = Date.parse(key.replace(' ', 'T') + (/Z$|[+-]\d\d:?\d\d$/.test(key) ? '' : 'Z'));
      const value = fields[1] === '' ? NaN : Number(fields[1]);
      const missing = Number(metadata.undef);
      if (Number.isFinite(time) && Number.isFinite(value) && (!Number.isFinite(missing) || value !== missing)) points.push({time, value});
    } else if (fields.length > 1) {
      metadata[key.toLowerCase()] = fields.slice(1).join(', ').trim();
    }
  }
  points.sort((a, b) => a.time - b.time);
  if (!points.length) throw new Error('No valid timestamp and data rows found. Choose a NASA time-series CSV containing data.');
  return {metadata, points};
}

function draw() {
  if (!imported) return;
  const canvas = $('hydrology-chart'), rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
  const g = canvas.getContext('2d'); g.scale(dpr, dpr);
  const w = rect.width, h = rect.height, left = 57, right = w - 14, top = 16, bottom = h - 34;
  const points = imported.points, t0 = points[0].time, t1 = points.at(-1).time;
  let lo = Infinity, hi = -Infinity;
  for (const p of points) { lo = Math.min(lo, p.value); hi = Math.max(hi, p.value); }
  const margin = (hi - lo || Math.abs(hi) || 1) * .08; lo -= margin; hi += margin;
  const x = t => left + (t - t0) / (t1 - t0 || 1) * (right - left);
  const y = v => bottom - (v - lo) / (hi - lo) * (bottom - top);
  const style = getComputedStyle(document.documentElement);
  g.font = '11px system-ui, sans-serif'; g.fillStyle = style.getPropertyValue('--muted').trim();
  g.strokeStyle = style.getPropertyValue('--line').trim(); g.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const value = lo + (hi - lo) * i / 4, py = y(value);
    g.beginPath(); g.moveTo(left, py); g.lineTo(right, py); g.stroke();
    g.fillText(Number(value.toPrecision(3)).toString(), left - 7, py + 4);
  }
  g.textAlign = 'left'; g.fillText(new Date(t0).toISOString().slice(0, 10), left, h - 10);
  g.textAlign = 'right'; g.fillText(new Date(t1).toISOString().slice(0, 10), right, h - 10);
  g.strokeStyle = style.getPropertyValue('--accent').trim(); g.lineWidth = 1.5;
  g.beginPath(); points.forEach((p, i) => { if (!i) g.moveTo(x(p.time), y(p.value)); else g.lineTo(x(p.time), y(p.value)); }); g.stroke();
  if (points.length === 1) { g.beginPath(); g.arc(x(t0), y(points[0].value), 3, 0, Math.PI * 2); g.fillStyle = g.strokeStyle; g.fill(); }
}

export function initHydrology() {
  for (const id of ['hydrology-variable', 'hydrology-start', 'hydrology-end']) $(id).addEventListener('change', refreshLink);
  $('hydrology-file').addEventListener('change', async event => {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('This file is too large. Download a smaller date range (maximum 10 MB).');
      const result = parseHydrologyCSV(await file.text());
      imported = result;
      const m = result.metadata;
      $('hydrology-chart-title').textContent = m.param_name || m.param_short_name || 'Imported time series';
      const locationText = m.lat && m.lon ? ` · ${m.lat}°, ${m.lon}° (latitude, longitude)` : '';
      $('hydrology-meta').textContent = `${m.prod_name || 'Imported CSV'}${m.unit ? ' · ' + m.unit : ''}${locationText} · ${result.points.length.toLocaleString()} values`;
      $('hydrology-chart').setAttribute('aria-label', `${$('hydrology-chart-title').textContent}, ${result.points.length} values${m.unit ? ', ' + m.unit : ''}`);
      $('hydrology-chart-wrap').hidden = false; $('hydrology-clear').hidden = false;
      $('hydrology-status').textContent = 'CSV opened locally. Its location and variable are shown above the chart.';
      draw();
    } catch (error) { $('hydrology-status').textContent = error.message; }
    event.target.value = '';
  });
  $('hydrology-clear').addEventListener('click', () => {
    imported = null; $('hydrology-chart-wrap').hidden = true; $('hydrology-clear').hidden = true; refreshLink();
  });
  new ResizeObserver(draw).observe($('hydrology-chart'));
  document.addEventListener('atlas-theme-change', draw);
  refreshLink();
}
