# Mijn Portfolio

Telefoon-app (PWA) die laat zien welke beleggingen je hebt, wat ze kostten en wat ze nu waard zijn,
apart voor privé en zakelijk. Met een grafiek van waarde tegenover betaald bedrag, en een eigen scherm
per positie.

## Waar je gegevens staan

Het bestand met je beleggingen staat op de pc, standaard in `Documents\MijnPortfolio\portfolio.json` en
aan te passen met `PORTFOLIO_FILE`. Bij elk opslaan blijft de vorige versie staan als `portfolio.json.bak`.
Elk apparaat bewaart een eigen kopie in de browser, zodat de app ook werkt als de pc uit staat. Yahoo
krijgt alleen tickers te zien, nooit aantallen of bedragen. Deze repo is openbaar; zet er nooit een
bestand met gegevens in (`.gitignore` weert backups).

Invoeren doe je op de pc: in de app, gevolgd door "Opslaan op pc", of rechtstreeks in het bestand gevolgd
door "Ophalen van pc". Andere apparaten kunnen alleen ophalen; dat vervangt hun kopie. Is het bestand buiten
de app gewijzigd, dan weigert "Opslaan op pc" het te overschrijven tot je het eerst hebt opgehaald.

Het bestand ziet er zo uit; `id`, `symbol`, `manualPrices` en `fee` mogen ontbreken:

```json
{
  "version": 1,
  "positions": [
    {
      "name": "Vanguard FTSE All-World",
      "symbol": "VWRL.AS",
      "portfolio": "prive",
      "txs": [
        { "type": "buy", "date": "2024-01-15", "qty": 10, "price": 100.5, "fee": 2 }
      ]
    }
  ]
}
```

`portfolio` is `prive` of `zakelijk`, `type` is `buy` of `sell`, en `price` is de prijs per stuk in euro.

## Exports van brokers inlezen

`tools/import.mjs` maakt dit bestand uit exports van DEGIRO (transacties-CSV), Bux (CSV uit de app) en
ABN AMRO (map met pdf-transactienota's; vereist `pdftotext`, dat met Git voor Windows meekomt). Bewaar
exports in `Documents\MijnPortfolio\exports`, niet in deze repo.

```
node tools/import.mjs "degiro:prive:DEGIRO=…/deGiro.csv" "bux:prive:Bux=…/Bux.csv" "abn:zakelijk:ABN AMRO=…/abn-nota"
```

Per rekening en ISIN wordt het één positie. De ticker zoekt het script op via de draaiende server, alleen
onder noteringen van precies dat ISIN, en het controleert die tegen de prijs die je betaalde. Lukt dat
niet, dan staat de positie erin zonder ticker en werk je de waarde zelf bij. Een bestaand
`portfolio.json` wordt nooit overschreven; dan komt er een apart `portfolio-import-….json`. Dividend,
rente en abonnementskosten worden overgeslagen, en ABN-verkoopnota's worden nog niet ondersteund.

## Draaien

```
npm start     # http://localhost:3000, poort aan te passen met PORT
npm test
```

Geen dependencies, alleen Node 22 of nieuwer. De server luistert standaard alleen op deze pc; met `HOST`
is dat aan te passen. Er is ook een `Dockerfile`. Installeren op het beginscherm en offline gebruik werken
alleen via HTTPS (of localhost).

## Op de telefoon, zonder externe server

De telefoon bereikt de server op de pc via Tailscale, dat ook voor HTTPS zorgt:

1. Zet HTTPS aan op https://login.tailscale.com/admin/dns en installeer Tailscale op de telefoon.
2. Laat de server op de pc meestarten met Windows, op poort 3847, via de geplande taak `MijnPortfolio`
   (uitzetten: `Unregister-ScheduledTask MijnPortfolio`). Zet daarna `tailscale serve --bg 3847` aan
   (uitzetten: `tailscale serve reset`).
3. Open op de telefoon het `https://…ts.net`-adres van de pc en zet de app op het beginscherm. Op de pc
   gebruik je `http://localhost:3847`.

Staat de pc uit, dan opent de app nog steeds, maar met de laatst bekende koersen en de laatst opgehaalde
gegevens.

## Opbouw

- `server.mjs`: serveert `public/`, geeft koersen door van Yahoo Finance, dat vanuit een browser niet
  bereikbaar is (geen CORS), en leest en schrijft het bestand op de pc.
- `public/js/core.js`: alle berekeningen, los getest.
- `public/js/store.js`: opslag en backup.
- `public/js/quotes.js`: koersen ophalen en onthouden.
- `public/js/chart.js`, `public/js/app.js`: grafiek en schermen.

## Rekenregels

- Alles staat in euro. Je vult aankopen in euro in; buitenlandse koersen worden omgerekend met de
  wisselkoers van die dag.
- Kostprijs: gemiddelde-kostprijsmethode, inclusief transactiekosten. Bij een verkoop gaat het
  gemiddelde deel van de kostprijs eruit en wordt het verschil "resultaat op verkopen".
- Winst bovenaan is de ongerealiseerde winst op wat je nu nog hebt.

## Bekende beperkingen

- Yahoo Finance is een onofficiële bron: die kan koersen weigeren of veranderen. De app toont dan de
  laatst bekende koers met datum, en je kunt elke waarde ook zelf bijwerken.
- Een aandelensplitsing moet je zelf verwerken: Yahoo corrigeert de oude koersen, maar jouw aantal
  verandert niet vanzelf. Boek de extra stukken als aankoop voor € 0; de kostprijs per stuk daalt dan
  vanzelf mee.
- Dividend en belasting worden niet bijgehouden.
