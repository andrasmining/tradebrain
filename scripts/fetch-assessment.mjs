#!/usr/bin/env node
// NQ Pause-Board — Backend-Skript
//
// Ruft die Anthropic Messages API mit dem web_search-Tool auf, schätzt die
// Marktlage für NQ-Futures ein und schreibt:
//   - data/status.json   (volle Einschätzung fürs Frontend)
//   - data/signal.json    (kompaktes Pause-Flag für Trading-Bots)
//   - data/history.json   (Verlauf der Gesamt-Ampel)
// und schickt bei Eskalation nach ROT (bzw. Entwarnung) einen Push.
//
// Design-Entscheidungen:
//  - Das Modell liefert KOMPAKTE Codes (24-Zeichen G/Y/R) + 6 Kommentare +
//    Quellen + Confidence. Die Uhrzeiten berechnet das Skript deterministisch
//    (Europe/Zurich) und mappt sie per Index auf die Codes.
//  - Termin-Cross-Check: bekannte High-Impact-Events (NFP/CPI/PCE/FOMC) erzwingen
//    ROT in der betroffenen Stunde — unabhängig davon, was das Modell sagt.
//  - Bei API-Fehlern crasht nichts: 3 Versuche mit Backoff, alte Dateien bleiben
//    unangetastet, klarer Log, Exit 0.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const STATUS_PATH = join(DATA_DIR, 'status.json');
const SIGNAL_PATH = join(DATA_DIR, 'signal.json');
const HISTORY_PATH = join(DATA_DIR, 'history.json');

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const BOARD_URL = process.env.BOARD_URL || 'https://tobiasgiger.github.io/tradebrain/';
const TIMEZONE = 'Europe/Zurich';
const MAX_ATTEMPTS = 3;
const HISTORY_MAX = 200;
// Wie viele Stunden VOR einem High-Impact-Event bereits ROT gezeigt wird
// (die Event-Stunde selbst zählt zusätzlich). Über EVENT_PRE_HOURS überschreibbar.
const EVENT_PRE_HOURS = Number(process.env.EVENT_PRE_HOURS) || 2;

// App-/Generator-Version. KEEP IN SYNC mit APP_VERSION in index.html.
const APP_VERSION = '1.7.1';

const CODE_TO_STATUS = { G: 'gruen', Y: 'gelb', R: 'rot' };
const RANK = { gruen: 0, gelb: 1, rot: 2 };
const worst = (a, b) => (RANK[a] >= RANK[b] ? a : b);

// FOMC-Zinsentscheide (Zurich 20:00). KEEP IN SYNC mit index.html FOMC_DATES.
const FOMC_DATES = new Set([
  '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18',
  '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
  '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
]);

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Zeit-Helfer (Europe/Zurich)
// ---------------------------------------------------------------------------

function zurichHourLabel(date) {
  return new Intl.DateTimeFormat('de-CH', {
    timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date); // "14:00"
}

function zurichDateTime(date) {
  return new Intl.DateTimeFormat('de-CH', {
    timeZone: TIMEZONE, weekday: 'short', day: '2-digit', month: '2-digit',
    year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
}

// Kalender-Bestandteile eines Zeitpunkts in Zürcher Lokalzeit.
function zurichParts(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour };
}

// Offset (Minuten östlich UTC) einer Zeitzone zu einem Zeitpunkt.
function tzOffsetMin(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = dtf.formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUTC - date.getTime()) / 60000;
}
// Absoluter Zeitpunkt für "h:mi am (y,mo0,d) in Europe/Zurich" (mo0 0-basiert).
function zurichInstantFromParts(y, mo0, d, h, mi) {
  const naive = Date.UTC(y, mo0, d, h, mi);
  const off = tzOffsetMin(new Date(naive), TIMEZONE);
  return new Date(naive - off * 60000);
}

// Datum-basierter Wochentag (0=So..6=Sa), DST-sicher über UTC-Mittag.
function weekdayOf(y, mo, d) {
  return new Date(Date.UTC(y, mo - 1, d, 12)).getUTCDay();
}
function daysInMonth(y, mo) {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

// Liefert das High-Impact-Event, das exakt in die Stunde von `date` fällt, oder null.
function eventAtSlot(date) {
  const { y, mo, d, h } = zurichParts(date);
  const wd = weekdayOf(y, mo, d);
  const occ = Math.floor((d - 1) / 7) + 1; // 1. / 2. / ... Vorkommen des Wochentags
  if (h === 14 && wd === 5 && occ === 1) return 'NFP';        // 1. Freitag 14:30
  if (h === 14 && wd === 3 && occ === 2) return 'US-CPI';     // 2. Mittwoch 14:30
  if (h === 14 && wd === 5 && d + 7 > daysInMonth(y, mo)) return 'PCE'; // letzter Fr
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (h === 20 && FOMC_DATES.has(iso)) return 'FOMC';         // 20:00
  return null;
}

// Event, das in DIESER Stunde oder in den nächsten EVENT_PRE_HOURS Stunden liegt.
// Berücksichtigt feste Anker (eventAtSlot) UND vom Modell gelieferte High-Impact-
// Termine (extraHours: Map<hourMs, name>). Gibt { ev, hoursAhead } zurück.
function eventWindowForSlot(date, extraHours) {
  for (let k = 0; k <= EVENT_PRE_HOURS; k++) {
    const probe = new Date(date.getTime() + k * 3600_000);
    const name = eventAtSlot(probe) || (extraHours && extraHours.get(probe.getTime()));
    if (name) return { ev: name, hoursAhead: k };
  }
  return null;
}

// Validiert die vom Modell gelieferte Terminliste und wandelt sie in absolute
// Zeitpunkte. Liefert { termine, extraHours }:
//  - termine: sortierte Liste [{ name, ts, impact }] für die Anzeige (nächste ~8 Tage)
//  - extraHours: Map<hourMs, name> der High-Impact-Termine (impact "hoch") für den
//    Cross-Check (erzwingen ROT + Vorlauf).
function parseTermine(model, now) {
  const termine = [];
  const extraHours = new Map();
  const list = Array.isArray(model.termine) ? model.termine : [];
  const minTs = now.getTime() - 3600_000;
  const maxTs = now.getTime() + 8 * 86400_000;
  for (const t of list) {
    if (!t) continue;
    const dm = String(t.datum || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const tm = String(t.zeitZurich || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!dm || !tm) continue;
    const inst = zurichInstantFromParts(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2]);
    if (isNaN(inst.getTime()) || inst.getTime() < minTs || inst.getTime() > maxTs) continue;
    const impact = ['hoch', 'mittel'].includes(t.impact) ? t.impact : 'mittel';
    const name = String(t.name || 'Termin').slice(0, 60);
    termine.push({ name, ts: inst.toISOString(), impact });
    if (impact === 'hoch') {
      const hourMs = Math.floor(inst.getTime() / 3600_000) * 3600_000;
      if (!extraHours.has(hourMs)) extraHours.set(hourMs, name);
    }
  }
  termine.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  return { termine: termine.slice(0, 12), extraHours };
}

// ---------------------------------------------------------------------------
// Code-Expansion & Cross-Check
// ---------------------------------------------------------------------------

function normalizeCodes(raw) {
  const cleaned = String(raw || '').toUpperCase().replace(/[^GYR]/g, '');
  return (cleaned + 'G'.repeat(24)).slice(0, 24);
}

function expandCodes(codes, startHour, comments = []) {
  const out = [];
  for (let i = 0; i < 24; i++) {
    const time = new Date(startHour.getTime() + i * 3600_000);
    // ts = absoluter Zeitstempel der Stunde. Das Frontend beschriftet daraus in
    // Gerätezeit und positioniert den "Jetzt"-Marker nach echter aktueller Zeit.
    const entry = { stunde: zurichHourLabel(time), ts: time.toISOString(), status: CODE_TO_STATUS[codes[i]] || 'gruen' };
    if (comments[i] != null) entry.kommentar = String(comments[i]);
    out.push(entry);
  }
  return out;
}

// Erzwingt ROT in der Event-Stunde UND den EVENT_PRE_HOURS Stunden davor.
// Gibt { index: { ev, hoursAhead } } zurück.
function applyCrossCheck(entries, startHour, extraHours) {
  const labels = {};
  entries.forEach((e, i) => {
    const hit = eventWindowForSlot(new Date(startHour.getTime() + i * 3600_000), extraHours);
    if (hit) { e.status = 'rot'; labels[i] = hit; }
  });
  return labels;
}

function extractJson(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Kein JSON-Objekt in der Modellantwort gefunden');
  }
  return JSON.parse(t.slice(start, end + 1));
}

// ---------------------------------------------------------------------------
// Anthropic API
// ---------------------------------------------------------------------------

function buildPrompt(nowLocal) {
  return `Du bist ein Risiko-Analyst für NQ-Futures (Nasdaq-100) im Mean-Reversion-Trading.
Aufgabe: Beurteile, wann automatisierte Trading-Bots wegen Marktrisiko (News, Geopolitik, Wirtschaftsdaten) besser pausiert werden sollten.

Aktuelle Zeit (${TIMEZONE}): ${nowLocal}

Recherchiere mit dem web_search-Tool die aktuelle Lage:
- Geopolitik: Naher Osten / Iran / Israel, Ukraine / Russland (aktive Eskalation?)
- US-Wirtschaftsdaten: NFP, CPI, FOMC, PCE — was steht heute / in den nächsten 24h an?
- Marktbewegung & Volatilität (z.B. VIX), relevante Schlagzeilen der letzten Stunden

Antworte AUSSCHLIESSLICH mit EINEM JSON-Objekt — kein Markdown, kein Text davor/danach — mit exakt diesen Feldern:

{
  "status": "gruen | gelb | rot",
  "statusText": "kurzer Titel, max. 40 Zeichen",
  "empfehlung": "konkrete Handlungsempfehlung, 1 Satz",
  "headline": "Ticker-Zeile, max. 80 Zeichen",
  "body": "Begründung der Tages-Ampel, 2-3 Sätze",
  "confidence": "niedrig | mittel | hoch",
  "quellen": [ { "titel": "Kurztitel der Quelle", "url": "https://..." } ],
  "termine": [ { "name": "US Core PPI", "datum": "2026-08-13", "zeitZurich": "14:30", "impact": "hoch" } ],
  "rueckblickSummary": "letzte 24h, 2-3 Sätze",
  "rueckblickCodes": "GENAU 24 Zeichen aus G/Y/R, ein Zeichen pro Stunde, ÄLTESTE zuerst",
  "ausblickSummary": "nächste 24h, 2-3 Sätze",
  "forecastCodes": "GENAU 24 Zeichen aus G/Y/R, chronologisch ab der aktuellen Stunde",
  "forecastKommentare": ["genau 6 kurze Sätze — je einer für die ersten 6 Zukunftsstunden"]
}

Ampel-Kriterien je Stunde:
- R (rot): aktive geopolitische Eskalation, starke Marktbewegung, ODER High-Impact-Release (NFP / CPI / FOMC) in dem Stundenfenster.
- Y (gelb): erhöhte Unsicherheit, US-Cash-Open (~15:30 ${TIMEZONE}), Power-Hour-Close (~22:00 ${TIMEZONE}), kleinere Termine.
- G (grün): sonst.

Zum Feld "termine": Recherchiere den US-Wirtschaftskalender der nächsten 7 Tage und liste ALLE relevanten Termine einzeln auf — CPI, Core CPI, PPI, Core PPI, Retail Sales, NFP, FOMC, PCE, ISM, Jobless Claims, GDP usw. Jeder Eintrag mit exaktem "datum" (YYYY-MM-DD), "zeitZurich" (HH:MM in Europe/Zurich) und "impact" ("hoch" oder "mittel"). "hoch" = markttreibende Releases (CPI/Core CPI, PPI/Core PPI, NFP, FOMC, PCE, Retail Sales) → sie erzwingen automatisch ein rotes Vorlauf-Fenster. Nenne echte, recherchierte Daten; wenn ein Datum unsicher ist, lass den Eintrag weg statt zu raten.

Wichtig: "rueckblickCodes"/"forecastCodes" müssen EXAKT 24 Zeichen lang sein. "forecastKommentare" genau 6 Einträge. "quellen" 2-4 wichtigste Quellen mit echten URLs aus deiner Recherche. Keine Uhrzeiten im Ampel-Teil ausgeben.`;
}

async function callModel(prompt) {
  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
  let messages = [{ role: 'user', content: prompt }];

  for (let cont = 0; cont < 4; cont++) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, tools, messages }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 500)}`);
    }
    const data = await res.json();
    if (data.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: data.content });
      continue;
    }
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (!text.trim()) throw new Error('Leere Textantwort vom Modell');
    return text;
  }
  throw new Error('Zu viele pause_turn-Fortsetzungen');
}

async function fetchWithRetry(prompt) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      log(`API-Aufruf Versuch ${attempt}/${MAX_ATTEMPTS} (Modell: ${MODEL})`);
      return extractJson(await callModel(prompt));
    } catch (err) {
      lastErr = err;
      log(`Versuch ${attempt} fehlgeschlagen: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Aufbau von status.json (inkl. Cross-Check)
// ---------------------------------------------------------------------------

function buildStatusJson(model, now) {
  const topOfHour = new Date(Math.floor(now.getTime() / 3600_000) * 3600_000);
  const rueckblickStart = new Date(topOfHour.getTime() - 24 * 3600_000);
  const forecastStart = topOfHour;

  const rueckblick = expandCodes(normalizeCodes(model.rueckblickCodes), rueckblickStart);
  const forecast = expandCodes(normalizeCodes(model.forecastCodes), forecastStart);

  // Live-Terminkalender aus der Modell-Recherche (CPI, PPI, Retail Sales …).
  const { termine, extraHours } = parseTermine(model, now);

  // Termin-Cross-Check: erzwingt ROT bei festen Ankern UND Live-High-Impact-Terminen.
  applyCrossCheck(rueckblick, rueckblickStart, extraHours);
  const forecastLabels = applyCrossCheck(forecast, forecastStart, extraHours);

  const kommentare = Array.isArray(model.forecastKommentare)
    ? model.forecastKommentare.slice(0, 6).map(String) : [];
  const forecastDetail = forecast.slice(0, 6).map((h, i) => {
    const entry = { stunde: h.stunde, ts: h.ts, status: h.status, kommentar: kommentare[i] || '' };
    const lab = forecastLabels[i];
    if (lab) {
      const tag = lab.hoursAhead > 0 ? `${lab.ev} in ${lab.hoursAhead}h` : lab.ev;
      entry.kommentar = `⚠ ${tag}: ${entry.kommentar}`.trim();
    }
    return entry;
  });

  const allowed = new Set(['gruen', 'gelb', 'rot']);
  const modelDay = allowed.has(model.status) ? model.status : 'gelb';

  // Tages-Ampel nie ruhiger als die aktuelle Stunde.
  let status = worst(modelDay, forecast[0].status);
  let empfehlung = String(model.empfehlung || '') || 'Keine Empfehlung verfügbar.';
  const nowLab = forecastLabels[0];
  if (nowLab) {
    status = 'rot';
    empfehlung = nowLab.hoursAhead > 0
      ? `⚠️ ${nowLab.ev} in ~${nowLab.hoursAhead}h — Bots rechtzeitig pausieren. ${empfehlung}`
      : `⚠️ ${nowLab.ev} jetzt im aktuellen Stundenfenster — Bots pausieren. ${empfehlung}`;
  }

  const conf = new Set(['niedrig', 'mittel', 'hoch']);
  const confidence = conf.has(model.confidence) ? model.confidence : 'mittel';
  const quellen = Array.isArray(model.quellen)
    ? model.quellen
        .filter((q) => q && typeof q.url === 'string' && /^https?:\/\//i.test(q.url))
        .slice(0, 4)
        .map((q) => ({ titel: String(q.titel || q.url).slice(0, 120), url: q.url }))
    : [];

  return {
    generatedAt: now.toISOString(),
    appVersion: APP_VERSION,
    status,
    statusText: String(model.statusText || '').slice(0, 60) || 'Keine Angabe',
    empfehlung,
    headline: String(model.headline || '').slice(0, 120) || 'NQ Pause-Board',
    body: String(model.body || ''),
    confidence,
    quellen,
    rueckblickSummary: String(model.rueckblickSummary || ''),
    rueckblick,
    ausblickSummary: String(model.ausblickSummary || ''),
    forecast,
    forecastDetail,
    termine,
  };
}

// ---------------------------------------------------------------------------
// Push-Benachrichtigung (ntfy und/oder Telegram; optional)
// ---------------------------------------------------------------------------

async function sendPush(title, message, tag) {
  const tasks = [];
  const ntfyTopic = process.env.NTFY_TOPIC;
  if (ntfyTopic) {
    const server = process.env.NTFY_SERVER || 'https://ntfy.sh';
    tasks.push(
      fetch(`${server}/${ntfyTopic}`, {
        method: 'POST',
        headers: { Title: title, Click: BOARD_URL, Tags: tag, Priority: 'high' },
        body: message,
      }).then((r) => { if (!r.ok) throw new Error('ntfy ' + r.status); })
    );
  }
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChat) {
    tasks.push(
      fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: tgChat,
          text: `${title}\n\n${message}\n\n${BOARD_URL}`,
          disable_web_page_preview: true,
        }),
      }).then((r) => { if (!r.ok) throw new Error('telegram ' + r.status); })
    );
  }
  if (!tasks.length) {
    log('Push übersprungen: keine Kanäle konfiguriert (NTFY_TOPIC / TELEGRAM_*).');
    return;
  }
  const results = await Promise.allSettled(tasks);
  results.forEach((r) => { if (r.status === 'rejected') log('Push-Fehler: ' + r.reason.message); });
  log(`Push versendet (${results.filter((r) => r.status === 'fulfilled').length}/${tasks.length} Kanäle).`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!API_KEY) {
    log('FEHLER: ANTHROPIC_API_KEY ist nicht gesetzt. Dateien bleiben unverändert.');
    process.exit(0);
  }

  const now = new Date();
  let model;
  try {
    model = await fetchWithRetry(buildPrompt(zurichDateTime(now)));
  } catch (err) {
    log(`FEHLER: Alle ${MAX_ATTEMPTS} Versuche fehlgeschlagen (${err.message}).`);
    log('Bestehende Dateien bleiben unverändert. Exit 0, Workflow bleibt grün.');
    process.exit(0);
  }

  try {
    const statusJson = buildStatusJson(model, now);
    const effective = statusJson.status; // berücksichtigt Cross-Check + aktuelle Stunde

    // Vorherigen Zustand für Transition-Erkennung lesen.
    const prevEffective = readJsonSafe(SIGNAL_PATH)?.effectiveStatus || null;

    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STATUS_PATH, JSON.stringify(statusJson, null, 2) + '\n', 'utf8');

    // Bot-Signal.
    const signal = {
      generatedAt: now.toISOString(),
      appVersion: APP_VERSION,
      effectiveStatus: effective,
      pause: effective === 'rot',
      caution: effective === 'gelb',
      dayStatus: statusJson.status,
      statusText: statusJson.statusText,
      empfehlung: statusJson.empfehlung,
      source: 'nq-pause-board',
    };
    writeFileSync(SIGNAL_PATH, JSON.stringify(signal, null, 2) + '\n', 'utf8');

    // Verlauf fortschreiben (auf HISTORY_MAX begrenzt).
    const history = Array.isArray(readJsonSafe(HISTORY_PATH)) ? readJsonSafe(HISTORY_PATH) : [];
    history.push({ generatedAt: now.toISOString(), status: effective });
    writeFileSync(HISTORY_PATH, JSON.stringify(history.slice(-HISTORY_MAX), null, 2) + '\n', 'utf8');

    log(`OK: geschrieben (effektiv=${effective}, vorher=${prevEffective ?? 'n/a'}).`);

    // Push nur bei Zustandswechsel.
    if (effective === 'rot' && prevEffective !== 'rot') {
      await sendPush(
        'NQ Pause-Board: ROT',
        `⚠️ ${statusJson.headline}\n\nEmpfehlung: ${statusJson.empfehlung}`,
        'rotating_light'
      );
    } else if (prevEffective === 'rot' && effective !== 'rot') {
      await sendPush(
        'NQ Pause-Board: Entwarnung',
        `✅ Lage entspannt (${effective}). ${statusJson.statusText}`,
        'white_check_mark'
      );
    }
  } catch (err) {
    log(`FEHLER beim Aufbau/Schreiben: ${err.message}`);
    log('Bestehende Dateien bleiben unverändert.');
    process.exit(0);
  }
}

main();
