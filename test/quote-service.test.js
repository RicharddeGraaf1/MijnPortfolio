import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp, readQuoteService } from '../server.mjs';
import worker from '../worker/index.mjs';

const SERVICE = 'https://koersen.voorbeeld.workers.dev';

async function withServer(options, run) {
  const server = createServer(createApp({ fetchImpl: async () => new Response('{}', { status: 404 }), ...options }));
  await new Promise((done) => server.listen(0, done));
  try {
    await run(`http://localhost:${server.address().port}`);
  } finally {
    server.close();
  }
}

test('readQuoteService leest alleen een https-adres uit instellingen.json naast het portfolio', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mp-instellingen-'));
  const file = join(dir, 'portfolio.json');
  try {
    assert.equal(readQuoteService(file), null);
    await writeFile(join(dir, 'instellingen.json'), JSON.stringify({ koersdienst: `${SERVICE}/pad?x=1` }));
    assert.equal(readQuoteService(file), SERVICE);
    await writeFile(join(dir, 'instellingen.json'), JSON.stringify({ koersdienst: 'http://onveilig.example' }));
    assert.equal(readQuoteService(file), null);
    await writeFile(join(dir, 'instellingen.json'), 'geen json');
    assert.equal(readQuoteService(file), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('met een koersdienst staat het adres in de pagina en mag de app ermee verbinden', () =>
  withServer({ quoteService: SERVICE }, async (base) => {
    const page = await fetch(`${base}/`);
    assert.match(await page.text(), new RegExp(`<meta name="koersdienst" content="${SERVICE}">`));
    assert.match(page.headers.get('content-security-policy'), new RegExp(`connect-src 'self' ${SERVICE};`));
  }));

test('zonder koersdienst blijft alles bij de pc', () =>
  withServer({ quoteService: null }, async (base) => {
    const page = await fetch(`${base}/`);
    assert.doesNotMatch(await page.text(), /koersdienst/);
    assert.doesNotMatch(page.headers.get('content-security-policy'), /connect-src/);
  }));

test('koersdienst: alleen de app mag hem gebruiken, en alleen voor koersen en zoeken', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(url); return Response.json({ chart: { result: [{ meta: { symbol: 'AMD', currency: 'USD' }, timestamp: [], indicators: { quote: [{ close: [] }] } }] } }); };
  try {
    const call = (path, origin, method = 'GET') =>
      worker.fetch(new Request(`https://koersen.test${path}`, { method, headers: origin ? { Origin: origin } : {} }));
    const app = 'https://mijn-pc.tail0000.ts.net';

    const ok = await call('/api/quote?symbol=AMD&from=2026-01-01', app);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), app);
    assert.equal((await ok.json()).symbol, 'AMD');

    assert.equal((await call('/api/quote?symbol=AMD&from=2026-01-01', 'https://andere-site.example')).status, 403);
    assert.equal((await call('/api/quote?symbol=AMD&from=2026-01-01', null)).status, 403);
    assert.equal((await call('/api/portfolio', app)).status, 404);
    assert.equal((await call('/api/quote?symbol=../x&from=2026-01-01', app)).status, 400);
    assert.equal((await call('/api/quote', app, 'POST')).status, 405);
    assert.equal((await call('/api/quote', app, 'OPTIONS')).status, 204);
    assert.equal((await call('/api/quote?symbol=AMD&from=2026-01-01', 'http://localhost:3847')).status, 200);
    assert.ok(calls.length > 0 && calls.every((u) => u.startsWith('https://query1.finance.yahoo.com/')));
  } finally {
    globalThis.fetch = original;
  }
});
