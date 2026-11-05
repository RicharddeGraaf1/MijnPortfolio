// Lijngrafiek van waarde tegenover betaald bedrag. Kleuren komen uit de CSS, zodat de
// grafiek meekleurt met de portefeuille. Teksten gaan via textContent: namen zijn gebruikersinvoer.
const SVG = 'http://www.w3.org/2000/svg';

const svg = (name, attributes = {}, text) => {
  const element = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  if (text != null) element.textContent = text;
  return element;
};

function niceTicks(min, max, count = 4) {
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const rough = (max - min) / (count - 1);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= rough);
  const first = Math.floor(min / step) * step;
  const ticks = [];
  for (let tick = first; tick < max + step; tick += step) ticks.push(tick);
  return ticks;
}

// Eén notatie per as: alles in duizendtallen zodra de as 10.000 haalt, en nooit afronden op de streep.
function axisFormatter(ticks) {
  const largest = Math.max(...ticks.map(Math.abs));
  if (largest >= 1e6) return (value) => value === 0 ? '0' : `${(value / 1e6).toLocaleString('nl-NL', { maximumFractionDigits: 2 })} mln`;
  if (largest >= 1e4) return (value) => value === 0 ? '0' : `${(value / 1e3).toLocaleString('nl-NL', { maximumFractionDigits: 1 })}k`;
  return (value) => value.toLocaleString('nl-NL', { maximumFractionDigits: 2 });
}

const linePath = (points, x, y, key) =>
  points.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(1)} ${y(p[key]).toFixed(1)}`).join('');

// `onSelect(punt)` krijgt het gekozen punt, of het laatste punt zodra je loslaat.
export function renderChart(container, series, { formatDate, describe, onSelect }) {
  container.replaceChildren();
  const width = container.clientWidth || 340;
  const height = 176;
  const margin = { top: 10, right: 8, bottom: 24, left: 46 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  const values = series.flatMap((point) => [point.value, point.cost]);
  const ticks = niceTicks(Math.min(...values), Math.max(...values));
  const yMin = ticks[0];
  const yMax = ticks.at(-1);
  const formatTick = axisFormatter(ticks);
  const firstDay = series[0].day;
  const lastDay = series.at(-1).day;

  const x = (day) => margin.left + ((day - firstDay) / (lastDay - firstDay || 1)) * plotWidth;
  const y = (value) => margin.top + (1 - (value - yMin) / (yMax - yMin)) * plotHeight;

  const root = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    class: 'chart',
    role: 'img',
    tabindex: '0',
    'aria-label': describe,
  });

  for (const tick of ticks) {
    root.append(
      svg('line', { x1: margin.left, x2: width - margin.right, y1: y(tick), y2: y(tick), class: 'chart-grid' }),
      svg('text', { x: margin.left - 6, y: y(tick) + 4, 'text-anchor': 'end', class: 'chart-axis' }, formatTick(tick)),
    );
  }

  const labelCount = 3;
  for (let i = 0; i < labelCount; i += 1) {
    const day = firstDay + ((lastDay - firstDay) * i) / (labelCount - 1);
    const anchor = i === 0 ? 'start' : i === labelCount - 1 ? 'end' : 'middle';
    root.append(svg('text', { x: x(day), y: height - 6, 'text-anchor': anchor, class: 'chart-axis' }, formatDate(Math.round(day))));
  }

  root.append(
    svg('path', { d: linePath(series, x, y, 'cost'), class: 'chart-line chart-cost' }),
    svg('path', { d: linePath(series, x, y, 'value'), class: 'chart-line chart-value' }),
  );

  const crosshair = svg('line', { y1: margin.top, y2: margin.top + plotHeight, class: 'chart-crosshair', visibility: 'hidden' });
  const dot = svg('circle', { r: 4, class: 'chart-dot' });
  root.append(crosshair, dot);

  let selected = series.length - 1;
  const select = (index, active) => {
    selected = Math.max(0, Math.min(series.length - 1, index));
    const point = series[selected];
    dot.setAttribute('cx', x(point.day));
    dot.setAttribute('cy', y(point.value));
    crosshair.setAttribute('x1', x(point.day));
    crosshair.setAttribute('x2', x(point.day));
    crosshair.setAttribute('visibility', active ? 'visible' : 'hidden');
    onSelect(point, active);
  };

  const nearest = (event) => {
    const box = root.getBoundingClientRect();
    const day = firstDay + ((event.clientX - box.left - margin.left) / plotWidth) * (lastDay - firstDay);
    let best = 0;
    series.forEach((point, index) => {
      if (Math.abs(point.day - day) < Math.abs(series[best].day - day)) best = index;
    });
    return best;
  };

  root.addEventListener('pointerdown', (event) => select(nearest(event), true));
  root.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'mouse' || event.buttons) select(nearest(event), true);
  });
  const release = () => select(series.length - 1, false);
  root.addEventListener('pointerup', (event) => {
    if (event.pointerType !== 'mouse') release();
  });
  root.addEventListener('pointerleave', release);
  root.addEventListener('pointercancel', release);
  root.addEventListener('blur', release);
  root.addEventListener('keydown', (event) => {
    const moves = { ArrowLeft: -1, ArrowRight: 1 };
    if (event.key in moves) {
      event.preventDefault();
      select(selected + moves[event.key], true);
    }
  });

  container.append(root);
  select(series.length - 1, false);
}
