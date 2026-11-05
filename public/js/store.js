// Alle beleggingen staan alleen in de opslag van deze telefoon.
import { validateBackup } from './core.js';

const DATA_KEY = 'mijnportfolio.v1';
const META_KEY = 'mijnportfolio.meta.v1';
const QUOTES_KEY = 'mijnportfolio.quotes.v1';
const PC_FILE_URL = '/api/portfolio';
const PC_UNREACHABLE = 'Je pc is niet bereikbaar. Staat hij aan en is Tailscale actief?';

const readJson = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};

let data = readJson(DATA_KEY, { version: 1, positions: [] });
let meta = readJson(META_KEY, { lastBackupAt: null, changedAt: null, fileVersion: null });

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const positions = () => data.positions;
export const findPosition = (id) => data.positions.find((position) => position.id === id) ?? null;
export const backupStatus = () => ({ ...meta });

function writeData() {
  try {
    localStorage.setItem(DATA_KEY, JSON.stringify(data));
  } catch {
    // Opslag vol: bewaarde koersen zijn opnieuw op te halen, jouw beleggingen niet.
    localStorage.removeItem(QUOTES_KEY);
    localStorage.setItem(DATA_KEY, JSON.stringify(data));
  }
}

function persist() {
  meta.changedAt = new Date().toISOString();
  writeData();
  localStorage.setItem(META_KEY, JSON.stringify(meta));
  // Vraagt de browser deze gegevens niet op te ruimen als de opslag vol raakt.
  navigator.storage?.persist?.().catch(() => {});
}

export function savePosition(position) {
  const index = data.positions.findIndex((existing) => existing.id === position.id);
  if (index >= 0) data.positions[index] = position;
  else data.positions.push(position);
  persist();
}

export function deletePosition(id) {
  data.positions = data.positions.filter((position) => position.id !== id);
  persist();
}

export function exportBackup() {
  return JSON.stringify({ ...data, exportedAt: new Date().toISOString() }, null, 2);
}

export function markBackupMade() {
  meta.lastBackupAt = new Date().toISOString();
  localStorage.setItem(META_KEY, JSON.stringify(meta));
}

// Geeft een foutmelding terug als het bestand niet klopt; dan blijft alles zoals het was.
export function importBackup(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'Dit bestand is geen backup van Mijn Portfolio.';
  }
  const problem = validateBackup(parsed);
  if (problem) return problem;
  const withIds = (position) => ({
    ...position,
    id: typeof position.id === 'string' ? position.id : newId(),
    symbol: position.symbol ?? null,
    manualPrices: position.manualPrices ?? [],
    txs: position.txs.map((tx) => ({ ...tx, id: tx.id ?? newId() })),
  });
  data = { version: 1, positions: parsed.positions.map(withIds) };
  meta.lastBackupAt = parsed.exportedAt ?? meta.lastBackupAt;
  persist();
  return null;
}

// Alleen op de pc zelf kun je het bestand wijzigen; andere apparaten halen het alleen op.
export const isOnPc = () => ['localhost', '127.0.0.1'].includes(location.hostname);

// Geven een foutmelding terug als het niet lukt; dan blijft alles zoals het was.
export async function pullFromPc() {
  let response;
  try {
    response = await fetch(PC_FILE_URL, { cache: 'no-store' });
  } catch {
    return PC_UNREACHABLE;
  }
  if (response.status === 404) return 'Er staat nog geen bestand op je pc.';
  if (!response.ok) return 'Ophalen van je pc lukt nu niet.';
  const problem = importBackup(await response.text());
  if (problem) return problem;
  meta.fileVersion = response.headers.get('ETag');
  markBackupMade();
  return null;
}

export async function pushToPc() {
  let response;
  try {
    response = await fetch(PC_FILE_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(meta.fileVersion ? { 'If-Match': meta.fileVersion } : {}) },
      body: exportBackup(),
    });
  } catch {
    return PC_UNREACHABLE;
  }
  if (response.status === 412) {
    return 'Het bestand op je pc is gewijzigd buiten de app om. Haal het eerst op. Dat vervangt wat je hier hebt, dus maak zo nodig eerst een backup.';
  }
  if (!response.ok) return 'Opslaan op je pc lukt nu niet.';
  meta.fileVersion = response.headers.get('ETag');
  markBackupMade();
  return null;
}
