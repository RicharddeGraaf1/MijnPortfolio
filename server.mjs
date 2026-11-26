// Serveert de app, haalt koersen op bij Yahoo Finance, dat vanuit een browser niet bereikbaar is
// (geen CORS), en beheert het bestand met je beleggingen op deze pc. De koerscode staat in lib/yahoo.mjs.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, createYahoo } from './lib/yahoo.mjs';
import { validateBackup } from './public/js/core.js';

export { parseChart, parseSearch } from './lib/yahoo.mjs';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('./public', import.meta.url)));
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

const securityHeaders = (quoteService) => ({
  'Content-Security-Policy':
    `default-src 'self'; ${quoteService ? `connect-src 'self' ${quoteService}; ` : ''}` +
    "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
});

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

// Staat er naast het portfoliobestand een instellingen.json met een koersdienst, dan mag de app daar
// koersen ophalen als de pc niet bereikbaar is. Het adres staat buiten de repo, want die is openbaar.
export function readQuoteService(portfolioFile) {
  try {
    const settings = JSON.parse(readFileSync(join(dirname(portfolioFile), 'instellingen.json'), 'utf8'));
    const url = new URL(settings.koersdienst);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

export function createApp({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  retryDelays,
  portfolioFile = process.env.PORTFOLIO_FILE || DEFAULT_PORTFOLIO_FILE,
  quoteService = readQuoteService(portfolioFile),
} = {}) {
  const { quote, search } = createYahoo({ fetchImpl, now, retryDelays });
  const SECURITY_HEADERS = securityHeaders(quoteService);

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
    if (relative === 'index.html' && quoteService) {
      content = content.toString('utf8').replace(
        '<meta charset="utf-8">',
        `<meta charset="utf-8">
  <meta name="koersdienst" content="${quoteService}">`,
      );
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
