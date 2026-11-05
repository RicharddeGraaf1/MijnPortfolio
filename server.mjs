// Serveert de app, haalt koersen op bij Yahoo Finance, dat vanuit een browser niet bereikbaar is
// (geen CORS), en beheert het bestand met je beleggingen op deze pc.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBackup } from './public/js/core.js';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('./public', import.meta.url)));
const YAHOO = 'https://query1.finance.yahoo.com';
const YAHOO_HEADERS = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.9' };
// Yahoo is een onofficiële bron en weigert af en toe een verzoek (429); een tweede poging lukt meestal.
const RETRY_DELAYS_MS = [400, 1200];
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const UPSTREAM_PER_MINUTE = 120;
const SEARCH_TYPES = new Set(['EQUITY', 'ETF', 'MUTUALFUND', 'CRYPTOCURRENCY', 'INDEX']);
const DEFAULT_PORTFOLIO_FILE = join(homedir(), 'Documents', 'MijnPortfolio', 'portfolio.json');
const PORTFOLIO_MAX_BYTES = 5 * 1024 * 1024;

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const round = (value) => Number(value.toFixed(6));

const fileVersion = (content) => `"${createHash('sha256').update(content).digest('hex')}"`;

// tailscale serve zet X-Forwarded-For; daaraan is te zien dat een verzoek niet van deze pc zelf komt.
const isOnThisPc = (req) =>
  /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(req.headers.host ?? '') && !req.headers['x-forwarded-for'];
const isOnTailnet = (req) => /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net(:\d+)?$/i.test(req.headers.host ?? '');

async function readIfExists(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > PORTFOLIO_MAX_BYTES) throw new HttpError(413, 'Dit bestand is te groot');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

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

export function createApp({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  retryDelays = RETRY_DELAYS_MS,
  portfolioFile = process.env.PORTFOLIO_FILE || DEFAULT_PORTFOLIO_FILE,
} = {}) {
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

  // De host-controle houdt websites buiten die via een eigen domeinnaam bij deze server proberen te komen.
  async function readPortfolio(req, res) {
    if (!isOnThisPc(req) && !isOnTailnet(req)) throw new HttpError(403, 'Niet toegestaan');
    const content = await readIfExists(portfolioFile);
    if (!content) throw new HttpError(404, 'Er staat nog geen bestand op je pc');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ETag: fileVersion(content),
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  }

  async function writePortfolio(req, res) {
    const { origin, host } = req.headers;
    if (!isOnThisPc(req) || (origin && origin !== `http://${host}`)) {
      throw new HttpError(403, 'Opslaan kan alleen op de pc zelf');
    }
    if (!/^application\/json/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Verwacht JSON');
    let parsed;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, 'Dit is geen geldig bestand');
    }
    const problem = validateBackup(parsed);
    if (problem) throw new HttpError(400, problem);

    const current = await readIfExists(portfolioFile);
    // Is het bestand buiten de app om gewijzigd, dan mag opslaan die wijziging niet overschrijven.
    if (current && req.headers['if-match'] !== fileVersion(current)) {
      throw new HttpError(412, 'Het bestand op je pc is gewijzigd');
    }
    const content = JSON.stringify(parsed, null, 2);
    await mkdir(dirname(portfolioFile), { recursive: true });
    if (current) await writeFile(`${portfolioFile}.bak`, current);
    await writeFile(`${portfolioFile}.tmp`, content);
    await rename(`${portfolioFile}.tmp`, portfolioFile);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ETag: fileVersion(content),
    });
    res.end('{}');
  }

  async function serveStatic(pathname, res, method) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'Ongeldig pad');
    }
    const relative = decoded === '/' ? 'index.html' : normalize(decoded).replace(/^[/\\]+/, '');
    const file = join(PUBLIC_DIR, relative);
    if (!file.startsWith(PUBLIC_DIR + sep)) throw new HttpError(404, 'Niet gevonden');
    let content;
    try {
      content = await readFile(file);
    } catch {
      throw new HttpError(404, 'Niet gevonden');
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(method === 'HEAD' ? undefined : content);
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/portfolio' && req.method === 'PUT') return await writePortfolio(req, res);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Niet toegestaan');
      if (url.pathname === '/api/portfolio') return await readPortfolio(req, res);
      const api = { '/api/quote': quote, '/api/search': search }[url.pathname];
      if (api) {
        const body = await api(url.searchParams);
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(body));
      } else {
        await serveStatic(url.pathname, res, req.method);
      }
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: status === 500 ? 'Serverfout' : error.message }));
    }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  // Standaard alleen vanaf deze pc bereikbaar; de telefoon komt binnen via Tailscale.
  const host = process.env.HOST || '127.0.0.1';
  createServer(createApp()).listen(port, host, () => console.log(`Mijn Portfolio luistert op ${host}:${port}`));
}
