import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createApp, parseChart, parseSearch } from '../server.mjs';

const CHART = {
  chart: {
    result: [{
      meta: {
        symbol: 'VWRL.AS', longName: 'Vanguard All-World', currency: 'EUR', gmtoffset: 3600,
        regularMarketPrice: 120.5, regularMarketTime: 1762100000,
      },
      timestamp: [1762000000, 1762086400, 1762172800],
      indicators: { quote: [{ close: [118.123456789, null, 120.5] }] },
    }],
  },
};

let server;
let base;
let upstreamCalls;

before(async () => {
  upstreamCalls = [];
  const fetchImpl = async (url) => {
    upstreamCalls.push(url);
    if (url.includes('/NOPE')) return new Response('{}', { status: 404 });
    if (url.includes('/DOWN')) return new Response('{}', { status: 503 });
    if (url.includes('/THROW')) throw new Error('netwerk weg');
    if (url.includes('/FLAKY') && upstreamCalls.filter((u) => u.includes('/FLAKY')).length === 1) {
      return new Response('', { status: 429 });
    }
    if (url.includes('/search')) {
      return Response.json({ quotes: [{ symbol: 'VWRL.AS', quoteType: 'ETF', longname: 'Vanguard', exchDisp: 'Amsterdam' }] });
    }
    return Response.json(CHART);
  };
  server = createServer(createApp({ fetchImpl, retryDelays: [0, 0], quoteService: null }));
  await new Promise((done) => server.listen(0, done));
  base = `http://localhost:${server.address().port}`;
});

after(() => server.close());

test('parseChart slaat lege koersen over en houdt de beursdag aan', () => {
  const quote = parseChart(CHART);
  assert.equal(quote.bars.length, 2);
  assert.equal(quote.bars[0][1], 118.123457);
  assert.match(quote.bars[0][0], /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(quote.currency, 'EUR');
  assert.equal(parseChart({ chart: { result: null } }), null);
});

test('parseSearch laat opties en futures weg', () => {
  const results = parseSearch({
    quotes: [
      { symbol: 'A', quoteType: 'EQUITY', shortname: 'Aandeel', exchDisp: 'AMS' },
      { symbol: 'B', quoteType: 'OPTION' },
      { symbol: 'C', quoteType: 'FUTURE' },
    ],
  });
  assert.deepEqual(results.map((r) => r.symbol), ['A']);
});

test('quote geeft koersen terug en cachet per ticker en datum', async () => {
  const url = `${base}/api/quote?symbol=VWRL.AS&from=2024-01-01`;
  const first = await fetch(url);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).symbol, 'VWRL.AS');
  const count = upstreamCalls.length;
  await fetch(url);
  assert.equal(upstreamCalls.length, count);
});

test('quote weigert ongeldige invoer zonder Yahoo te bellen', async () => {
  const count = upstreamCalls.length;
  for (const query of ['symbol=../../etc&from=2024-01-01', 'symbol=A%20B&from=2024-01-01', 'symbol=A&from=gisteren', 'from=2024-01-01']) {
    assert.equal((await fetch(`${base}/api/quote?${query}`)).status, 400, query);
  }
  assert.equal(upstreamCalls.length, count);
});

test('fouten van de koersbron worden nette statussen', async () => {
  assert.equal((await fetch(`${base}/api/quote?symbol=NOPE&from=2024-01-01`)).status, 404);
  assert.equal((await fetch(`${base}/api/quote?symbol=DOWN&from=2024-01-01`)).status, 502);
  assert.equal((await fetch(`${base}/api/quote?symbol=THROW&from=2024-01-01`)).status, 502);
});

test('een weigering van Yahoo krijgt een tweede kans', async () => {
  const response = await fetch(`${base}/api/quote?symbol=FLAKY&from=2024-01-01`);
  assert.equal(response.status, 200);
  assert.equal(upstreamCalls.filter((url) => url.includes('/FLAKY')).length, 2);
});

test('een blijvende weigering stopt na de herkansingen', async () => {
  const before = upstreamCalls.filter((url) => url.includes('/DOWN2')).length;
  assert.equal((await fetch(`${base}/api/quote?symbol=DOWN2&from=2024-01-01`)).status, 502);
  assert.equal(upstreamCalls.filter((url) => url.includes('/DOWN2')).length - before, 3);
});

test('search werkt en weigert te korte termen', async () => {
  assert.equal((await fetch(`${base}/api/search?q=a`)).status, 400);
  const response = await fetch(`${base}/api/search?q=vwrl`);
  assert.deepEqual((await response.json()).map((r) => r.symbol), ['VWRL.AS']);
});

test('statische bestanden kunnen niet buiten public komen', async () => {
  for (const path of ['/..%2f..%2fserver.mjs', '/..%2fpackage.json', '/%2e%2e/server.mjs', '/..%5cserver.mjs']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
  assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
});

test('alleen GET en HEAD zijn toegestaan', async () => {
  assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
});

// ---------- Bestand op de pc ----------

const GOOD_FILE = { version: 1, positions: [{ id: 'a', name: 'A', portfolio: 'prive', txs: [{ type: 'buy', date: '2024-01-01', qty: 1, price: 10 }] }] };

// Via http.request, omdat fetch de Host-header niet laat overschrijven.
function call(port, method, headers = {}, body) {
  return new Promise((done, fail) => {
    const req = request({ port, method, path: '/api/portfolio', headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => done({ status: res.statusCode, etag: res.headers.etag, text }));
    });
    req.on('error', fail);
    req.end(body);
  });
}

async function withPortfolioServer(run) {
  const dir = await mkdtemp(join(tmpdir(), 'portfolio-'));
  const file = join(dir, 'sub', 'portfolio.json');
  const app = createServer(createApp({ portfolioFile: file }));
  await new Promise((done) => app.listen(0, done));
  try {
    await run({ port: app.address().port, file });
  } finally {
    app.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const JSON_TYPE = { 'Content-Type': 'application/json' };
const LOCAL = 'localhost:3000';
const PHONE = 'mijn-pc.tail0000.ts.net';

test('portfolio: opslaan op de pc en ophalen via Tailscale geven hetzelfde bestand', () => withPortfolioServer(async ({ port }) => {
  assert.equal((await call(port, 'GET', { Host: PHONE })).status, 404);
  const saved = await call(port, 'PUT', { Host: LOCAL, ...JSON_TYPE }, JSON.stringify(GOOD_FILE));
  assert.equal(saved.status, 200);
  const read = await call(port, 'GET', { Host: PHONE, 'X-Forwarded-For': '100.1.2.3' });
  assert.equal(read.status, 200);
  assert.equal(read.etag, saved.etag);
  assert.deepEqual(JSON.parse(read.text), GOOD_FILE);
}));

test('portfolio: alleen de pc zelf mag schrijven, vreemde hosts mogen niets', () => withPortfolioServer(async ({ port, file }) => {
  const body = JSON.stringify(GOOD_FILE);
  assert.equal((await call(port, 'PUT', { Host: PHONE, ...JSON_TYPE }, body)).status, 403);
  assert.equal((await call(port, 'PUT', { Host: LOCAL, 'X-Forwarded-For': '100.1.2.3', ...JSON_TYPE }, body)).status, 403);
  assert.equal((await call(port, 'PUT', { Host: LOCAL, Origin: 'https://evil.example', ...JSON_TYPE }, body)).status, 403);
  assert.equal((await call(port, 'PUT', { Host: 'evil.example', ...JSON_TYPE }, body)).status, 403);
  assert.equal((await call(port, 'PUT', { Host: LOCAL, 'Content-Type': 'text/plain' }, body)).status, 415);
  await assert.rejects(readFile(file));
  assert.equal((await call(port, 'PUT', { Host: LOCAL, Origin: `http://${LOCAL}`, ...JSON_TYPE }, body)).status, 200);
  assert.equal((await call(port, 'GET', { Host: 'evil.example' })).status, 403);
}));

test('portfolio: een ongeldig bestand wordt geweigerd en het oude blijft staan', () => withPortfolioServer(async ({ port, file }) => {
  await call(port, 'PUT', { Host: LOCAL, ...JSON_TYPE }, JSON.stringify(GOOD_FILE));
  const version = (await call(port, 'GET', { Host: LOCAL })).etag;
  for (const bad of ['{kapot', JSON.stringify({ positions: [{ id: 'a' }] })]) {
    assert.equal((await call(port, 'PUT', { Host: LOCAL, 'If-Match': version, ...JSON_TYPE }, bad)).status, 400);
  }
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), GOOD_FILE);
}));

test('portfolio: opslaan overschrijft geen wijziging van buiten de app en bewaart de vorige versie', () => withPortfolioServer(async ({ port, file }) => {
  const first = await call(port, 'PUT', { Host: LOCAL, ...JSON_TYPE }, JSON.stringify(GOOD_FILE));
  const second = { ...GOOD_FILE, exportedAt: '2026-11-04' };
  assert.equal((await call(port, 'PUT', { Host: LOCAL, ...JSON_TYPE }, JSON.stringify(second))).status, 412);
  const ok = await call(port, 'PUT', { Host: LOCAL, 'If-Match': first.etag, ...JSON_TYPE }, JSON.stringify(second));
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(await readFile(`${file}.bak`, 'utf8')), GOOD_FILE);

  await writeFile(file, JSON.stringify(GOOD_FILE));
  assert.equal((await call(port, 'PUT', { Host: LOCAL, 'If-Match': ok.etag, ...JSON_TYPE }, JSON.stringify(second))).status, 412);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), GOOD_FILE);
}));
