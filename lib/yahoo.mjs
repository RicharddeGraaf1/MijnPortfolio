// Koersen en zoeken bij Yahoo Finance. Gedeeld door de server op de pc en de koersdienst in worker/,
// dus zonder Node-specifieke imports.
const YAHOO = 'https://query1.finance.yahoo.com';
const YAHOO_HEADERS = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.9' };
// Yahoo is een onofficiële bron en weigert af en toe een verzoek (429); een tweede poging lukt meestal.
const RETRY_DELAYS_MS = [400, 1200];
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const UPSTREAM_PER_MINUTE = 120;
const SEARCH_TYPES = new Set(['EQUITY', 'ETF', 'MUTUALFUND', 'CRYPTOCURRENCY', 'INDEX']);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const round = (value) => Number(value.toFixed(6));

// Yahoo geeft tijdstempels in UTC; de beursdag volgt uit de tijdzone van de beurs.
function exchangeDate(timestamp, gmtoffset = 0) {
  return new Date((timestamp + gmtoffset) * 1000).toISOString().slice(0, 10);
}

export function parseChart(json) {
  const result = json?.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta) return null;
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const bars = [];
  (result.timestamp ?? []).forEach((timestamp, index) => {
    const close = closes[index];
    if (close != null) bars.push([exchangeDate(timestamp, meta.gmtoffset), round(close)]);
  });
  return {
    symbol: meta.symbol,
    name: meta.longName ?? meta.shortName ?? meta.symbol,
    currency: meta.currency ?? null,
    price: meta.regularMarketPrice ?? null,
    time: meta.regularMarketTime ? exchangeDate(meta.regularMarketTime, meta.gmtoffset) : null,
    fetchedAt: new Date().toISOString(),
    bars,
  };
}

export function parseSearch(json) {
  return (json?.quotes ?? [])
    .filter((quote) => quote.symbol && SEARCH_TYPES.has(quote.quoteType))
    .map((quote) => ({
      symbol: quote.symbol,
      name: quote.longname ?? quote.shortname ?? quote.symbol,
      exchange: quote.exchDisp ?? '',
      type: quote.typeDisp ?? '',
    }));
}

// fetch wordt pas bij elk verzoek opgezocht, zodat tests de standaard-fetch kunnen vervangen.
export function createYahoo({ fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now, retryDelays = RETRY_DELAYS_MS } = {}) {
  const cache = new Map();
  let windowStart = now();
  let upstreamCalls = 0;

  async function callYahoo(url) {
    for (let attempt = 0; ; attempt += 1) {
      if (now() - windowStart > 60_000) {
        windowStart = now();
        upstreamCalls = 0;
      }
      if (++upstreamCalls > UPSTREAM_PER_MINUTE) throw new HttpError(429, 'Te veel verzoeken');

      let response = null;
      try {
        response = await fetchImpl(url, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(8000) });
      } catch {
        // Netwerkfout: valt hieronder onder dezelfde herkansing als een 429 of 5xx.
      }
      const retryable = !response || response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= retryDelays.length) {
        if (!response) throw new HttpError(502, 'Koersbron niet bereikbaar');
        return response;
      }
      await new Promise((done) => setTimeout(done, retryDelays[attempt]));
    }
  }

  async function upstream(url, parse) {
    const cached = cache.get(url);
    if (cached && now() - cached.at < CACHE_TTL_MS) return cached.body;

    const response = await callYahoo(url);
    if (response.status === 404) throw new HttpError(404, 'Onbekende ticker');
    if (!response.ok) throw new HttpError(502, `Koersbron gaf status ${response.status}`);

    const body = parse(await response.json());
    if (!body) throw new HttpError(404, 'Onbekende ticker');
    if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(url, { at: now(), body });
    return body;
  }

  function quote(params) {
    const symbol = params.get('symbol') ?? '';
    const from = params.get('from') ?? '';
    if (!/^[A-Za-z0-9.\-=^]{1,20}$/.test(symbol)) throw new HttpError(400, 'Ongeldige ticker');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(Date.parse(from))) {
      throw new HttpError(400, 'Ongeldige datum');
    }
    const period1 = Math.floor(Date.parse(from) / 1000);
    // Afgerond op de cachetijd, zodat herhaalde verzoeken dezelfde cachesleutel krijgen.
    const period2 = Math.ceil(now() / CACHE_TTL_MS) * (CACHE_TTL_MS / 1000);
    return upstream(
      `${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`,
      parseChart,
    );
  }

  function search(params) {
    const q = (params.get('q') ?? '').trim();
    if (q.length < 2 || q.length > 40) throw new HttpError(400, 'Zoekterm moet 2 tot 40 tekens zijn');
    return upstream(
      `${YAHOO}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0`,
      parseSearch,
    );
  }

  return { quote, search };
}
