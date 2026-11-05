import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAbnNote, parseBux, parseDegiro, toPosition } from '../tools/import.mjs';
import { validateBackup } from '../public/js/core.js';

// Verzonnen regels in het formaat van de echte exports.
const DEGIRO = `Datum,Tijd,Product,ISIN,Beurs,Uitvoeringsplaats,Aantal,Koers,,Lokale waarde,,Waarde EUR,Wisselkoers,AutoFX Kosten,Transactiekosten en/of kosten van derden EUR,Totaal EUR,Order ID
15-01-2024,09:01,VANGUARD FTSE AW,IE00B3RBWM25,EAM,XAMS,10,"100,5000",EUR,"-1005,00",EUR,"-1005,00","0,0000","0,00","-1,00","-1006,00",abc
01-02-2025,10:00,VANGUARD FTSE AW,IE00B3RBWM25,EAM,XAMS,-4,"120,0000",EUR,"480,00",EUR,"480,00","0,0000","0,00","-1,00","479,00",def
`;

const BUX_HEADER = 'Transaction Time (CET),Transaction Category,Transaction Type,Transfer Type,Transaction Amount,Transaction Currency,Cash Balance Amount,Asset Id,Asset Name,Asset Quantity,Asset Price,Asset Currency,Currency Pair,Exchange Rate,Profit And Loss Amount,Profit And Loss Currency,Dividend Currency,Dividend Gross Amount,Dividend Net Amount,Dividend Tax Amount,Transaction Description';
const BUX = `${BUX_HEADER}
2024-03-01 10:00:00.123,trades,Buy Trade,CASH_DEBIT,-92.59,EUR,100.00,US4581401001,Intel,2.0,50.00,USD,EURUSD,1.08,,,,,,,Order Partial Id: aaaa1111-1
2024-03-01 10:00:00.456,trades,Buy Trade,ASSET_TRADE_BUY,2.0,USD,,US4581401001,Intel,2.0,50.00,USD,,,,,,,,,Order Partial Id: aaaa1111-1
2024-03-01 10:00:00.789,fees,Trading Fee,CASH_DEBIT,-1.00,EUR,99.00,,,,,,,,,,,,,,Order Id: aaaa1111
2024-04-01 08:00:00.000,dividends,Cash Dividend,CASH_CREDIT,0.50,EUR,99.50,US4581401001,Intel,,,,,,,,EUR,0.6,0.5,0.1,
2024-05-01 10:00:00.000,trades,Sell Trade,CASH_CREDIT,50.00,EUR,149.50,US4581401001,Intel,1.0,54.00,USD,EURUSD,1.08,,,,,,,Order Partial Id: bbbb2222-1
2024-05-01 10:00:00.000,trades,Sell Trade,ASSET_TRADE_SELL,-1.0,USD,,US4581401001,Intel,1.0,54.00,USD,,,,,,,,,Order Partial Id: bbbb2222-1
`;

const ABN_EUR = `
Koopnota
Opdracht via Internet Beleggen op 15-01-2024
We kochten voor u op 15-01-2024 09:00:00      Fondscode: 123456 ISIN code: IE00B3RBWM25
VANGUARD FTSE ALL WORLD EUR ETF DIS
                                                                                             Afrekenbedrag (EUR)
Uitgevoerd                                                  Prijs
ST 100                                                      100,50                                     10.050,00 D
Beurs: EURONEXT AMSTERDAM
Totaal geboekt van NL00 ABNA 0000 0000 00                   Valutadatum 17-01-2024                      10.050,00 D
`;

// Opmaak waarin aantal, prijs en totaal op verschillende regels staan.
const ABN_USD = `
Koopnota
 We kochten voor u op 01-03-2024 15:30:00      12.34.56.789      12.12345678.12345678 1
                                                                  Afrekenbedrag (EUR)
INTEL CORP          Fondscode: 654321     ISIN code: US4581401001        1.000,00 D
                                                                              6,50 D
Uitgevoerd              Bedrag (USD)                                          2,00 D
ST 20
Transactiekosten        Prijs                                             1.008,50 D
Valutakosten
                        54,00           1.080,00
1 EUR = 1,080000 USD
Beurs: KNIGHT EQUITY MARKET
Totaal geboekt van NL00 ABNA 0000 0000 00 Valutadatum 5-3-2024
`;

test('DEGIRO: aankoop en verkoop met kosten in euro', () => {
  const [buy, sell] = parseDegiro(DEGIRO);
  assert.deepEqual(
    { type: buy.type, date: buy.date, qty: buy.qty, price: buy.price, fee: buy.fee, exchange: buy.exchange },
    { type: 'buy', date: '2024-01-15', qty: 10, price: 100.5, fee: 1, exchange: 'AS' },
  );
  assert.equal(sell.type, 'sell');
  assert.equal(sell.qty, 4);
  assert.equal(sell.price, 120);
  assert.equal(sell.localCurrency, 'EUR');
});

test('Bux: prijs in euro uit de geldregel, kosten gekoppeld, dividend overgeslagen', () => {
  const trades = parseBux(BUX);
  assert.equal(trades.length, 2);
  const [buy, sell] = trades;
  assert.equal(buy.type, 'buy');
  assert.equal(buy.qty, 2);
  assert.equal(buy.price, 46.295);
  assert.equal(buy.fee, 1);
  assert.equal(buy.localPrice, 50);
  assert.equal(buy.exchange, 'US');
  assert.equal(sell.type, 'sell');
  assert.equal(sell.fee, 0);
});

test('Bux: weigert een kostenregel die bij geen enkele trade hoort', () => {
  const orphan = `${BUX}2024-06-01 10:00:00.000,fees,Trading Fee,CASH_DEBIT,-1.00,EUR,148.50,,,,,,,,,,,,,,Order Id: cccc3333\n`;
  assert.throws(() => parseBux(orphan), /zonder trade/);
});

test('ABN: nota in euro zonder kosten', () => {
  const trade = parseAbnNote(ABN_EUR);
  assert.equal(trade.isin, 'IE00B3RBWM25');
  assert.equal(trade.date, '2024-01-15');
  assert.equal(trade.qty, 100);
  assert.equal(trade.price, 100.5);
  assert.equal(trade.fee, 0);
  assert.equal(trade.exchange, 'AS');
  assert.equal(trade.name, 'VANGUARD FTSE ALL WORLD EUR ETF DIS');
});

test('ABN: nota in dollars wordt omgerekend met de koers op de nota', () => {
  const trade = parseAbnNote(ABN_USD);
  assert.equal(trade.qty, 20);
  assert.equal(trade.price, 50);
  assert.equal(trade.fee, 8.5);
  assert.equal(trade.localCurrency, 'USD');
  assert.equal(trade.exchange, 'US');
  assert.equal(trade.name, 'INTEL CORP');
});

test('ABN: een verkoopnota wordt niet stilletjes als aankoop gelezen', () => {
  assert.throws(() => parseAbnNote(ABN_EUR.replace('Koopnota', 'Verkoopnota')), /verkopen/);
});

test('ABN: bedragen die niet optellen tot het totaal worden geweigerd', () => {
  assert.throws(() => parseAbnNote(ABN_USD.replace('1.008,50 D', '1.010,00 D')), /kloppende bedragen/);
});

test('omgezette posities zijn een geldig bestand voor de app', () => {
  const position = toPosition({ kind: 'degiro', portfolio: 'prive', account: 'DEGIRO', trades: parseDegiro(DEGIRO), symbol: 'VWRL.AS', name: 'Vanguard' });
  assert.equal(position.name, 'Vanguard (DEGIRO)');
  assert.equal(position.id, 'degiro-degiro-ie00b3rbwm25');
  assert.equal(validateBackup({ positions: [position] }), null);
});
