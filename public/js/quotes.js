// Haalt koersen op via onze eigen server en onthoudt ze, zodat de app ook offline werkt.
import { fxSymbol, toDay, todayIso } from './core.js';

const CACHE_KEY = 'mijnportfolio.quotes.v1';
const FRESH_MS = 15 * 60 * 1000;

let cache = load();

function load() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function persist() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Vol geheugen: de koersen blijven in deze sessie bruikbaar en worden volgende keer opnieuw opgehaald.
    localStorage.removeItem(CACHE_KEY);
  }
}

export const quotes = () => cache;

export function lastFetchedAt() {
  const times = Object.values(cache).map((quote) => quote.fetchedAt).filter(Boolean);
  return times.length ? times.sort().at(-1) : null;
}

async function getJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    const error = new Error(`Status ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function fetchQuote(symbol, from) {
  const quote = await getJson(`/api/quote?symbol=${encodeURIComponent(symbol)}&from=${from}`);
  return {
    symbol,
    from,
    name: quote.name,
    currency: quote.currency,
    price: quote.price,
    time: quote.time,
    fetchedAt: new Date().toISOString(),
    bars: quote.bars.map(([date, close]) => [toDay(date), close]),
  };
}

function isFresh(quote, from, force) {
  return !force && quote && quote.from <= from && Date.now() - Date.parse(quote.fetchedAt) < FRESH_MS;
}

// Ververst alle koersen en wisselkoersen. Lukt het voor een ticker niet, dan blijft de vorige koers staan.
export async function refreshQuotes(positions, { force = false } = {}) {
  const earliest = new Map();
  for (const position of positions) {
    if (!position.symbol) continue;
    const first = position.txs.map((tx) => tx.date).sort()[0];
    const known = earliest.get(position.symbol);
    earliest.set(position.symbol, known && known < first ? known : first);
  }

  const failed = [];
  const update = async (symbol, from) => {
    if (isFresh(cache[symbol], from, force)) return;
    try {
      cache[symbol] = await fetchQuote(symbol, from);
    } catch {
      failed.push(symbol);
    }
  };
  await Promise.all([...earliest].map(([symbol, from]) => update(symbol, from)));

  // Pas na de koersen weten we welke valuta's nodig zijn.
  const firstOverall = [...earliest.values()].sort()[0] ?? todayIso();
  const pairs = new Set();
  for (const symbol of earliest.keys()) {
    const pair = fxSymbol(cache[symbol]?.currency);
    if (pair) pairs.add(pair);
  }
  await Promise.all([...pairs].map((pair) => update(pair, firstOverall)));

  persist();
  return { failed };
}

export async function searchSymbols(query) {
  return getJson(`/api/search?q=${encodeURIComponent(query)}`);
}

export function peekQuote(symbol) {
  return fetchQuote(symbol, todayIso());
}
