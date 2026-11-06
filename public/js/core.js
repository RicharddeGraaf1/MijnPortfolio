// Rekenkern: geen DOM, geen opslag, zodat alles los te testen is.
// Bedragen zijn altijd in euro; datums zijn 'YYYY-MM-DD' of een dagnummer sinds 1970.

const MS_PER_DAY = 86400000;
const EPSILON = 1e-9;

export const toDay = (iso) =>
  Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / MS_PER_DAY;

export const fromDay = (day) => new Date(day * MS_PER_DAY).toISOString().slice(0, 10);

export function todayIso(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Leest bedragen zoals je ze op een Nederlandse telefoon typt: 1.234,56 en 12,5 en 12.5.
// "5.400" kan 5400 of 5,4 zijn; dat weigeren we, want een factor 1000 mis zie je niet terug.
export function parseNumber(input) {
  const text = String(input ?? '').trim().replace(/[€\s ]/g, '');
  if (!text || /^[1-9]\d{0,2}\.\d{3}$/.test(text)) return NaN;
  const normalized = text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text;
  return /^\d*\.?\d+$/.test(normalized) ? Number(normalized) : NaN;
}

// Aankopen op dezelfde dag tellen vóór verkopen, zodat de volgorde van invoeren niet uitmaakt.
function chronological(txs) {
  const rank = { buy: 0, sell: 1 };
  return [...txs].sort((a, b) => a.date.localeCompare(b.date) || rank[a.type] - rank[b.type]);
}

// Doorloopt alle transacties met de gemiddelde-kostprijsmethode.
export function ledger(txs) {
  let qty = 0;
  let cost = 0;
  let realized = 0;
  let oversold = null;
  const steps = [];
  for (const tx of chronological(txs)) {
    const fee = tx.fee || 0;
    if (tx.type === 'buy') {
      qty += tx.qty;
      cost += tx.qty * tx.price + fee;
    } else {
      if (tx.qty > qty + EPSILON) oversold ??= tx.date;
      const sold = Math.min(tx.qty, qty);
      const costOut = qty > 0 ? (cost / qty) * sold : 0;
      realized += sold * tx.price - fee - costOut;
      cost -= costOut;
      qty -= sold;
      if (qty < EPSILON) {
        qty = 0;
        cost = 0;
      }
    }
    steps.push({ day: toDay(tx.date), qty, cost });
  }
  return { qty, cost, realized, oversold, steps };
}

// Zoekt de laatst bekende waarde op of vóór `day` in een op dag gesorteerde lijst [[dag, waarde], ...].
export function asOf(points, day) {
  let low = 0;
  let high = points.length - 1;
  let found = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (points[mid][0] <= day) {
      found = points[mid][1];
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

// Geeft het valutapaar dat nodig is om een noteringsvaluta naar euro om te rekenen.
export function fxSymbol(currency) {
  if (!currency || currency === 'EUR') return null;
  return `${minorUnit(currency).base}EUR=X`;
}

// Londen noteert vaak in pence (GBp of GBX): die zijn een honderdste pond.
function minorUnit(currency) {
  if (currency === 'GBp' || currency === 'GBX') return { base: 'GBP', factor: 0.01 };
  return { base: currency.toUpperCase(), factor: 1 };
}

function toEuroConverter(currency, quotes) {
  if (!currency || currency === 'EUR') return () => 1;
  const pair = quotes[fxSymbol(currency)];
  if (!pair) return null;
  const { factor } = minorUnit(currency);
  return (day) => {
    const rate = asOf(pair.bars, day) ?? pair.bars[0]?.[1] ?? pair.price;
    return rate == null ? null : rate * factor;
  };
}

// Voegt alle bekende koersen samen tot één reeks in euro. Bij dezelfde dag gaat een
// handmatige waarde boven de markt, en de markt boven de prijs van een transactie.
export function pricePoints(position, quotes) {
  const byDay = new Map();
  for (const tx of position.txs) byDay.set(toDay(tx.date), [toDay(tx.date), tx.price, 'transactie']);

  const quote = position.symbol ? quotes[position.symbol] : null;
  let fxMissing = false;
  if (quote) {
    const toEuro = toEuroConverter(quote.currency, quotes);
    if (toEuro) {
      for (const [day, close] of quote.bars) {
        const factor = toEuro(day);
        if (factor != null) byDay.set(day, [day, close * factor, 'markt']);
      }
      if (quote.price != null && quote.time != null) {
        const day = toDay(quote.time.slice(0, 10));
        const factor = toEuro(day);
        if (factor != null) byDay.set(day, [day, quote.price * factor, 'markt']);
      }
    } else {
      fxMissing = true;
    }
  }

  for (const manual of position.manualPrices ?? []) {
    byDay.set(toDay(manual.date), [toDay(manual.date), manual.price, 'handmatig']);
  }

  const points = [...byDay.values()].sort((a, b) => a[0] - b[0]);
  return { points, fxMissing };
}

export function summarize(position, quotes) {
  const { qty, cost, realized } = ledger(position.txs);
  const { points, fxMissing } = pricePoints(position, quotes);
  const last = points.at(-1) ?? null;
  const price = last?.[1] ?? null;
  const value = price == null ? 0 : qty * price;
  const gain = value - cost;
  return {
    qty,
    cost,
    realized,
    price,
    priceDate: last ? fromDay(last[0]) : null,
    priceSource: last?.[2] ?? null,
    fxMissing,
    value,
    gain,
    gainPct: cost > 0 ? gain / cost : null,
    average: qty > 0 ? cost / qty : null,
    closed: qty === 0,
    points,
  };
}

export function totals(summaries) {
  const value = summaries.reduce((sum, s) => sum + s.value, 0);
  const cost = summaries.reduce((sum, s) => sum + s.cost, 0);
  const realized = summaries.reduce((sum, s) => sum + s.realized, 0);
  const gain = value - cost;
  return { value, cost, realized, gain, gainPct: cost > 0 ? gain / cost : null };
}

export function rangeStart(range, today) {
  const months = { '1M': 1, '6M': 6, '1J': 12 }[range];
  if (!months) return null;
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - months);
  return toDay(date.toISOString().slice(0, 10));
}

const track = (position) => ({
  steps: ledger(position.txs).steps.map((step) => [step.day, step]),
  points: position.points,
});

// Dagen vanaf de eerste aankoop (of `from`) tot en met `to`, maximaal ongeveer `maxPoints`.
function seriesDays(tracks, from, to, maxPoints) {
  const started = tracks.filter((t) => t.steps.length > 0);
  if (started.length === 0) return [];
  const firstDay = Math.min(...started.map((t) => t.steps[0][0]));
  const start = from == null ? firstDay : Math.max(firstDay, from);
  if (start > to) return [];
  const step = Math.max(1, Math.ceil((to - start) / maxPoints));
  const days = [];
  for (let day = start; day < to; day += step) days.push(day);
  days.push(to);
  return days;
}

function holdingOn(t, day) {
  const holding = asOf(t.steps, day);
  if (!holding || holding.qty === 0) return { value: 0, cost: 0 };
  return { value: holding.qty * (asOf(t.points, day) ?? 0), cost: holding.cost };
}

// Waarde en inleg per dag, teruggebracht tot maximaal ongeveer `maxPoints` punten.
export function valueSeries(positions, { from = null, to, maxPoints = 240 }) {
  const tracks = positions.map(track);
  return seriesDays(tracks, from, to, maxPoints).map((day) => {
    let value = 0;
    let cost = 0;
    for (const t of tracks) {
      const holding = holdingOn(t, day);
      value += holding.value;
      cost += holding.cost;
    }
    return { day, value, cost };
  });
}

// Waarde en inleg per groep per dag, voor een gestapelde grafiek: `groups` is een lijst van lijsten
// posities; `parts` (waarde) en `costs` (inleg) staan in dezelfde volgorde.
export function breakdownSeries(groups, { from = null, to, maxPoints = 240 }) {
  const tracks = groups.map((positions) => positions.map(track));
  const sum = (list) => list.reduce((total, amount) => total + amount, 0);
  return seriesDays(tracks.flat(), from, to, maxPoints).map((day) => {
    const holdings = tracks.map((group) => group.map((t) => holdingOn(t, day)));
    const parts = holdings.map((group) => sum(group.map((holding) => holding.value)));
    const costs = holdings.map((group) => sum(group.map((holding) => holding.cost)));
    return { day, parts, costs, value: sum(parts), cost: sum(costs) };
  });
}

// Koers en gemiddelde aankoopprijs per stuk, alleen op dagen dat je de belegging had.
export function unitSeries(position, { from = null, to, maxPoints = 240 }) {
  const t = track(position);
  return seriesDays([t], from, to, maxPoints).flatMap((day) => {
    const holding = asOf(t.steps, day);
    if (!holding || holding.qty === 0) return [];
    return [{ day, value: asOf(t.points, day) ?? 0, cost: holding.cost / holding.qty }];
  });
}

// Laatste punt van elke maand, nieuwste eerst: de tabel naast de grafiek.
export function monthlyRows(series) {
  const byMonth = new Map();
  for (const point of series) byMonth.set(fromDay(point.day).slice(0, 7), point);
  return [...byMonth.entries()].map(([month, point]) => ({ month, ...point })).reverse();
}

// Valideert een backup voordat die de huidige gegevens mag vervangen.
export function validateBackup(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.positions)) {
    return 'Dit bestand is geen backup van Mijn Portfolio.';
  }
  const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const isAmount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  for (const position of data.positions) {
    const label = position?.name || 'een belegging';
    if (typeof position?.name !== 'string' || !position.name.trim()) {
      return 'Een belegging in deze backup heeft geen naam.';
    }
    if (position.account != null && typeof position.account !== 'string') {
      return `${label} heeft een ongeldige rekening.`;
    }
    if (!['prive', 'zakelijk'].includes(position.portfolio)) {
      return `${label} is niet privé of zakelijk.`;
    }
    if (!Array.isArray(position.txs) || position.txs.length === 0) {
      return `${label} heeft geen transacties.`;
    }
    for (const tx of position.txs) {
      const valid = ['buy', 'sell'].includes(tx?.type) && isDate(tx.date) && isAmount(tx.qty) &&
        tx.qty > 0 && isAmount(tx.price) && (tx.fee == null || isAmount(tx.fee));
      if (!valid) return `${label} heeft een ongeldige transactie.`;
    }
    for (const manual of position.manualPrices ?? []) {
      if (!isDate(manual?.date) || !isAmount(manual?.price)) {
        return `${label} heeft een ongeldige waarde.`;
      }
    }
    if (ledger(position.txs).oversold) return `${label} verkoopt meer dan er op dat moment was.`;
  }
  return null;
}
