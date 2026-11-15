// Impacts page: how far average range shifts add up over time.
// Speeds: ocean 59 km/decade (IPCC AR6 WGII FAQ 2); land 16.9 km/decade and
// 11 m/decade uphill (Chen et al. 2011, Science).
const TRACKS = [
  {label: 'Sea life', note: 'toward the poles', rate: 59, unit: 'km', cls: 'sea'},
  {label: 'Land species', note: 'toward the poles', rate: 16.9, unit: 'km', cls: 'land'},
  {label: 'Mountain species', note: 'uphill', rate: 11, unit: 'm', cls: 'hill'},
];
const NS = 'http://www.w3.org/2000/svg';
const svg = document.getElementById('range-chart');
const slider = document.getElementById('range-years');
const W = 720, rowH = 62, left = 150, right = W - 60, top = 30, H = top + rowH * TRACKS.length + 6;
const MAX = {km: 500, m: 100};
const el = (name, attrs, text) => {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text != null) node.textContent = text;
  svg.append(node);
  return node;
};
svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
const x = (value, unit) => left + Math.min(1, value / MAX[unit]) * (right - left);
const rows = TRACKS.map((track, i) => {
  const y = top + rowH * i + 24;
  el('text', {class: 'name', x: 0, y: y - 2}, track.label);
  el('text', {x: 0, y: y + 14}, track.note);
  el('line', {class: 'rail', x1: left, x2: right, y1: y, y2: y});
  for (let k = 0; k <= 5; k++) {
    const value = MAX[track.unit] * k / 5, px = x(value, track.unit);
    el('line', {class: 'tick', x1: px, x2: px, y1: y - 4, y2: y + 4});
    el('text', {x: px, y: y + 20, 'text-anchor': 'middle'}, k === 0 ? 'today' : value + ' ' + track.unit);
  }
  return {track, y, bar: el('line', {class: 'bar ' + track.cls, x1: left, x2: left, y1: y, y2: y}),
    dot: el('circle', {class: 'dot ' + track.cls, cx: left, cy: y, r: 8}),
    value: el('text', {class: 'value', x: left, y: y - 14, 'text-anchor': 'middle'})};
});

function draw() {
  const years = Number(slider.value);
  const parts = rows.map(({track, bar, dot, value}) => {
    const moved = track.rate * years / 10, px = x(moved, track.unit);
    bar.setAttribute('x2', px); dot.setAttribute('cx', px); value.setAttribute('x', Math.max(left + 14, px));
    const text = Math.round(moved) + ' ' + track.unit;
    value.textContent = years ? text : '';
    return track.label.toLowerCase() + ' about ' + text + ' ' + track.note;
  });
  document.getElementById('range-readout').textContent = years ? 'In ' + years + ' years' : 'Today';
  document.getElementById('range-summary').textContent = years
    ? 'After ' + years + ' years at today’s average speeds: ' + parts.join(', ') + '.'
    : 'Move the slider to see how far ranges shift.';
}
slider.addEventListener('input', draw);
draw();
