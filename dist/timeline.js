import { WINDOW } from './statistics.js';

export const months = new Map([
  ['01', 'January'], ['02', 'February'], ['03', 'March'], ['04', 'April'],
  ['05', 'May'], ['06', 'June'], ['07', 'July'], ['08', 'August'],
  ['09', 'September'], ['10', 'October'], ['11', 'November'], ['12', 'December'],
]);
export const seasons = new Map([
  ['djf', 'Dec–Feb'], ['mam', 'Mar–May'], ['jja', 'Jun–Aug'], ['son', 'Sep–Nov'],
]);

export function dateLabel(year, period) {
  const prefix = months.get(period)?.slice(0, 3) ?? seasons.get(period);
  return prefix ? prefix + ' ' + year : String(year);
}

// The timeline continues past the last observation up to this year with
// projected entries (flagged `projected`), except in the 30-year trend view.
export const HORIZON = 2050;

export function futureYears(years) {
  const last = years.at(-1);
  if (years.length < WINDOW) return [];
  return Array.from({length: Math.max(0, HORIZON - last)}, (_, i) => last + 1 + i);
}

export function makeTimeline(dataset, mode) {
  const periods = mode === 'monthly' ? months : mode === 'seasonal' ? seasons : null;
  if (!periods) {
    if (mode === 'trend') return dataset.years.slice(WINDOW - 1).map(year => ({ year, period: 'annual', order: year }));
    return [
      ...dataset.years.map(year => ({ year, period: 'annual', order: year })),
      ...futureYears(dataset.years).map(year => ({ year, period: 'annual', order: year, projected: true })),
    ];
  }
  return [...periods.keys()].flatMap((period, index) => {
    const years = dataset.periods[period].years;
    const entry = (year, projected) => ({ year, period, order: year * periods.size + index, projected });
    return [...years.map(year => entry(year, false)), ...futureYears(years).map(year => entry(year, true))];
  }).sort((a, b) => a.order - b.order);
}

export function nearestIndex(timeline, mode, year, period) {
  const periods = mode === 'monthly' ? months : mode === 'seasonal' ? seasons : null;
  const order = periods ? year * periods.size + [...periods.keys()].indexOf(period) : year;
  let best = 0;
  for (let i = 1; i < timeline.length; i++) {
    if (Math.abs(timeline[i].order - order) >= Math.abs(timeline[best].order - order)) break;
    best = i;
  }
  return best;
}
