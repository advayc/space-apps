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

export function makeTimeline(dataset, mode) {
  const periods = mode === 'monthly' ? months : mode === 'seasonal' ? seasons : null;
  if (!periods) {
    const years = mode === 'trend' ? dataset.years.slice(WINDOW - 1) : dataset.years;
    return years.map(year => ({ year, period: 'annual', order: year }));
  }
  return [...periods.keys()].flatMap((period, index) =>
    dataset.periods[period].years.map(year => ({ year, period, order: year * periods.size + index }))
  ).sort((a, b) => a.order - b.order);
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
