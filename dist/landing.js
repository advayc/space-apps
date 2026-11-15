// Landing page: the global temperature record in the hero, and the hero search.
import { forecast } from './statistics.js';
import { HORIZON } from './timeline.js';
import { FIRST_YEAR, GLOBAL } from './global-record.js';

// The pale midpoint of the map ramp disappears on a light page, so light mode uses a deeper one.
const RAMPS = {
  dark: ['#3267a5', '#80b8ce', '#eeeacb', '#e28b53', '#af3a2d'],
  light: ['#2f62a0', '#6fa9c4', '#bdb894', '#dd8046', '#ab3527'],
};
let RAMP = RAMPS.dark;
const SVG = 'http://www.w3.org/2000/svg';
const $ = id => document.getElementById(id);
const signed = value => (value < 0 ? '−' : '+') + Math.abs(value).toFixed(2);
let recordReady = false;

function ramp(fraction) {
  const t = Math.min(1, Math.max(0, fraction)) * (RAMP.length - 1);
  const channel = (hex, i) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
  const a = RAMP[Math.floor(t)], b = RAMP[Math.ceil(t)];
  return 'rgb(' + [0, 1, 2].map(i => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * (t % 1))).join(',') + ')';
}

function drawRecord() {
  RAMP = RAMPS[document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'];
  const svg = $('record-bars');
  const lastYear = FIRST_YEAR + GLOBAL.length - 1;
  const future = forecast(GLOBAL, GLOBAL.length - 1, HORIZON - lastYear, lastYear + 1) ?? [];
  const bars = [...GLOBAL.map(value => ({value})),
    ...future.map(f => ({value: f.sim, central: f.value, low: f.low, high: f.high, projected: true}))];
  const max = Math.max(...bars.map(bar => bar.high ?? bar.value)), min = Math.min(...bars.map(bar => bar.low ?? bar.value));
  const H = 100, zero = max / (max - min) * H, unit = H / (max - min);
  const range = max - min;
  const step = range > 4 ? 1 : range > 2 ? 0.5 : 0.2;
  const ticks = [];
  for (let value = Math.ceil((min - 1e-9) / step) * step; value <= max + 1e-9; value += step) ticks.push(value);
  $('record-y').replaceChildren(...ticks.map(value => {
    const tick = document.createElement('span');
    const fraction = (max - value) / range;
    const number = Math.abs(value) < 5e-7 ? '0' : (value < 0 ? '−' : '+') + Math.abs(value).toFixed(step >= 1 ? 0 : 1);
    tick.textContent = number + ' °C';
    tick.style.top = fraction * 100 + '%';
    if (fraction < 0.04) tick.className = 'is-edge-top';
    else if (fraction > 0.96) tick.className = 'is-edge-bottom';
    return tick;
  }));
  svg.setAttribute('viewBox', '0 0 ' + bars.length + ' ' + H);
  const readout = $('record-readout');
  const describe = (bar, i) => bar.projected
    ? (FIRST_YEAR + i) + ' projected ' + signed(bar.central) + ' °C, range ' + signed(bar.low) + ' to ' + signed(bar.high)
    : (FIRST_YEAR + i) + ' ' + signed(bar.value) + ' °C';
  const rest = describe(bars[GLOBAL.length - 1], GLOBAL.length - 1);
  readout.textContent = rest;
  const rects = bars.map((bar, i) => {
    const rect = document.createElementNS(SVG, 'rect');
    const height = Math.max(.8, Math.abs(bar.value) * unit);
    rect.setAttribute('x', i + .12);
    rect.setAttribute('width', .76);
    rect.setAttribute('y', bar.value >= 0 ? zero - height : zero);
    rect.setAttribute('height', height);
    if (bar.value < 0) rect.style.transformOrigin = '50% 0';
    if (bar.projected) rect.setAttribute('class', 'bar-proj');
    else rect.setAttribute('fill', ramp((bar.value / 1.1 + 1) / 2));
    if (!recordReady) rect.style.setProperty('--i', i); else rect.style.animation = 'none';
    return rect;
  });
  // A thin whisker on each projected bar spans its 95% range.
  const whiskers = bars.flatMap((bar, i) => {
    if (!bar.projected) return [];
    const rect = document.createElementNS(SVG, 'rect');
    rect.setAttribute('class', 'bar-range');
    rect.setAttribute('x', i + .42); rect.setAttribute('width', .16);
    rect.setAttribute('y', zero - bar.high * unit); rect.setAttribute('height', (bar.high - bar.low) * unit);
    return [rect];
  });
  const zeroLine = document.createElementNS(SVG, 'line');
  zeroLine.setAttribute('class', 'bar-zero');
  zeroLine.setAttribute('x1', 0); zeroLine.setAttribute('x2', bars.length);
  zeroLine.setAttribute('y1', zero); zeroLine.setAttribute('y2', zero);
  svg.replaceChildren(...rects, ...whiskers, zeroLine);
  if (!svg.classList.contains('ranges-in')) {
    const reveal = () => svg.classList.add('ranges-in');
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (motion) reveal();
    else {
      rects.at(-1).addEventListener('animationend', reveal, {once: true});
      setTimeout(reveal, 2400);
    }
  }
  const span = bars.length;
  $('record-axis').replaceChildren(...[FIRST_YEAR, 1920, 1960, 2000, lastYear, 2050, 2075, HORIZON].map(year => {
    const tick = document.createElement('span');
    tick.textContent = year;
    tick.dataset.year = year;
    tick.style.left = (year - FIRST_YEAR + .5) / span * 100 + '%';
    if (year > lastYear) tick.className = 'is-projected';
    return tick;
  }));
  if (recordReady) return;
  recordReady = true;
  svg.addEventListener('pointermove', event => {
    const box = svg.getBoundingClientRect();
    const i = Math.min(bars.length - 1, Math.max(0, Math.floor((event.clientX - box.left) / box.width * bars.length)));
    readout.textContent = describe(bars[i], i);
    readout.classList.toggle('is-projected', Boolean(bars[i].projected));
    svg.querySelector('.hot')?.classList.remove('hot');
    svg.children[i].classList.add('hot');
  });
  svg.addEventListener('pointerleave', () => {
    readout.textContent = rest;
    readout.classList.remove('is-projected');
    svg.querySelector('.hot')?.classList.remove('hot');
  });
}

drawRecord();
document.addEventListener('atlas-theme-change', drawRecord);
