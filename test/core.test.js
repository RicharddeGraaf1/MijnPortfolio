import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  asOf, breakdownSeries, fromDay, fxSymbol, ledger, monthlyRows, parseNumber, pricePoints, rangeStart, summarize,
  toDay, totals, unitSeries, validateBackup, valueSeries,
} from '../public/js/core.js';

const buy = (date, qty, price, fee = 0) => ({ type: 'buy', date, qty, price, fee });
const sell = (date, qty, price, fee = 0) => ({ type: 'sell', date, qty, price, fee });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} ≠ ${expected}`);

test('parseNumber leest Nederlandse en Engelse notatie', () => {
  assert.equal(parseNumber('12,5'), 12.5);
  assert.equal(parseNumber('12.5'), 12.5);
  assert.equal(parseNumber('1.234,56'), 1234.56);
  assert.equal(parseNumber('€ 1.000,00'), 1000);
  assert.equal(parseNumber(',5'), 0.5);
  assert.equal(parseNumber('0.125'), 0.125);
  assert.equal(parseNumber('5.40'), 5.4);
  assert.ok(Number.isNaN(parseNumber('5.400')), 'dubbelzinnig: 5400 of 5,4');
  assert.ok(Number.isNaN(parseNumber('')));
  assert.ok(Number.isNaN(parseNumber('abc')));
  assert.ok(Number.isNaN(parseNumber('1,234,567')));
  assert.ok(Number.isNaN(parseNumber('-5')));
});

test('datums gaan heen en terug, ook over een schrikkeldag', () => {
  for (const iso of ['2024-02-29', '2026-11-02', '1999-12-31']) assert.equal(fromDay(toDay(iso)), iso);
});

test('ledger telt kosten mee in de kostprijs', () => {
  const result = ledger([buy('2024-01-01', 10, 100, 5)]);
  assert.equal(result.qty, 10);
  assert.equal(result.cost, 1005);
});

test('ledger rekent verkoop af tegen de gemiddelde kostprijs', () => {
  const result = ledger([
    buy('2024-01-01', 10, 100),
    buy('2024-02-01', 10, 200),
    sell('2024-03-01', 5, 300, 10),
  ]);
  assert.equal(result.qty, 15);
  close(result.cost, 2250);
  close(result.realized, 5 * 300 - 10 - 750);
});

test('ledger komt op nul uit na alles verkopen, ook met breuken', () => {
  const result = ledger([buy('2024-01-01', 0.1, 10), buy('2024-01-02', 0.2, 10), sell('2024-01-03', 0.3, 20)]);
  assert.equal(result.qty, 0);
  assert.equal(result.cost, 0);
  close(result.realized, 3);
});

test('ledger signaleert verkoop van meer dan je hebt', () => {
  assert.equal(ledger([buy('2024-02-01', 1, 10), sell('2024-01-01', 1, 10)]).oversold, '2024-01-01');
  assert.equal(ledger([buy('2024-01-01', 1, 10), sell('2024-01-01', 1, 10)]).oversold, null);
});

test('asOf neemt de laatste waarde op of vóór de dag', () => {
  const points = [[10, 'a'], [20, 'b'], [30, 'c']];
  assert.equal(asOf(points, 5), null);
  assert.equal(asOf(points, 10), 'a');
  assert.equal(asOf(points, 25), 'b');
  assert.equal(asOf(points, 99), 'c');
});

test('fxSymbol noemt het juiste valutapaar', () => {
  assert.equal(fxSymbol('EUR'), null);
  assert.equal(fxSymbol('USD'), 'USDEUR=X');
  assert.equal(fxSymbol('GBp'), 'GBPEUR=X');
  assert.equal(fxSymbol('GBX'), 'GBPEUR=X');
});

test('pricePoints: handmatig gaat boven markt, markt boven transactie', () => {
  const position = {
    symbol: 'X',
    txs: [buy('2024-01-01', 1, 90), buy('2024-01-02', 1, 91)],
    manualPrices: [{ date: '2024-01-03', price: 200 }],
  };
  const d = toDay;
  const quotes = {
    X: { currency: 'EUR', price: null, time: null, bars: [[d('2024-01-02'), 100], [d('2024-01-03'), 101]] },
  };
  const { points } = pricePoints(position, quotes);
  assert.deepEqual(points, [
    [d('2024-01-01'), 90, 'transactie'],
    [d('2024-01-02'), 100, 'markt'],
    [d('2024-01-03'), 200, 'handmatig'],
  ]);
});

test('pricePoints rekent dollars en pence om met de koers van die dag', () => {
  const d = toDay('2024-01-02');
  const fx = { price: 0.8, bars: [[d, 0.9]] };
  const position = { symbol: 'X', txs: [buy('2024-01-01', 1, 1)] };
  const usd = pricePoints(position, { X: { currency: 'USD', bars: [[d, 100]] }, 'USDEUR=X': fx });
  close(usd.points.at(-1)[1], 90);
  const pence = pricePoints(position, { X: { currency: 'GBp', bars: [[d, 1000]] }, 'GBPEUR=X': { bars: [[d, 1.2]] } });
  close(pence.points.at(-1)[1], 12);
});

test('zonder wisselkoers telt een buitenlandse koers niet mee', () => {
  const position = { symbol: 'X', txs: [buy('2024-01-01', 1, 50)] };
  const summary = summarize(position, { X: { currency: 'USD', bars: [[toDay('2024-06-01'), 100]] } });
  assert.equal(summary.fxMissing, true);
  assert.equal(summary.price, 50);
});

test('summarize geeft waarde, winst en percentage', () => {
  const position = { txs: [buy('2024-01-01', 10, 100)], manualPrices: [{ date: '2024-06-01', price: 150 }] };
  const summary = summarize(position, {});
  assert.equal(summary.value, 1500);
  assert.equal(summary.gain, 500);
  close(summary.gainPct, 0.5);
  assert.equal(summary.priceSource, 'handmatig');
  assert.equal(summary.closed, false);
});

test('een volledig verkochte belegging heeft geen waarde meer maar wel resultaat', () => {
  const summary = summarize({ txs: [buy('2024-01-01', 10, 100), sell('2024-02-01', 10, 120)] }, {});
  assert.equal(summary.closed, true);
  assert.equal(summary.value, 0);
  assert.equal(summary.gain, 0);
  assert.equal(summary.gainPct, null);
  assert.equal(summary.realized, 200);
});

test('totals telt beleggingen op en laat percentage vallen zonder kostprijs', () => {
  const result = totals([{ value: 150, cost: 100, realized: 5 }, { value: 50, cost: 100, realized: 0 }]);
  assert.equal(result.value, 200);
  assert.equal(result.gain, 0);
  assert.equal(result.gainPct, 0);
  assert.equal(totals([]).gainPct, null);
});

test('rangeStart gaat kalendermaanden terug; Alles heeft geen begin', () => {
  assert.equal(fromDay(rangeStart('1M', '2026-03-15')), '2026-02-15');
  assert.equal(fromDay(rangeStart('1J', '2026-03-15')), '2025-03-15');
  assert.equal(rangeStart('Alles', '2026-03-15'), null);
});

test('valueSeries volgt aantal en koers door de tijd', () => {
  const d = toDay;
  const position = {
    txs: [buy('2024-01-01', 10, 100), sell('2024-01-03', 5, 120)],
    points: [[d('2024-01-01'), 100], [d('2024-01-02'), 110], [d('2024-01-03'), 120], [d('2024-01-04'), 130]],
  };
  const series = valueSeries([position], { to: d('2024-01-04') });
  assert.deepEqual(series.map((p) => p.value), [1000, 1100, 600, 650]);
  assert.deepEqual(series.map((p) => p.cost), [1000, 1000, 500, 500]);
});

test('valueSeries begint niet vóór de eerste aankoop en eindigt altijd op de laatste dag', () => {
  const d = toDay;
  const position = { txs: [buy('2024-01-10', 1, 100)], points: [[d('2024-01-10'), 100]] };
  const series = valueSeries([position], { from: d('2023-01-01'), to: d('2024-12-31'), maxPoints: 10 });
  assert.equal(series[0].day, d('2024-01-10'));
  assert.equal(series.at(-1).day, d('2024-12-31'));
  assert.ok(series.length <= 12);
});

test('valueSeries is leeg zonder beleggingen', () => {
  assert.deepEqual(valueSeries([], { to: 100 }), []);
});

test('breakdownSeries geeft per groep de waarde, en samen het totaal', () => {
  const d = toDay;
  const a = { txs: [buy('2024-01-01', 2, 10)], points: [[d('2024-01-01'), 10], [d('2024-01-03'), 15]] };
  const b = { txs: [buy('2024-01-02', 1, 50)], points: [[d('2024-01-02'), 50]] };
  const c = { txs: [buy('2024-01-03', 1, 20)], points: [[d('2024-01-03'), 20]] };
  const series = breakdownSeries([[a], [b, c]], { to: d('2024-01-03') });
  assert.deepEqual(series.map((p) => p.parts), [[20, 0], [20, 50], [30, 70]]);
  assert.deepEqual(series.map((p) => p.value), [20, 70, 100]);
  assert.deepEqual(series.map((p) => p.costs), [[20, 0], [20, 50], [20, 70]]);
  assert.deepEqual(series.map((p) => p.cost), [20, 70, 90]);
  assert.deepEqual(series.map((p) => p.day), valueSeries([a, b, c], { to: d('2024-01-03') }).map((p) => p.day));
});

test('unitSeries geeft koers en gemiddelde aankoopprijs, en slaat dagen zonder stukken over', () => {
  const d = toDay;
  const position = {
    txs: [buy('2024-01-01', 2, 10, 2), buy('2024-01-02', 2, 20), sell('2024-01-03', 4, 30), buy('2024-01-05', 1, 40)],
    points: [[d('2024-01-01'), 10], [d('2024-01-02'), 20], [d('2024-01-03'), 30], [d('2024-01-05'), 40]],
  };
  const series = unitSeries(position, { to: d('2024-01-05') });
  assert.deepEqual(series.map((p) => fromDay(p.day)), ['2024-01-01', '2024-01-02', '2024-01-05']);
  assert.deepEqual(series.map((p) => p.value), [10, 20, 40]);
  assert.deepEqual(series.map((p) => p.cost), [11, 15.5, 40]);
});

test('monthlyRows geeft het laatste punt per maand, nieuwste eerst', () => {
  const d = toDay;
  const rows = monthlyRows([
    { day: d('2024-01-10'), value: 1, cost: 1 },
    { day: d('2024-01-31'), value: 2, cost: 1 },
    { day: d('2024-02-05'), value: 3, cost: 1 },
  ]);
  assert.deepEqual(rows.map((r) => [r.month, r.value]), [['2024-02', 3], ['2024-01', 2]]);
});

test('validateBackup accepteert goede en weigert kapotte backups', () => {
  const good = { positions: [{ id: 'a', name: 'A', portfolio: 'prive', txs: [buy('2024-01-01', 1, 1)] }] };
  assert.equal(validateBackup(good), null);
  assert.match(validateBackup(null), /geen backup/);
  assert.match(validateBackup({ positions: [{ id: 'a' }] }), /geen naam/);
  assert.equal(validateBackup({ positions: [{ name: 'Zonder id', portfolio: 'prive', txs: [buy('2024-01-01', 1, 1)] }] }), null);
  assert.match(validateBackup({ positions: [{ ...good.positions[0], portfolio: 'x' }] }), /privé of zakelijk/);
  assert.equal(validateBackup({ positions: [{ ...good.positions[0], account: 'Bux' }] }), null);
  assert.match(validateBackup({ positions: [{ ...good.positions[0], account: 3 }] }), /rekening/);
  assert.match(validateBackup({ positions: [{ ...good.positions[0], txs: [] }] }), /geen transacties/);
  assert.match(validateBackup({ positions: [{ ...good.positions[0], txs: [buy('nope', 1, 1)] }] }), /ongeldige/);
  assert.match(validateBackup({ positions: [{ ...good.positions[0], txs: [sell('2024-01-01', 1, 1)] }] }), /meer dan/);
});
