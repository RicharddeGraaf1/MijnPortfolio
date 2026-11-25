import { renderChart, renderStack } from './chart.js';
import {
  breakdownSeries, chartPeriod, fromDay, fxSymbol, ledger, monthlyRows, parseNumber, periodChange, summarize, todayIso,
  totals, unitSeries, valueSeries,
} from './core.js';
import { lastFetchedAt, peekQuote, quotes, refreshQuotes, searchSymbols } from './quotes.js';
import {
  backupStatus, deletePosition, exportBackup, findPosition, importBackup, isOnPc, markBackupMade, newId, positions,
  pullFromPc, pushToPc, savePosition,
} from './store.js';

const PORTFOLIOS = { prive: 'Privé', zakelijk: 'Zakelijk' };
const TABS = { alles: 'Alles', ...PORTFOLIOS };
const RANGES = ['1D', '1W', '1M', '6M', '1J', 'Altijd'];
const VIEWS = { rekening: 'Rekeningen', belegging: 'Beleggingen', totaal: 'Positie', stuk: 'Per aandeel' };
// Het palet heeft acht kleuren; meer groepen komen samen in Overig, want een negende kleur is niet te onderscheiden.
const SERIES_SLOTS = 8;
const OTHER_TONE = 'series-other';

// filter: null, 'rekening:<naam>' of 'belegging:<ticker of id>'; werkt binnen de gekozen tab.
// view: hoe de grafiek de waarde verdeelt; unit: 'eur' of 'pct' bij een verdeling; otherOpen: grijze groep uitgeklapt.
// positionView: op het positiescherm de hele positie ('totaal') of per aandeel ('stuk').
// zoom: de y-as volgt de waarde in plaats van bij 0 te beginnen; dit apparaat onthoudt die keuze.
const ZOOM_KEY = 'mijnportfolio.zoom';
const state = {
  tab: 'alles', range: 'Altijd', filter: null, view: 'rekening', unit: 'eur', otherOpen: false, positionView: 'totaal',
  zoom: readZoom(), refreshing: false, refreshFailed: false,
};

function readZoom() {
  try {
    return localStorage.getItem(ZOOM_KEY) === '1';
  } catch {
    return false;
  }
}
const app = document.getElementById('app');

// ---------- Opmaak ----------

const euroFull = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
const euroRound = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const eur = (value) => euroFull.format(value);
const eurHero = (value) => (Math.abs(value) >= 1000 ? euroRound : euroFull).format(value);

const sign = (value) => (value < -0.004 ? '−' : '+');
const signedEur = (value) => `${sign(value)}${eur(Math.abs(value))}`;
const signedEurHero = (value) => `${sign(value)}${eurHero(Math.abs(value))}`;
const signedPct = (ratio) =>
  ratio == null
    ? ''
    : `${sign(ratio)}${Math.abs(ratio * 100).toLocaleString('nl-NL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
const share = (ratio) => `${(ratio * 100).toLocaleString('nl-NL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
const quantity = (value) => value.toLocaleString('nl-NL', { maximumFractionDigits: 6 });
const pieces = (value) => `${quantity(value)} ${value === 1 ? 'stuk' : 'stuks'}`;
const direction = (value) => (Math.abs(value) < 0.005 ? 'flat' : value > 0 ? 'up' : 'down');

const date = (iso, options = { day: 'numeric', month: 'short', year: 'numeric' }) =>
  new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('nl-NL', options);

function fetchedLabel(iso) {
  const moment = new Date(iso);
  const time = moment.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  return todayIso(moment) === todayIso() ? `vandaag ${time}` : `${date(todayIso(moment))} ${time}`;
}

// ---------- DOM-helpers ----------

// Maakt een element; kinderen worden tekstknopen, dus gebruikersinvoer kan nooit als HTML draaien.
function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
    else if (key === 'class') element.className = value;
    else if (key === 'value') element.value = value;
    else element.setAttribute(key, value === true ? '' : value);
  }
  element.append(...children.flat(Infinity).filter((child) => child != null && child !== false));
  return element;
}

function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
}

const numberInput = (name, value, required = true) =>
  h('input', { name, type: 'text', inputmode: 'decimal', autocomplete: 'off', required, value: value ?? '' });

const dateInput = (value) => h('input', { name: 'date', type: 'date', required: true, max: todayIso(), value });

const numberText = (value) => (value == null ? '' : String(value).replace('.', ','));

function fitFigure(element) {
  let size = 56;
  element.style.fontSize = `${size}px`;
  while (element.scrollWidth > element.clientWidth && size > 28) {
    size -= 2;
    element.style.fontSize = `${size}px`;
  }
}

// ---------- Gegevens ----------

const withSummary = (position) => ({ position, summary: summarize(position, quotes()) });

function chartPositions(items) {
  return items.map(({ position, summary }) => ({ txs: position.txs, points: summary.points }));
}

// Hetzelfde fonds op twee rekeningen telt in het filter als één belegging.
const securityKey = (position) => position.symbol ?? `id-${position.id}`;

// Korte naam voor de legenda: wat je zelf invulde, anders de ticker zonder beurs (AMD, VUSA). Een ticker
// die geen woord is (fondscodes als 0P0000ABCD) zegt niets, dan blijft de volledige naam staan.
function shortName(position) {
  if (position.shortName) return position.shortName;
  const ticker = position.symbol?.split('.')[0];
  return ticker && /^[A-Z][A-Z0-9-]{0,5}$/.test(ticker) ? ticker : position.name;
}

function applyFilter(items) {
  if (!state.filter) return items;
  const [kind, value] = [state.filter.slice(0, state.filter.indexOf(':')), state.filter.slice(state.filter.indexOf(':') + 1)];
  return items.filter(({ position }) =>
    (kind === 'rekening' ? position.account === value : securityKey(position) === value));
}

const accountNames = (items) => [...new Set(items.map(({ position }) => position.account).filter(Boolean))]
  .sort((a, b) => a.localeCompare(b, 'nl'));

// Beleggingen samengevoegd over rekeningen, grootste waarde eerst.
function bySecurity(items) {
  const groups = new Map();
  for (const item of items) {
    const key = securityKey(item.position);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups].map(([key, list]) => ({
    key,
    label: list[0].position.name,
    short: shortName((list.find((item) => item.position.shortName) ?? list[0]).position),
    items: list,
    value: totals(list.map((item) => item.summary)).value,
  })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'nl'));
}

function filterOptions(items) {
  const accounts = accountNames(items);
  return {
    accounts: accounts.length > 1 ? accounts.map((account) => ({ key: `rekening:${account}`, label: account })) : [],
    securities: bySecurity(items).map(({ key, label }) => ({ key: `belegging:${key}`, label })),
  };
}

// Een verdeling heeft pas zin met twee of meer groepen. Zonder verdeling toont de grafiek waarde tegenover inleg.
function availableViews(items) {
  const accounts = new Set(items.map(({ position }) => position.account ?? ''));
  return [accounts.size > 1 && 'rekening', bySecurity(items).length > 1 && 'belegging'].filter(Boolean);
}

// Rekeningen houden overal dezelfde kleur, op alfabet over alle gegevens. Beleggingen krijgen hun kleur
// op volgorde van waarde. Past het niet in het palet, dan gaat de rest samen in één grijze groep, die
// zijn leden (`members`) bewaart zodat de legenda ze kan uitklappen.
function breakdownGroups(items, view) {
  let groups;
  if (view === 'rekening') {
    const everyAccount = accountNames(positions().map((position) => ({ position })));
    groups = everyAccount.map((name, slot) => ({
      label: name,
      slot,
      items: items.filter(({ position }) => position.account === name),
    })).filter((group) => group.items.length);
    const loose = items.filter(({ position }) => !position.account);
    if (loose.length) groups.push({ label: 'Zonder rekening', slot: null, items: loose });
  } else {
    groups = bySecurity(items).map((group, slot) => ({ ...group, label: group.short, slot }));
  }
  const slots = groups.length <= SERIES_SLOTS ? SERIES_SLOTS : SERIES_SLOTS - 1;
  const kept = groups.filter((group) => group.slot != null && group.slot < slots);
  const rest = groups.filter((group) => !kept.includes(group));
  const member = ({ label, items: list }) => ({ label, items: list });
  const result = kept.map((group) => ({ tone: `series-${group.slot + 1}`, members: [member(group)] }));
  if (rest.length) result.push({ tone: OTHER_TONE, members: rest.map(member), other: view });
  return result;
}

// "Overig" zegt niet wat erin zit; de naam noemt hoeveel en wat.
function groupLabel(group, count) {
  if (!group.other || count === 1) return group.members[0].label;
  return group.other === 'belegging' ? `${count} kleinere beleggingen` : `${count} andere rekeningen`;
}

function filterSelect(items, rerender) {
  const { accounts, securities } = filterOptions(items);
  if (accounts.length + securities.length < 2) return null;
  const option = ({ key, label }) => h('option', { value: key, selected: state.filter === key }, label);
  return h('label', { class: 'filter' },
    h('span', { class: 'visually-hidden' }, 'Laat zien'),
    h('select', {
      onchange: (event) => {
        state.filter = event.target.value || null;
        rerender();
      },
    },
    h('option', { value: '', selected: !state.filter }, 'Alle beleggingen'),
    accounts.length ? h('optgroup', { label: 'Rekening' }, accounts.map(option)) : null,
    h('optgroup', { label: 'Belegging' }, securities.map(option))));
}

// ---------- Onderdelen ----------

function toggleGroup(label, choices, current, choose) {
  return h('div', { class: 'toggles', role: 'group', 'aria-label': label },
    choices.map(({ key, text, name }) => h('button', {
      type: 'button',
      class: 'toggle',
      'aria-pressed': String(current === key),
      'aria-label': name,
      onclick: () => choose(key),
    }, text)));
}

function rangeRow(rerender) {
  return toggleGroup('Periode', RANGES.map((range) => ({ key: range, text: range })), state.range, (range) => {
    state.range = range;
    rerender();
  });
}

function viewRow(views, view, stateKey, rerender) {
  if (views.length < 2) return null;
  return toggleGroup('Weergave', views.map((key) => ({ key, text: VIEWS[key] })), view, (key) => {
    state[stateKey] = key;
    rerender();
  });
}

function unitRow(rerender) {
  return toggleGroup('Eenheid', [
    { key: 'eur', text: '€', name: 'In euro' },
    { key: 'pct', text: '%', name: 'In procenten' },
  ], state.unit, (unit) => {
    state.unit = unit;
    rerender();
  });
}

function zoomCheck(rerender) {
  return h('label', { class: 'check' },
    h('input', {
      type: 'checkbox',
      checked: state.zoom,
      onchange: (event) => {
        state.zoom = event.target.checked;
        try {
          localStorage.setItem(ZOOM_KEY, state.zoom ? '1' : '0');
        } catch {
          // Zonder opslag geldt de keuze alleen tot de app sluit.
        }
        rerender();
      },
    }),
    'As laten meeschalen');
}

const axisFormatFor = (series) =>
  series.at(-1).day - series[0].day > 400 ? { month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' };

// `views` zijn de weergaven die op dit scherm kunnen, `stateKey` onthoudt de keuze. Zonder weergaven
// toont de grafiek waarde tegenover inleg.
function chartBlock(items, rerender, views = [], stateKey = 'view') {
  const range = chartPeriod(state.range, todayIso(), chartPositions(items));
  const view = views.includes(state[stateKey]) ? state[stateKey] : views[0] ?? 'totaal';
  const stacked = view === 'rekening' || view === 'belegging';
  const wrapper = h('div', { class: 'chart-block' },
    viewRow(views, view, stateKey, rerender),
    h('div', { class: 'chart-controls' },
      rangeRow(rerender),
      stacked ? unitRow(rerender) : null,
      // In procenten is de as altijd 0 tot 100%.
      stacked && state.unit === 'pct' ? null : zoomCheck(rerender)));
  const chart = stacked ? stackChart(items, view, range)
    : view === 'stuk' ? unitChart(items[0], range)
      : totalChart(items, range);

  if (chart.series.length < 2) {
    wrapper.append(h('p', { class: 'chart-empty' },
      chart.series.length === 0
        ? 'In deze periode had je nog geen beleggingen.'
        : 'De grafiek begint zodra er een tweede dag aan koersen is.'));
    return { element: wrapper, series: chart.series, mount: () => {}, table: null };
  }
  wrapper.append(...chart.elements);
  return { element: wrapper, series: chart.series, mount: chart.mount, table: chart.table };
}

// Twee lijnen: `value` doorgetrokken, `cost` gestippeld. Gebruikt voor waarde tegenover inleg en
// voor koers tegenover gemiddelde aankoopprijs.
function lineChart(series, { valueLabel, costLabel, describe, columns, format }) {
  if (series.length < 2) return { series };
  const readoutDate = h('span', { class: 'readout-date' });
  const readoutValue = h('strong');
  const readoutCost = h('strong');
  const holder = h('div', { class: 'chart-holder' });
  const axisFormat = axisFormatFor(series);
  return {
    series,
    elements: [
      h('div', { class: 'readout' },
        readoutDate,
        h('span', { class: 'readout-item' }, h('span', { class: 'key key-value' }), readoutValue, ` ${valueLabel}`),
        h('span', { class: 'readout-item' }, h('span', { class: 'key key-cost' }), readoutCost, ` ${costLabel}`)),
      holder,
    ],
    mount: () => renderChart(holder, series, {
      zoom: state.zoom,
      describe: describe(series[0], series.at(-1)),
      formatDate: (day) => date(fromDay(day), axisFormat),
      onSelect: (point) => {
        readoutDate.textContent = date(fromDay(point.day));
        readoutValue.textContent = format(point.value);
        readoutCost.textContent = format(point.cost);
      },
    }),
    table: monthlyTable(columns, monthlyRows(series).map((row) => [row.month, eur(row.value), eur(row.cost)])),
  };
}

function totalChart(items, range) {
  const span = (first, last) => `van ${date(fromDay(first.day))} tot ${date(fromDay(last.day))}`;
  return lineChart(valueSeries(chartPositions(items), range), {
    valueLabel: 'waarde',
    costLabel: 'ingelegd',
    columns: ['Waarde', 'Inleg'],
    format: eurHero,
    describe: (first, last) => `Grafiek ${span(first, last)}: waarde van ${eur(first.value)} naar ${eur(last.value)}, ingelegd ${eur(last.cost)}.`,
  });
}

function unitChart({ position, summary }, range) {
  return lineChart(unitSeries({ txs: position.txs, points: summary.points }, range), {
    valueLabel: 'koers',
    costLabel: 'gem. aankoopprijs',
    columns: ['Koers', 'Gem. aankoopprijs'],
    format: eur,
    describe: (first, last) => `Koers per stuk van ${date(fromDay(first.day))} tot ${date(fromDay(last.day))}: van ${eur(first.value)} naar ${eur(last.value)}, gemiddelde aankoopprijs ${eur(last.cost)}.`,
  });
}

const sumAt = (indices, list) => indices.reduce((total, i) => total + list[i], 0);

// Gestapeld per rekening of belegging, met de inleg als stippellijn. De legenda staat in dezelfde volgorde
// als de lagen (bovenste eerst) en toont per groep inleg en waarde op het gekozen punt; de grijze groep
// klapt uit tot zijn leden.
function stackChart(items, view, range) {
  const allGroups = breakdownGroups(items, view);
  const members = allGroups.flatMap((group) => group.members);
  const raw = breakdownSeries(members.map((member) => chartPositions(member.items)), range);
  // Wat in deze periode niets waard was en niets kostte, hoort niet in de legenda.
  const used = members.map((_, i) => raw.some((point) => point.parts[i] > 0 || point.costs[i] > 0));
  let offset = 0;
  const groups = allGroups.map((group) => {
    const indices = group.members.map((_, j) => offset + j).filter((i) => used[i]);
    offset += group.members.length;
    return { ...group, indices, label: groupLabel(group, indices.length) };
  }).filter((group) => group.indices.length);
  const series = raw.map((point) => ({
    ...point,
    parts: groups.map((group) => sumAt(group.indices, point.parts)),
    costs: groups.map((group) => sumAt(group.indices, point.costs)),
    results: groups.map((group) => sumAt(group.indices, point.results)),
    memberParts: point.parts,
    memberCosts: point.costs,
    memberResults: point.results,
  }));
  if (series.length < 2) return { series };

  const first = series[0];
  const last = series.at(-1);
  const percent = state.unit === 'pct';
  const ratio = (part, whole) => share(whole > 0 ? part / whole : 0);
  const groupAt = (i) => (point) => ({ value: point.parts[i], cost: point.costs[i], result: point.results[i] });
  const memberAt = (m) => (point) => ({ value: point.memberParts[m], cost: point.memberCosts[m], result: point.memberResults[m] });
  const totalAt = (point) => ({ value: point.value, cost: point.cost, result: point.result });
  // Inleg, waarde en wat het sinds het begin van de periode opleverde (bijkopen telt niet, verkopen wel).
  // In procenten: aandeel in het totaal, en het verschil als rendement over de beginwaarde plus wat er bij kwam.
  // Het totaal staat ook in procenten in euro: 100% zegt niets.
  const shown = (point, read, total = false) => {
    const now = read(point);
    const start = read(first);
    const amount = now.result - start.result;
    const base = start.value + Math.max(0, now.cost - start.cost);
    const change = percent ? signedPct(base > 0 ? amount / base : null) || '–' : signedEurHero(amount);
    return percent && !total
      ? [ratio(now.cost, point.cost), ratio(now.value, point.value), change, amount]
      : [eurHero(now.cost), eurHero(now.value), change, amount];
  };

  // Elke regel krijgt drie cellen (inleg, waarde, verschil) die bij elk gekozen punt worden bijgewerkt.
  const updaters = [];
  const cells = (read, total) => {
    const cost = h('span', { class: 'legend-value' });
    const value = h('span', { class: 'legend-value' });
    const change = h('span', { class: 'legend-value' });
    updaters.push((point) => {
      let amount;
      [cost.textContent, value.textContent, change.textContent, amount] = shown(point, read, total);
      change.className = `legend-value legend-change ${direction(amount)}`;
    });
    return [cost, value, change];
  };
  const rows = groups.map((group, i) => {
    const grouped = group.other && group.indices.length > 1;
    const subRows = grouped ? group.indices.map((m) => h('li', { class: 'legend-item legend-sub', hidden: !state.otherOpen },
      h('span'),
      h('span', { class: 'legend-name' }, members[m].label),
      cells(memberAt(m)))) : [];
    const name = grouped
      ? h('button', {
        type: 'button',
        class: 'legend-name legend-toggle',
        'aria-expanded': String(state.otherOpen),
        onclick: (event) => {
          state.otherOpen = !state.otherOpen;
          event.currentTarget.setAttribute('aria-expanded', String(state.otherOpen));
          subRows.forEach((row) => { row.hidden = !state.otherOpen; });
        },
      }, group.label)
      : h('span', { class: 'legend-name' }, group.label);
    return [h('li', { class: 'legend-item' },
      h('span', { class: `swatch ${group.tone}` }),
      name,
      cells(groupAt(i))), ...subRows];
  }).reverse();
  const totalRow = h('li', { class: 'legend-item legend-total' },
    h('span'), h('span', { class: 'legend-name' }, 'Totaal'), cells(totalAt, true));
  const changeHead = state.range === 'Altijd' ? 'Resultaat' : `± ${state.range}`;
  const legend = h('ul', { class: 'legend' },
    h('li', { class: 'legend-item legend-head', 'aria-hidden': 'true' },
      h('span'), h('span'),
      ['Inleg', 'Waarde', changeHead].map((text) => h('span', { class: 'legend-value' }, text))),
    rows,
    totalRow);

  const readoutDate = h('span', { class: 'readout-date' });
  const holder = h('div', { class: 'chart-holder' });
  const axisFormat = axisFormatFor(series);
  const split = groups.map((group, i) => `${group.label} ${ratio(last.parts[i], last.value)}`).join(', ');
  return {
    series,
    elements: [
      h('div', { class: 'readout' },
        readoutDate,
        percent ? null : h('span', { class: 'readout-item' }, h('span', { class: 'key key-inleg' }), 'inleg')),
      holder,
      legend,
    ],
    mount: () => renderStack(holder, series, {
      tones: groups.map((group) => group.tone),
      percent,
      zoom: state.zoom,
      describe: `Verdeling per ${view} van ${date(fromDay(first.day))} tot ${date(fromDay(last.day))}. Op ${date(fromDay(last.day))}: ${split}; ingelegd ${eur(last.cost)}.`,
      formatDate: (day) => date(fromDay(day), axisFormat),
      onSelect: (point) => {
        readoutDate.textContent = date(fromDay(point.day));
        updaters.forEach((update) => update(point));
      },
    }),
    table: monthlyTable(
      [...groups.map((group) => group.label), ...(percent ? [] : ['Totaal', 'Inleg'])],
      monthlyRows(series).map((row) => [
        row.month,
        ...groups.map((_, i) => (percent ? ratio(row.parts[i], row.value) : eur(row.parts[i]))),
        ...(percent ? [] : [eur(row.value), eur(row.cost)]),
      ]),
    ),
  };
}

// `rows` zijn [maand, ...cellen]; bij veel kolommen schuift de tabel opzij en blijft de maand staan.
function monthlyTable(columns, rows) {
  return h('details', { class: 'monthly' },
    h('summary', {}, 'Cijfers per maand'),
    h('div', { class: 'table-scroll' },
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Maand'), columns.map((column) => h('th', { scope: 'col' }, column)))),
        h('tbody', {}, rows.map(([month, ...cells]) => h('tr', {},
          h('th', { scope: 'row' }, date(`${month}-15`, { month: 'short', year: 'numeric' })),
          cells.map((cell) => h('td', {}, cell))))))));
}

function gainLine(gain, gainPct) {
  const word = gain < -0.004 ? 'verlies' : 'winst';
  const pct = signedPct(gainPct);
  return `${signedEurHero(gain)} ${word}${pct ? ` (${pct})` : ''}`;
}

// Wat de gekozen periode opleverde; bij Altijd is dat gewoon de winst of het verlies erboven.
function periodLine(items) {
  const list = chartPositions(items);
  const period = chartPeriod(state.range, todayIso(), list);
  const change = periodChange(list, period);
  return change && `${gainLine(change.amount, change.ratio)} sinds ${date(fromDay(period.from), { day: 'numeric', month: 'short' })}`;
}

function hero(options) {
  const { top, filter, title, figure, lines, chart } = options;
  const figureElement = h('p', { class: 'figure' }, figure);
  const element = h('header', { class: 'hero' },
    top,
    filter,
    title ? h('h1', { class: 'hero-title' }, title) : null,
    figureElement,
    lines.filter(Boolean).map((line) => h('p', { class: 'hero-line' }, line)),
    chart?.element);
  return {
    element,
    mount: () => {
      fitFigure(figureElement);
      chart?.mount();
      document.fonts?.ready.then(() => fitFigure(figureElement));
    },
  };
}

function icon(path) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}

function iconButton(label, path, onclick) {
  return h('button', { type: 'button', class: 'icon-button', 'aria-label': label, onclick }, icon(path));
}

const ICON_MENU = 'M4 7h16M4 12h16M4 17h16';
const ICON_BACK = 'M15 5l-7 7 7 7';

function positionRow({ position, summary }) {
  const details = [position.account, position.symbol ?? 'Zonder koers'].filter(Boolean).join(', ');
  return h('li', {},
    h('a', { class: 'row', href: `#/positie/${position.id}` },
      h('span', { class: 'row-main' },
        h('span', { class: 'row-name' }, position.name),
        h('span', { class: 'row-meta' }, `${details}, ${pieces(summary.qty)}`)),
      h('span', { class: 'row-numbers' },
        h('span', { class: 'row-value' }, eur(summary.value)),
        h('span', { class: 'row-cost' }, `${eur(summary.cost)} ingelegd`),
        h('span', { class: `row-gain ${direction(summary.gain)}` }, `${signedEur(summary.gain)} ${signedPct(summary.gainPct)}`.trim()))));
}

function closedRow({ position, summary }) {
  return h('li', {},
    h('a', { class: 'row', href: `#/positie/${position.id}` },
      h('span', { class: 'row-main' },
        h('span', { class: 'row-name' }, position.name),
        h('span', { class: 'row-meta' }, 'Volledig verkocht')),
      h('span', { class: 'row-numbers' },
        h('span', { class: `row-gain ${direction(summary.realized)}` }, signedEur(summary.realized)))));
}

// `total` is { value, cost } of leeg.
function section(title, items, total) {
  return h('section', { class: 'group' },
    h('div', { class: 'group-head' },
      h('h2', {}, title),
      total ? h('span', { class: 'group-total' },
        h('span', {}, eur(total.value)),
        h('span', { class: 'group-cost' }, `${eur(total.cost)} ingelegd`)) : null),
    h('ul', { class: 'rows' }, items));
}

function statusLine() {
  const fetched = lastFetchedAt();
  const hasSymbols = positions().some((position) => position.symbol);
  if (!hasSymbols) return null;
  let text = fetched ? `Koersen van ${fetchedLabel(fetched)}` : 'Nog geen koersen opgehaald';
  if (state.refreshFailed) text = `Koersen ophalen lukt nu niet. Je ziet de laatst bekende waarden${fetched ? ` van ${fetchedLabel(fetched)}` : ''}.`;
  return h('div', { class: 'status', role: 'status' },
    h('span', {}, text),
    h('button', {
      type: 'button',
      class: 'link-button',
      disabled: state.refreshing,
      onclick: () => refresh(true),
    }, state.refreshing ? 'Bezig…' : 'Bijwerken'));
}

function backupNudge() {
  const { lastBackupAt, changedAt } = backupStatus();
  if (!changedAt || positions().length === 0) return null;
  if (lastBackupAt && lastBackupAt >= changedAt) return null;
  return isOnPc()
    ? h('div', { class: 'status' },
      h('span', {}, 'Je wijzigingen staan nog niet in het bestand op je pc.'),
      h('button', { type: 'button', class: 'link-button', onclick: openMenu }, 'Opslaan op pc'))
    : h('div', { class: 'status' }, h('span', {}, 'Wijzigingen op dit apparaat gaan verloren bij het volgende ophalen.'));
}

// ---------- Schermen ----------

function renderHome() {
  const all = positions().map(withSummary);
  const inTab = state.tab === 'alles' ? all : all.filter((item) => item.position.portfolio === state.tab);
  const open = inTab.filter((item) => !item.summary.closed).sort((a, b) => b.summary.value - a.summary.value);
  const closed = inTab.filter((item) => item.summary.closed);
  let shown = applyFilter(inTab);
  if (shown.length === 0) {
    state.filter = null;
    shown = inTab;
  }
  const total = totals(shown.map((item) => item.summary));
  const rerender = () => render();

  const tabs = h('div', { class: 'hero-top' },
    h('nav', { class: 'tabs', 'aria-label': 'Portefeuille' },
      Object.entries(TABS).map(([key, label]) => h('button', {
        type: 'button',
        class: 'tab',
        'aria-pressed': String(state.tab === key),
        onclick: () => {
          state.tab = key;
          render();
        },
      }, label))),
    iconButton('Menu', ICON_MENU, openMenu));

  const chart = inTab.length ? chartBlock(shown, rerender, availableViews(shown)) : null;
  const head = hero({
    top: tabs,
    filter: filterSelect(inTab, rerender),
    figure: eurHero(total.value),
    lines: inTab.length ? [gainLine(total.gain, total.gainPct), `${eurHero(total.cost)} ingelegd`, periodLine(shown)] : [],
    chart,
  });

  const body = h('main', { class: 'sheet' });
  if (inTab.length === 0) {
    const label = state.tab === 'alles' ? 'beleggingen' : `${TABS[state.tab].toLowerCase()}e beleggingen`;
    body.append(h('div', { class: 'empty' },
      h('h2', {}, `Nog geen ${label}`),
      h('p', {}, 'Voeg toe wat je hebt gekocht. De app laat dan zien wat het kostte en wat het nu waard is.'),
      positions().length === 0 ? h('button', { type: 'button', class: 'link-button', onclick: openMenu }, 'Gegevens inladen') : null));
  } else {
    body.append(...[statusLine(), backupNudge()].filter(Boolean));
    if (state.tab === 'alles') {
      for (const [key, label] of Object.entries(PORTFOLIOS)) {
        const items = open.filter((item) => item.position.portfolio === key);
        if (items.length) body.append(section(label, items.map(positionRow), totals(items.map((item) => item.summary))));
      }
    } else if (open.length) {
      body.append(section('Posities', open.map(positionRow)));
    }
    if (closed.length) body.append(section('Verkocht', closed.map(closedRow)));
    if (chart.table) body.append(chart.table);
  }

  const dock = h('div', { class: 'dock' },
    h('button', {
      type: 'button',
      class: 'primary',
      onclick: () => openPositionDialog(null, state.tab === 'alles' ? 'prive' : state.tab),
    }, 'Belegging toevoegen'));

  app.replaceChildren(head.element, body, dock);
  head.mount();
}

function stat(label, value, className) {
  return h('div', { class: 'stat' }, h('dt', {}, label), h('dd', { class: className }, value));
}

function priceSourceText(summary, position) {
  if (summary.fxMissing) return 'Wisselkoers ontbreekt: laatst bekende europrijs';
  const on = summary.priceDate ? date(summary.priceDate) : '';
  if (summary.priceSource === 'markt') return `Slotkoers of laatste koers van ${on}`;
  if (summary.priceSource === 'handmatig') return `Door jou ingevuld op ${on}`;
  return position.symbol ? `Prijs van je transactie op ${on}; nog geen koers opgehaald` : `Prijs van je transactie op ${on}`;
}

function historyRows(position) {
  const txRows = position.txs.map((tx) => {
    const amount = tx.qty * tx.price + (tx.type === 'buy' ? tx.fee || 0 : -(tx.fee || 0));
    return {
      date: tx.date,
      element: h('li', {},
        h('button', { type: 'button', class: 'row', onclick: () => openTxDialog(position, tx.type, tx) },
          h('span', { class: 'row-main' },
            h('span', { class: 'row-name' }, tx.type === 'buy' ? 'Gekocht' : 'Verkocht'),
            h('span', { class: 'row-meta' }, `${date(tx.date)}, ${quantity(tx.qty)} × ${eur(tx.price)}`)),
          h('span', { class: 'row-numbers' }, h('span', { class: 'row-value' }, eur(amount))))),
    };
  });
  const manualRows = (position.manualPrices ?? []).map((manual) => ({
    date: manual.date,
    element: h('li', {},
      h('button', { type: 'button', class: 'row', onclick: () => openPriceDialog(position, manual) },
        h('span', { class: 'row-main' },
          h('span', { class: 'row-name' }, 'Waarde bijgewerkt'),
          h('span', { class: 'row-meta' }, date(manual.date))),
        h('span', { class: 'row-numbers' }, h('span', { class: 'row-value' }, eur(manual.price))))),
  }));
  return [...txRows, ...manualRows].sort((a, b) => b.date.localeCompare(a.date)).map((row) => row.element);
}

function renderPosition(id) {
  const position = findPosition(id);
  if (!position) {
    location.hash = '#/';
    return;
  }
  const item = withSummary(position);
  const { summary } = item;
  const rerender = () => render();

  const top = h('div', { class: 'hero-top' },
    h('a', { class: 'back', href: '#/' }, icon(ICON_BACK), 'Overzicht'),
    h('span', { class: 'hero-tag' }, [PORTFOLIOS[position.portfolio], position.account].filter(Boolean).join(', ')));

  const chart = chartBlock([item], rerender, summary.closed ? [] : ['totaal', 'stuk'], 'positionView');
  const lines = summary.closed
    ? [`Volledig verkocht, ${signedEurHero(summary.realized)} resultaat`]
    : [gainLine(summary.gain, summary.gainPct), `${eurHero(summary.cost)} ingelegd`, periodLine([item])];
  const head = hero({ top, title: position.name, figure: eurHero(summary.value), lines, chart });

  const stats = h('dl', { class: 'stats' },
    stat('Aantal', quantity(summary.qty)),
    summary.closed ? null : stat('Gemiddelde aankoopprijs', eur(summary.average)),
    summary.closed ? null : stat('Waarde per stuk nu', eur(summary.price)),
    summary.realized !== 0 ? stat('Resultaat op verkopen', signedEur(summary.realized), direction(summary.realized)) : null);

  const body = h('main', { class: 'sheet' },
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'secondary', onclick: () => openTxDialog(position, 'buy') }, 'Kopen'),
      h('button', { type: 'button', class: 'secondary', disabled: summary.closed, onclick: () => openTxDialog(position, 'sell') }, 'Verkopen'),
      h('button', { type: 'button', class: 'secondary', onclick: () => openPriceDialog(position) }, 'Waarde bijwerken')),
    stats,
    summary.closed ? null : h('p', { class: 'source' }, priceSourceText(summary, position)),
    section('Geschiedenis', historyRows(position)),
    chart.table,
    h('div', { class: 'footer-actions' },
      h('button', { type: 'button', class: 'link-button', onclick: () => openPositionDialog(position) }, 'Belegging aanpassen'),
      h('button', {
        type: 'button',
        class: 'link-button danger',
        onclick: () => {
          if (confirm(`${position.name} en de hele geschiedenis verwijderen? Dit kun je niet terugdraaien.`)) {
            deletePosition(position.id);
            location.hash = '#/';
          }
        },
      }, 'Belegging verwijderen')));

  app.replaceChildren(head.element, body);
  head.mount();
}

function render() {
  const match = location.hash.match(/^#\/positie\/(.+)$/);
  if (match) renderPosition(match[1]);
  else renderHome();
}

// ---------- Dialogen ----------

function openSheet(title, content, { onSubmit, submitLabel, extra } = {}) {
  document.querySelectorAll('dialog').forEach((open) => open.remove());
  const errorBox = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const close = () => dialog.remove();
  const form = h('form', {
    novalidate: true,
    onsubmit: (event) => {
      event.preventDefault();
      const problem = onSubmit?.(new FormData(form), form);
      if (problem) {
        errorBox.textContent = problem;
        errorBox.hidden = false;
        return;
      }
      close();
    },
  },
  content,
  errorBox,
  onSubmit ? h('button', { type: 'submit', class: 'primary' }, submitLabel) : null,
  extra);
  const dialog = h('dialog', { class: 'dialog', 'aria-label': title },
    h('div', { class: 'dialog-head' },
      h('h2', {}, title),
      h('button', { type: 'button', class: 'link-button', onclick: close }, 'Sluiten')),
    form);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, close };
}

function readTrade(data) {
  const qty = parseNumber(data.get('qty'));
  const price = parseNumber(data.get('price'));
  const feeText = String(data.get('fee') ?? '').trim();
  const fee = feeText ? parseNumber(feeText) : 0;
  const when = String(data.get('date') ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(when)) return { error: 'Vul een datum in.' };
  if (when > todayIso()) return { error: 'De datum kan niet in de toekomst liggen.' };
  if (!(qty > 0)) return { error: 'Vul een aantal in dat groter is dan 0, met een komma voor decimalen: 12,5.' };
  if (!(price >= 0)) return { error: 'Vul de prijs per stuk in euro in, zonder punten: 1250,50.' };
  if (!(fee >= 0)) return { error: 'Vul de kosten in als bedrag, of laat ze leeg.' };
  return { date: when, qty, price, fee };
}

function tradeFields({ tx, priceHint }) {
  return [
    field('Datum', dateInput(tx?.date ?? todayIso())),
    field('Aantal', numberInput('qty', numberText(tx?.qty))),
    field('Prijs per stuk in euro', numberInput('price', numberText(tx?.price)), priceHint),
    field('Kosten in euro', numberInput('fee', tx?.fee ? numberText(tx.fee) : '', false), 'Transactiekosten van je broker; mag leeg blijven.'),
  ];
}

function symbolPicker(initial, onChange) {
  let picked = initial;
  const box = h('div', { class: 'picker' });
  let timer = null;
  let sequence = 0;

  const showPicked = () => {
    box.replaceChildren(
      h('div', { class: 'picked' },
        h('span', { class: 'picked-text' },
          h('strong', {}, picked.symbol),
          h('span', {}, picked.name)),
        h('button', {
          type: 'button',
          class: 'link-button',
          onclick: () => {
            picked = null;
            onChange(null);
            showSearch();
          },
        }, 'Wijzig')),
    );
    const note = h('p', { class: 'field-hint' });
    box.append(note);
    const current = picked.symbol;
    peekQuote(current).then((quote) => {
      if (picked?.symbol !== current) return;
      const currency = quote.currency ?? '';
      const parts = [`Koers nu ${quote.price?.toLocaleString('nl-NL', { maximumFractionDigits: 4 })} ${currency}`];
      if (fxSymbol(currency)) parts.push('De app rekent dit om naar euro');
      note.textContent = `${parts.join('. ')}.`;
    }).catch(() => {
      if (picked?.symbol === current) note.textContent = 'Koers ophalen lukt nu niet. Je kunt wel gewoon opslaan.';
    });
  };

  const showSearch = () => {
    const results = h('ul', { class: 'results' });
    const input = h('input', {
      type: 'search',
      autocomplete: 'off',
      placeholder: 'Bijvoorbeeld VWRL, ASML of een ISIN',
      oninput: () => {
        clearTimeout(timer);
        const query = input.value.trim();
        if (query.length < 2) {
          results.replaceChildren();
          return;
        }
        timer = setTimeout(async () => {
          const mine = ++sequence;
          try {
            const found = await searchSymbols(query);
            if (mine !== sequence) return;
            results.replaceChildren(...(found.length
              ? found.map((result) => h('li', {},
                h('button', {
                  type: 'button',
                  class: 'result',
                  onclick: () => {
                    picked = result;
                    onChange(result);
                    showPicked();
                  },
                },
                h('strong', {}, result.symbol),
                h('span', {}, [result.name, result.exchange].filter(Boolean).join(', ')))))
              : [h('li', { class: 'field-hint' }, 'Niets gevonden. Probeer de naam of ticker, of ga verder zonder koers.')]));
          } catch {
            if (mine === sequence) {
              results.replaceChildren(h('li', { class: 'field-hint' }, 'Zoeken lukt nu niet. Vul hieronder de naam in en werk de waarde zelf bij.'));
            }
          }
        }, 300);
      },
    });
    box.replaceChildren(field('Zoek op naam, ticker of ISIN', input), results);
  };

  if (picked) showPicked();
  else showSearch();
  return box;
}

function openPositionDialog(position, defaultPortfolio) {
  const editing = Boolean(position);
  let picked = position?.symbol ? { symbol: position.symbol, name: position.name } : null;
  const nameInput = h('input', { name: 'name', type: 'text', autocomplete: 'off', required: true, value: position?.name ?? '' });
  const picker = symbolPicker(picked, (result) => {
    picked = result;
    if (result) nameInput.value = result.name;
  });
  const current = position?.portfolio ?? defaultPortfolio;
  const knownAccounts = [...new Set(positions().map((other) => other.account).filter(Boolean))].sort();
  const accountInput = h('input', { name: 'account', type: 'text', autocomplete: 'off', list: 'accounts', value: position?.account ?? '' });
  const portfolio = h('fieldset', { class: 'choice' },
    h('legend', { class: 'field-label' }, 'Voor wie'),
    Object.entries(PORTFOLIOS).map(([key, label]) => h('label', { class: 'choice-option' },
      h('input', { type: 'radio', name: 'portfolio', value: key, checked: current === key }),
      h('span', {}, label))));

  openSheet(editing ? 'Belegging aanpassen' : 'Belegging toevoegen', [
    portfolio,
    picker,
    field('Naam', nameInput, 'Geen ticker? Vul alleen de naam in en werk de waarde zelf bij, bijvoorbeeld voor crowdfunding of een deelneming.'),
    field('Korte naam', h('input', {
      name: 'shortName',
      type: 'text',
      autocomplete: 'off',
      maxlength: 16,
      placeholder: position ? shortName({ ...position, shortName: null }) : null,
      value: position?.shortName ?? '',
    }), 'Voor de legenda bij de grafiek, bijvoorbeeld AMD of S&P500. Leeg laten: de ticker of de naam.'),
    field('Rekening', accountInput, 'Bijvoorbeeld de naam van je broker. Mag leeg blijven.'),
    h('datalist', { id: 'accounts' }, knownAccounts.map((account) => h('option', { value: account }))),
    editing ? null : h('h3', { class: 'form-subhead' }, 'Eerste aankoop'),
    editing ? null : tradeFields({}),
  ], {
    submitLabel: editing ? 'Wijzigingen opslaan' : 'Belegging opslaan',
    onSubmit: (data) => {
      const name = String(data.get('name') ?? '').trim();
      if (!name) return 'Kies een belegging uit de zoekresultaten of vul een naam in.';
      const account = String(data.get('account') ?? '').trim() || null;
      const short = String(data.get('shortName') ?? '').trim() || null;
      const base = { name, shortName: short, account, symbol: picked?.symbol ?? null, portfolio: data.get('portfolio') };
      if (editing) {
        savePosition({ ...position, ...base });
      } else {
        const trade = readTrade(data);
        if (trade.error) return trade.error;
        savePosition({ id: newId(), ...base, manualPrices: [], txs: [{ id: newId(), type: 'buy', ...trade }] });
      }
      render();
      refresh(false);
      return null;
    },
  });
}

function openTxDialog(position, type, tx) {
  const editing = Boolean(tx);
  const others = position.txs.filter((other) => other.id !== tx?.id);
  const owned = ledger(position.txs).qty;
  const fields = tradeFields({ tx });
  const content = [fields];
  if (type === 'sell' && !editing) {
    content.push(h('button', {
      type: 'button',
      class: 'link-button',
      onclick: (event) => {
        event.target.closest('form').elements.qty.value = numberText(owned);
      },
    }, `Alles verkopen (${pieces(owned)})`));
  }

  const remove = editing ? h('button', {
    type: 'button',
    class: 'link-button danger',
    onclick: () => {
      if (others.length === 0) {
        problemBox('Dit is de enige transactie. Verwijder de belegging als geheel.');
        return;
      }
      if (ledger(others).oversold) {
        problemBox('Dat kan niet: een latere verkoop is dan meer dan je toen had.');
        return;
      }
      if (confirm('Deze transactie verwijderen?')) {
        savePosition({ ...position, txs: others });
        sheet.close();
        render();
      }
    },
  }, 'Transactie verwijderen') : null;

  const titles = { buy: ['Kopen', 'Aankoop wijzigen'], sell: ['Verkopen', 'Verkoop wijzigen'] };
  const sheet = openSheet(titles[type][editing ? 1 : 0], content, {
    submitLabel: type === 'buy' ? 'Aankoop opslaan' : 'Verkoop opslaan',
    extra: remove,
    onSubmit: (data) => {
      const trade = readTrade(data);
      if (trade.error) return trade.error;
      const next = [...others, { id: tx?.id ?? newId(), type, ...trade }];
      if (ledger(next).oversold) return 'Je verkoopt meer dan je op die datum had.';
      savePosition({ ...position, txs: next });
      render();
      refresh(false);
      return null;
    },
  });

  function problemBox(text) {
    const box = sheet.dialog.querySelector('.form-error');
    box.textContent = text;
    box.hidden = false;
  }
}

function openPriceDialog(position, manual) {
  const editing = Boolean(manual);
  const list = position.manualPrices ?? [];
  const remove = editing ? h('button', {
    type: 'button',
    class: 'link-button danger',
    onclick: () => {
      savePosition({ ...position, manualPrices: list.filter((other) => other !== manual) });
      sheet.close();
      render();
    },
  }, 'Waarde verwijderen') : null;

  const sheet = openSheet('Waarde bijwerken', [
    field('Datum', dateInput(manual?.date ?? todayIso())),
    field('Waarde per stuk in euro', numberInput('price', numberText(manual?.price)),
      position.symbol ? 'Een nieuwere koers van de markt vervangt deze waarde vanzelf.' : null),
  ], {
    submitLabel: 'Waarde opslaan',
    extra: remove,
    onSubmit: (data) => {
      const price = parseNumber(data.get('price'));
      const when = String(data.get('date') ?? '');
      if (!when || when > todayIso()) return 'Vul een datum in die niet in de toekomst ligt.';
      if (!(price >= 0)) return 'Vul de waarde per stuk in euro in, zonder punten: 1250,50.';
      const kept = list.filter((other) => other !== manual && other.date !== when);
      savePosition({ ...position, manualPrices: [...kept, { date: when, price }] });
      render();
      return null;
    },
  });
}

// Geeft terug of de backup echt is weggeschreven; annuleren telt niet.
async function shareOrDownload(text) {
  const name = `mijnportfolio-backup-${todayIso()}.json`;
  const file = new File([text], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return true;
    } catch (error) {
      if (error.name === 'AbortError') return false;
    }
  }
  const link = h('a', { href: URL.createObjectURL(file), download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  return true;
}

function openMenu() {
  const { lastBackupAt } = backupStatus();
  const onPc = isOnPc();
  const fileInput = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    class: 'visually-hidden',
    onchange: async () => {
      const file = fileInput.files[0];
      if (!file) return;
      if (positions().length && !confirm('Deze backup vervangt alle beleggingen op dit apparaat. Doorgaan?')) return;
      const problem = importBackup(await file.text());
      if (problem) {
        message.textContent = problem;
        return;
      }
      sheet.close();
      render();
      refresh(true);
    },
  });
  const message = h('p', { class: 'form-error', role: 'alert' });
  const saved = h('p', { class: 'dialog-text', role: 'status' },
    lastBackupAt ? `Laatst bewaard of opgehaald: ${date(lastBackupAt)}.` : 'Nog niet bewaard of opgehaald.');
  const sheet = openSheet('Gegevens', [
    h('p', { class: 'dialog-text' }, onPc
      ? 'Sla op wat je hier invoert. Je telefoon haalt het daarna op uit het bestand op deze pc.'
      : 'Je beleggingen komen uit het bestand op je pc. Wat je hier wijzigt, wordt bij het volgende ophalen overschreven.'),
    saved,
    onPc ? h('button', {
      type: 'button',
      class: 'primary',
      disabled: positions().length === 0,
      onclick: async () => {
        message.textContent = '';
        const problem = await pushToPc();
        if (problem) {
          message.textContent = problem;
          return;
        }
        saved.textContent = 'Opgeslagen op je pc.';
        render();
      },
    }, 'Opslaan op pc') : null,
    h('button', {
      type: 'button',
      class: onPc ? 'secondary wide' : 'primary',
      onclick: async () => {
        message.textContent = '';
        if (positions().length && !confirm('Dit vervangt alle beleggingen op dit apparaat door die uit het bestand op je pc. Doorgaan?')) return;
        const problem = await pullFromPc();
        if (problem) {
          message.textContent = problem;
          return;
        }
        sheet.close();
        render();
        refresh(true);
      },
    }, 'Ophalen van pc'),
    h('button', {
      type: 'button',
      class: 'secondary wide',
      disabled: positions().length === 0,
      onclick: async () => {
        if (await shareOrDownload(exportBackup())) markBackupMade();
        sheet.close();
        render();
      },
    }, 'Backup maken'),
    h('button', { type: 'button', class: 'secondary wide', onclick: () => fileInput.click() }, 'Backup terugzetten'),
    fileInput,
    message,
  ]);
}

// ---------- Opstarten ----------

async function refresh(force) {
  if (state.refreshing) return;
  state.refreshing = true;
  if (force) render();
  try {
    const { failed } = await refreshQuotes(positions(), { force });
    state.refreshFailed = failed.length > 0;
  } finally {
    state.refreshing = false;
  }
  if (!document.querySelector('dialog')) render();
}

window.addEventListener('hashchange', () => {
  document.querySelectorAll('dialog').forEach((open) => open.remove());
  window.scrollTo(0, 0);
  render();
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!document.querySelector('dialog')) render();
  }, 150);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh(false);
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

render();
refresh(false);

