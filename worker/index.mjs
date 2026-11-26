// Koersdienst voor als de telefoon de pc niet kan bereiken, bijvoorbeeld in een ander tailnet.
// Geeft alleen koersen en zoekresultaten van Yahoo door; je beleggingen komen hier nooit langs.
// Uitrollen: npx wrangler deploy (in deze map). Het adres gaat in instellingen.json op de pc, zie README.
import { HttpError, createYahoo } from '../lib/yahoo.mjs';

// Alleen de app zelf: via Tailscale (https://<pc>.<tailnet>.ts.net) of lokaal op de pc.
const APP_ORIGIN = /^(https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.ts\.net|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/i;

const yahoo = createYahoo();

const json = (status, body, headers) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') ?? '';
    const allowed = APP_ORIGIN.test(origin);
    const headers = { Vary: 'Origin', 'X-Content-Type-Options': 'nosniff', ...(allowed && { 'Access-Control-Allow-Origin': origin }) };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } });
    }
    try {
      if (!allowed) throw new HttpError(403, 'Niet toegestaan');
      if (request.method !== 'GET') throw new HttpError(405, 'Niet toegestaan');
      const url = new URL(request.url);
      const api = { '/api/quote': yahoo.quote, '/api/search': yahoo.search }[url.pathname];
      if (!api) throw new HttpError(404, 'Niet gevonden');
      return json(200, await api(url.searchParams), headers);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      return json(status, { error: status === 500 ? 'Serverfout' : error.message }, headers);
    }
  },
};
