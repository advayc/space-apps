// Projections page: the global record, its 30-year regression line, and the projection.
import { forecast, WINDOW } from '../statistics.js';
import { HORIZON } from '../timeline.js';
import { FIRST_YEAR, GLOBAL } from '../global-record.js';

const svg = document.getElementById('proj-chart');
const readout = document.getElementById('proj-readout');
const NS = 'http://www.w3.org/2000/svg';
const W = 720, H = 340, left = 44, right = W - 12, top = 14, bottom = H - 28;
const lastYear = FIRST_YEAR + GLOBAL.length - 1;
const future = forecast(GLOBAL, GLOBAL.length - 1, HORIZON - lastYear, lastYear + 1) ?? [];

// Ordinary least squares through the last WINDOW years.
const start = GLOBAL.length - WINDOW;
let sx = 0, sy = 0, sxx = 0, sxy = 0;
for (let i = start; i < GLOBAL.length; i++) { sx += i; sy += GLOBAL[i]; sxx += i * i; sxy += i * GLOBAL[i]; }
const slope = (WINDOW * sxy - sx * sy) / (WINDOW * sxx - sx * sx);
const intercept = (sy - slope * sx) / WINDOW;
const line = i => intercept + slope * i;

const total = GLOBAL.length + future.length;
const max = Math.ceil(Math.max(...GLOBAL, ...future.map(f => f.high)) * 2) / 2;
const min = Math.floor(Math.min(...GLOBAL, ...future.map(f => f.low)) * 2) / 2;
const x = i => left + i / (total - 1) * (right - left);
const y = v => bottom - (v - min) / (max - min) * (bottom - top);
const el = (name, attrs, text) => {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text != null) node.textContent = text;
  svg.append(node);
  return node;
};
const path = points => points.map(([px, py], i) => (i ? 'L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1)).join('');
const signed = v => (v < 0 ? '−' : '+') + Math.abs(v).toFixed(2);

svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
for (let v = Math.ceil(min); v <= max + 1e-9; v += 1) {
  el('line', {class: 'grid' + (Math.abs(v) < 1e-9 ? ' zero' : ''), x1: left, x2: right, y1: y(v), y2: y(v)});
  el('text', {x: left - 6, y: y(v) + 4, 'text-anchor': 'end'}, signed(v).replace('+0.00', '0').replace('.00', '').replace(/(\.\d)0$/, '$1'));
}
for (const year of [1880, 1920, 1960, 2000, lastYear, 2060, HORIZON]) {
  el('text', {x: x(year - FIRST_YEAR), y: H - 8, 'text-anchor': year === 1880 ? 'start' : year === HORIZON ? 'end' : 'middle'}, year);
}
el('rect', {class: 'window', x: x(start), y: top, width: x(GLOBAL.length - 1) - x(start), height: bottom - top});
el('path', {class: 'band', d: path(future.map((f, k) => [x(GLOBAL.length + k), y(f.high)])
  .concat(future.map((f, k) => [x(GLOBAL.length + k), y(f.low)]).reverse())) + 'Z'});
el('path', {class: 'obs', d: path(GLOBAL.map((v, i) => [x(i), y(v)]))});
el('path', {class: 'fit', d: path([[x(start), y(line(start))], [x(GLOBAL.length - 1), y(line(GLOBAL.length - 1))]])});
el('path', {class: 'proj', d: path([[x(GLOBAL.length - 1), y(line(GLOBAL.length - 1))]]
  .concat(future.map((f, k) => [x(GLOBAL.length + k), y(f.value)])))});
el('text', {class: 'note', x: x(start) - 6, y: top + 12, 'text-anchor': 'end'}, 'last 30 years →');
const cursor = el('line', {class: 'cursor', y1: top, y2: bottom, visibility: 'hidden'});

const describe = i => {
  const year = FIRST_YEAR + i;
  if (i < GLOBAL.length) return year + ' · measured ' + signed(GLOBAL[i]) + ' °C';
  const f = future[i - GLOBAL.length];
  return year + ' · projected ' + signed(f.value) + ' °C, range ' + signed(f.low) + ' to ' + signed(f.high);
};
const rest = 'Trend ' + signed(slope * 10) + ' °C per decade · ' + describe(total - 1);
readout.textContent = rest;
svg.addEventListener('pointermove', event => {
  const box = svg.getBoundingClientRect();
  const px = (event.clientX - box.left) / box.width * W;
  const i = Math.round(Math.min(1, Math.max(0, (px - left) / (right - left))) * (total - 1));
  cursor.setAttribute('x1', x(i)); cursor.setAttribute('x2', x(i)); cursor.setAttribute('visibility', 'visible');
  readout.textContent = describe(i);
});
svg.addEventListener('pointerleave', () => { cursor.setAttribute('visibility', 'hidden'); readout.textContent = rest; });

const end = future.at(-1);
if (end) document.getElementById('proj-global-range').textContent = '±' + ((end.high - end.low) / 2).toFixed(1);
