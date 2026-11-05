// Zet exports van DEGIRO, Bux en ABN AMRO-transactienota's om naar een portfolio.json voor de app.
// Gebruik: node tools/import.mjs [--out bestand] [--server url] soort:portefeuille:Rekeningnaam=pad ...
//   soort: degiro (Transactions.csv), bux (BUX.csv) of abn (map met pdf-nota's; vereist pdftotext)
//   voorbeeld: node tools/import.mjs "degiro:prive:DEGIRO=exports/deGiro.csv" "abn:zakelijk:ABN AMRO=exports/abn-nota"
// Dividend, rente en abonnementskosten slaat de app niet op en worden overgeslagen.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ledger, validateBackup } from '../public/js/core.js';

// Bij een grotere afwijking tussen jouw prijs en de koers van Yahoo is de ticker waarschijnlijk fout.
const MAX_PRICE_GAP = 0.15;
// Beurscode → achtervoegsel van de ticker bij Yahoo; 'US' betekent zonder achtervoegsel.
const DEGIRO_EXCHANGES = { EAM: 'AS', EPA: 'PA', XET: 'DE', TDG: 'DE', FRA: 'F', MIL: 'MI', LSE: 'L', NDQ: 'US', NSY: 'US' };
// Op beursnaam, niet op plaatsnaam: in de kop van een nota staan ook adressen.
const ABN_EXCHANGES = [[/EURONEXT AMSTERDAM/, 'AS'], [/EURONEXT PARIS/, 'PA'], [/XETRA/, 'DE'], [/NASDAQ|NYSE|KNIGHT/, 'US']];

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell.replace(/\r$/, '')]);
  const [header, ...data] = rows.filter((r) => r.some((value) => value.trim()));
  return data.map((r) => Object.fromEntries(header.map((name, index) => [name.replace(/^﻿/, ''), r[index] ?? ''])));
}

// "1.234,56" en "-12,5" → getal.
const dutchNumber = (text) => Number(String(text).trim().replace(/\./g, '').replace(',', '.'));
const dutchDate = (text) => text.trim().split('-').reverse().join('-');
const round = (value, digits = 6) => Number(value.toFixed(digits));

export function parseDegiro(text) {
  return parseCsv(text).map((row) => {
    const qty = dutchNumber(row.Aantal);
    const valueEur = Math.abs(dutchNumber(row['Waarde EUR']));
    const fee = Math.abs(dutchNumber(row['Transactiekosten en/of kosten van derden EUR'] || '0')) +
      Math.abs(dutchNumber(row['AutoFX Kosten'] || '0'));
    const currencies = Object.entries(row).filter(([name]) => name === '').map(([, value]) => value);
    return {
      isin: row.ISIN,
      name: row.Product,
      exchange: DEGIRO_EXCHANGES[row.Beurs] ?? null,
      type: qty > 0 ? 'buy' : 'sell',
      date: dutchDate(row.Datum),
      qty: Math.abs(qty),
      price: round(valueEur / Math.abs(qty)),
      fee: round(fee, 2),
      localPrice: dutchNumber(row.Koers),
      localCurrency: currencies[0] || 'EUR',
    };
  });
}

export function parseBux(text) {
  const rows = parseCsv(text);
  const orderId = (row) => row['Transaction Description'].replace(/^[^:]*:\s*/, '').trim();
  const fees = rows.filter((row) => row['Transaction Type'] === 'Trading Fee');
  const groups = new Map();
  for (const row of rows.filter((r) => r['Transaction Category'] === 'trades')) {
    groups.set(orderId(row), [...(groups.get(orderId(row)) ?? []), row]);
  }
  const usedFees = new Set();
  const trades = [];
  for (const group of groups.values()) {
    const asset = group.find((row) => row['Transfer Type'].startsWith('ASSET_TRADE'));
    const cash = group.find((row) => row['Transfer Type'].startsWith('CASH'));
    if (!asset || !cash) throw new Error(`Bux: trade zonder bijbehorende geldregel (${asset?.['Asset Id'] ?? 'onbekend'})`);
    const qty = Number(asset['Asset Quantity']);
    const time = asset['Transaction Time (CET)'].slice(0, 19);
    // Kosten staan op een eigen regel, op dezelfde seconde als de trade.
    const fee = fees.find((row) => !usedFees.has(row) && row['Transaction Time (CET)'].slice(0, 19) === time);
    if (fee) usedFees.add(fee);
    trades.push({
      isin: asset['Asset Id'],
      name: asset['Asset Name'],
      exchange: asset['Asset Currency'] === 'USD' ? 'US' : null,
      type: asset['Transfer Type'] === 'ASSET_TRADE_BUY' ? 'buy' : 'sell',
      date: time.slice(0, 10),
      time,
      qty,
      price: round(Math.abs(Number(cash['Transaction Amount'])) / qty),
      fee: fee ? round(Math.abs(Number(fee['Transaction Amount'])), 2) : 0,
      localPrice: Number(asset['Asset Price']),
      localCurrency: asset['Asset Currency'],
    });
  }
  if (usedFees.size !== fees.length) throw new Error(`Bux: ${fees.length - usedFees.size} kostenregel(s) zonder trade`);
  return trades.sort((a, b) => a.time.localeCompare(b.time));
}

// Eén ABN AMRO-transactienota, als tekst uit pdftotext -layout.
export function parseAbnNote(text) {
  const fail = (what) => {
    throw new Error(`ABN-nota: ${what} niet gevonden`);
  };
  if (/Verkoopnota/.test(text)) throw new Error('ABN-nota: verkopen worden nog niet ondersteund');
  const date = text.match(/We kochten voor u op (\d{2}-\d{2}-\d{4})/)?.[1] ?? fail('datum');
  const isin = text.match(/ISIN code:\s*([A-Z]{2}[A-Z0-9]{9}\d)/)?.[1] ?? fail('ISIN');
  const qty = dutchNumber(text.match(/^\s*ST\s+([\d.]+)/m)?.[1] ?? fail('aantal'));
  // De opmaak verschilt per nota, de volgorde van debetbedragen niet: eerst het afrekenbedrag,
  // dan eventuele kosten, als laatste het totaal dat van de rekening ging.
  const debits = [...text.matchAll(/([\d.]+,\d{2})\s*D\b/g)].map((match) => dutchNumber(match[1]));
  const settlement = debits[0];
  const total = debits.at(-1);
  const parts = debits.slice(0, -1).reduce((sum, amount) => sum + amount, 0);
  if (debits.length < 2 || Math.abs(parts - total) > 0.011) fail('kloppende bedragen');
  const usdRate = text.match(/1 EUR = ([\d.]+,\d+) USD/)?.[1];
  const price = settlement / qty;
  const fee = total - settlement;
  const localPrice = usdRate ? price * dutchNumber(usdRate) : price;
  const lines = text.split(/\r?\n/);
  const isinLine = lines.findIndex((line) => line.includes(isin));
  const sameLine = lines[isinLine].split(/Fondscode/)[0].replace(/We kochten.*?(\d{2}:\d{2}:\d{2}|\d{4})/, '').trim();
  const nextLine = lines.slice(isinLine + 1).find((line) => /[A-Za-z]{3}/.test(line))?.trim().split(/\s{2,}/)[0];
  const name = /[A-Za-z]{3}/.test(sameLine) && !/^We kochten/.test(sameLine) ? sameLine.split(/\s{2,}/)[0] : nextLine;
  return {
    isin,
    name: name ?? isin,
    exchange: ABN_EXCHANGES.find(([pattern]) => pattern.test(text))?.[1] ?? null,
    type: 'buy',
    date: dutchDate(date),
    qty,
    price: round(price),
    fee: round(fee, 2),
    localPrice: round(localPrice),
    localCurrency: usdRate ? 'USD' : 'EUR',
  };
}

function readAbnDir(dir) {
  return readdirSync(dir).filter((file) => file.toLowerCase().endsWith('.pdf')).sort().map((file) => {
    const text = execFileSync('pdftotext', ['-layout', join(dir, file), '-'], { encoding: 'utf8' });
    try {
      return parseAbnNote(text);
    } catch (error) {
      throw new Error(`${file}: ${error.message}`);
    }
  });
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
}

// Dichtstbijzijnde slotkoers binnen een week: Yahoo mist soms de dag zelf.
function closeNear(bars, date) {
  const target = Date.parse(date);
  let best = null;
  for (const [day, close] of bars) {
    const distance = Math.abs(Date.parse(day) - target);
    if (distance <= 7 * 86400000 && (!best || distance < best.distance)) best = { distance, close };
  }
  return best?.close ?? null;
}

// Zoekt de ticker bij een ISIN en controleert die tegen de prijs die je zelf betaalde. Alleen
// noteringen van precies dit ISIN komen in aanmerking; een notering in een andere valuta is hetzelfde
// fonds, en de app rekent die koers zelf om naar euro.
async function findSymbol(server, trades) {
  const { isin } = trades[0];
  const exchange = trades.map((trade) => trade.exchange).find(Boolean);
  const currency = trades[trades.length - 1].localCurrency;
  const from = trades[0].date;
  let candidates = [];
  try {
    candidates = await getJson(`${server}/api/search?q=${encodeURIComponent(isin)}`);
  } catch {
    return { symbol: null, problem: 'zoeken bij Yahoo mislukt' };
  }
  const quotes = [];
  for (const candidate of candidates.slice(0, 6)) {
    try {
      quotes.push(await getJson(`${server}/api/quote?symbol=${encodeURIComponent(candidate.symbol)}&from=${from}`));
    } catch {
      // Geen koers: deze notering valt af.
    }
  }
  const suffix = (symbol) => (symbol.includes('.') ? symbol.split('.').pop() : 'US');
  // Eerst de beurs waar je kocht, dan dezelfde valuta, en Stuttgart (.SG, weinig handel) als laatste.
  const rank = (quote) => (suffix(quote.symbol) === exchange ? 0 : 2) + (quote.currency === currency ? 0 : 1) +
    (suffix(quote.symbol) === 'SG' ? 4 : 0);
  for (const quote of quotes.sort((a, b) => rank(a) - rank(b))) {
    let fx = null;
    if (quote.currency !== 'EUR') {
      try {
        fx = (await getJson(`${server}/api/quote?symbol=${quote.currency}EUR%3DX&from=${from}`)).bars;
      } catch {
        continue;
      }
    }
    const gaps = trades.map((trade) => {
      const close = closeNear(quote.bars, trade.date);
      const rate = fx ? closeNear(fx, trade.date) : 1;
      return close && rate ? Math.abs(close * rate - trade.price) / trade.price : null;
    }).filter((gap) => gap != null);
    if (gaps.length && Math.max(...gaps) <= MAX_PRICE_GAP) return { symbol: quote.symbol, name: quote.name };
  }
  return { symbol: null, problem: candidates.length ? 'geen notering met passende koers' : 'ISIN onbekend bij Yahoo' };
}

export function toPosition({ kind, portfolio, account, trades, symbol, name }) {
  const sorted = [...trades].sort((a, b) => (a.time ?? a.date).localeCompare(b.time ?? b.date));
  return {
    id: `${kind}-${account}-${sorted[0].isin}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name: `${name ?? sorted[0].name} (${account})`,
    symbol,
    portfolio,
    manualPrices: [],
    txs: sorted.map((trade, index) => ({
      id: `t${index + 1}`,
      type: trade.type,
      date: trade.date,
      qty: trade.qty,
      price: trade.price,
      fee: trade.fee,
    })),
  };
}

async function main(args) {
  const option = (flag, fallback) => {
    const index = args.indexOf(flag);
    if (index < 0) return fallback;
    const [, value] = args.splice(index, 2);
    return value;
  };
  const out = resolve(option('--out', join(homedir(), 'Documents', 'MijnPortfolio', 'portfolio.json')));
  const server = option('--server', 'http://localhost:3847');
  if (!args.length) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 5).join('\n'));
    process.exit(1);
  }

  const positions = [];
  const report = [];
  for (const source of args) {
    const match = source.match(/^(degiro|bux|abn):(prive|zakelijk):([^=]+)=(.+)$/);
    if (!match) throw new Error(`Onbekende bron: ${source}`);
    const [, kind, portfolio, account, path] = match;
    const trades = kind === 'abn' ? readAbnDir(path)
      : kind === 'bux' ? parseBux(readFileSync(path, 'utf8')) : parseDegiro(readFileSync(path, 'utf8'));
    const byIsin = new Map();
    for (const trade of trades) byIsin.set(trade.isin, [...(byIsin.get(trade.isin) ?? []), trade]);
    for (const group of byIsin.values()) {
      const found = await findSymbol(server, group);
      const position = toPosition({ kind, portfolio, account, trades: group, ...found });
      positions.push(position);
      const { qty } = ledger(position.txs);
      report.push(`${account}: ${position.name} → ${found.symbol ?? `ZONDER TICKER (${found.problem})`}, ${position.txs.length} transacties${qty > 1e-9 ? '' : ', volledig verkocht'}`);
    }
  }

  const data = { version: 1, positions, exportedAt: new Date().toISOString() };
  const problem = validateBackup(data);
  if (problem) throw new Error(`Resultaat klopt niet: ${problem}`);
  // Een bestaand bestand nooit overschrijven: dat kan wijzigingen uit de app bevatten.
  const target = existsSync(out) ? out.replace(/\.json$/, `-import-${Date.now()}.json`) : out;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(data, null, 2));
  console.log(report.sort().join('\n'));
  console.log(`\n${positions.length} posities geschreven naar ${target}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
