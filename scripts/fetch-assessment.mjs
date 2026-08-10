#!/usr/bin/env node
// NQ Pause-Board — Backend-Skript
//
// Ruft die Anthropic Messages API mit dem web_search-Tool auf, um die aktuelle
// Marktlage für NQ-Futures (Nasdaq-100) einzuschätzen, und schreibt das Ergebnis
// nach data/status.json.
//
// Design-Entscheidungen:
//  - Das Modell liefert KOMPAKTE Codes (24-Zeichen-Strings aus G/Y/R), nicht 48
//    einzelne JSON-Objekte. Das spart Token/Latenz und senkt die Fehlerquote.
//  - Die Uhrzeiten (Stunden-Labels) berechnet DIESES Skript deterministisch aus
//    der aktuellen Zeit und mappt sie per Index auf die Codes. Das Modell erzeugt
//    also keine Zeitstempel.
//  - Bei API-Fehlern crasht das Skript NICHT: es schreibt einen klaren Log-Eintrag,
//    lässt die alte status.json unangetastet und beendet sich mit Exit-Code 0,
//    damit der Workflow grün bleibt.
//
// Umgebungsvariablen:
//  - ANTHROPIC_API_KEY  (erforderlich)  — Anthropic API-Key
//  - ANTHROPIC_MODEL    (optional)      — Modell-ID, Default siehe unten

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, '..', 'data', 'status.json');

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_KEY = process.env.ANTHROPIC_API_KEY;
// Konfigurierbar via ANTHROPIC_MODEL. Sonnet ist für einen stündlichen
// Hintergrund-Job ein guter Kosten/Qualitäts-Kompromiss.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const TIMEZONE = 'Europe/Zurich';
const MAX_ATTEMPTS = 3;

const CODE_TO_STATUS = { G: 'gruen', Y: 'gelb', R: 'rot' };

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

/**
 * Formatiert ein Date-Objekt als "HH:00"-Label in der Zielzeitzone.
 * @param {Date} date  Absoluter Zeitpunkt (bereits auf volle Stunde gerundet)
 */
function zurichHourLabel(date) {
  const fmt = new Intl.DateTimeFormat('de-CH', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return fmt.format(date); // z.B. "14:00"
}

/** Formatiert Datum + Uhrzeit lesbar (für den Prompt). */
function zurichDateTime(date) {
  return new Intl.DateTimeFormat('de-CH', {
    timeZone: TIMEZONE,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/**
 * Normalisiert einen vom Modell gelieferten Code-String auf exakt 24 Zeichen
 * aus {G, Y, R}. Ungültige Zeichen werden entfernt, fehlende mit 'G' aufgefüllt.
 */
function normalizeCodes(raw) {
  const cleaned = String(raw || '')
    .toUpperCase()
    .replace(/[^GYR]/g, '');
  return (cleaned + 'G'.repeat(24)).slice(0, 24);
}

/**
 * Baut aus einem 24-Zeichen-Code-String die vollen Stunden-Objekte mit echten
 * Uhrzeiten.
 * @param {string} codes        24 Zeichen G/Y/R
 * @param {Date}   startHour    Zeitpunkt der ERSTEN Stunde (Index 0)
 * @param {string[]} [comments] optionale Kommentare je Index
 */
function expandCodes(codes, startHour, comments = []) {
  const out = [];
  for (let i = 0; i < 24; i++) {
    const time = new Date(startHour.getTime() + i * 3600_000);
    const entry = {
      stunde: zurichHourLabel(time),
      status: CODE_TO_STATUS[codes[i]] || 'gruen',
    };
    if (comments[i] != null) entry.kommentar = String(comments[i]);
    out.push(entry);
  }
  return out;
}

/** Extrahiert ein JSON-Objekt aus einem (möglicherweise umschlossenen) Text. */
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

function buildPrompt(nowLocal) {
  return `Du bist ein Risiko-Analyst für NQ-Futures (Nasdaq-100) im Mean-Reversion-Trading.
Aufgabe: Beurteile, wann automatisierte Trading-Bots wegen Marktrisiko (News, Geopolitik, Wirtschaftsdaten) besser pausiert werden sollten.

Aktuelle Zeit (${TIMEZONE}): ${nowLocal}

Recherchiere mit dem web_search-Tool die aktuelle Lage:
- Geopolitik: Naher Osten / Iran / Israel, Ukraine / Russland (aktive Eskalation?)
- US-Wirtschaftsdaten: NFP, CPI, FOMC, PCE — was steht heute / in den nächsten 24h an?
- Marktbewegung & Volatilität (z.B. VIX), relevante Schlagzeilen der letzten Stunden

Antworte AUSSCHLIESSLICH mit EINEM JSON-Objekt — kein Markdown, kein Text davor oder danach — mit exakt diesen Feldern:

{
  "status": "gruen | gelb | rot",
  "statusText": "kurzer Titel, max. 40 Zeichen",
  "empfehlung": "konkrete Handlungsempfehlung, 1 Satz",
  "headline": "Ticker-Zeile, max. 80 Zeichen",
  "body": "Begründung der Tages-Ampel, 2-3 Sätze",
  "rueckblickSummary": "was in den letzten 24h markttechnisch relevant war, 2-3 Sätze",
  "rueckblickCodes": "GENAU 24 Zeichen aus G/Y/R, ein Zeichen pro Stunde, ÄLTESTE Stunde zuerst",
  "ausblickSummary": "Prognose für die nächsten 24h, 2-3 Sätze",
  "forecastCodes": "GENAU 24 Zeichen aus G/Y/R, chronologisch ab der aktuellen Stunde",
  "forecastKommentare": ["genau 6 kurze Sätze — je einer für die ersten 6 Zukunftsstunden"]
}

Ampel-Kriterien je Stunde:
- R (rot): aktive geopolitische Eskalation, starke Marktbewegung, ODER High-Impact-Release (NFP / CPI / FOMC) in diesem Stundenfenster.
- Y (gelb): erhöhte Unsicherheit, US-Cash-Open (~15:30 ${TIMEZONE}), Power-Hour-Close (~22:00 ${TIMEZONE}), kleinere Termine.
- G (grün): sonst.

Wichtig: "rueckblickCodes" und "forecastCodes" müssen EXAKT 24 Zeichen lang sein. "forecastKommentare" muss GENAU 6 Einträge enthalten. Keine Uhrzeiten ausgeben — nur die Codes.`;
}

/** Führt einen einzelnen API-Aufruf durch (inkl. pause_turn-Fortsetzung). */
async function callModel(prompt) {
  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
  let messages = [{ role: 'user', content: prompt }];

  // Server-seitiges web_search kann bei vielen Iterationen mit stop_reason
  // "pause_turn" zurückkommen — dann Antwort anhängen und fortsetzen.
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
      continue; // Server setzt automatisch fort
    }

    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
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
      const text = await callModel(prompt);
      return extractJson(text);
    } catch (err) {
      lastErr = err;
      log(`Versuch ${attempt} fehlgeschlagen: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) {
        const delay = 2000 * Math.pow(2, attempt - 1); // 2s, 4s, ...
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

function buildStatusJson(model, now) {
  // Auf volle Stunde (absolut) runden.
  const topOfHour = new Date(Math.floor(now.getTime() / 3600_000) * 3600_000);

  // Rückblick: 24 Stunden zurück (älteste = jetzt-24h, neueste = jetzt-1h).
  const rueckblickStart = new Date(topOfHour.getTime() - 24 * 3600_000);
  // Ausblick: aktuelle Stunde + 23 folgende.
  const forecastStart = topOfHour;

  const rueckblickCodes = normalizeCodes(model.rueckblickCodes);
  const forecastCodes = normalizeCodes(model.forecastCodes);

  const kommentare = Array.isArray(model.forecastKommentare)
    ? model.forecastKommentare.slice(0, 6).map(String)
    : [];

  const rueckblick = expandCodes(rueckblickCodes, rueckblickStart);
  const forecast = expandCodes(forecastCodes, forecastStart);

  // forecastDetail: erste 6 Zukunftsstunden inkl. Kommentar.
  const forecastDetail = expandCodes(
    forecastCodes.slice(0, 6),
    forecastStart,
    kommentare
  ).slice(0, 6);

  const allowedStatus = new Set(['gruen', 'gelb', 'rot']);
  const status = allowedStatus.has(model.status) ? model.status : 'gelb';

  return {
    generatedAt: now.toISOString(),
    status,
    statusText: String(model.statusText || '').slice(0, 60) || 'Keine Angabe',
    empfehlung: String(model.empfehlung || '') || 'Keine Empfehlung verfügbar.',
    headline: String(model.headline || '').slice(0, 120) || 'NQ Pause-Board',
    body: String(model.body || ''),
    rueckblickSummary: String(model.rueckblickSummary || ''),
    rueckblick,
    ausblickSummary: String(model.ausblickSummary || ''),
    forecast,
    forecastDetail,
  };
}

async function main() {
  if (!API_KEY) {
    log('FEHLER: ANTHROPIC_API_KEY ist nicht gesetzt. status.json bleibt unverändert.');
    process.exit(0);
  }

  const now = new Date();
  const prompt = buildPrompt(zurichDateTime(now));

  let model;
  try {
    model = await fetchWithRetry(prompt);
  } catch (err) {
    log(`FEHLER: Alle ${MAX_ATTEMPTS} Versuche fehlgeschlagen (${err.message}).`);
    log('Die bestehende status.json bleibt unverändert. Exit 0, Workflow bleibt grün.');
    process.exit(0);
  }

  try {
    const statusJson = buildStatusJson(model, now);
    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
    writeFileSync(OUTPUT_PATH, JSON.stringify(statusJson, null, 2) + '\n', 'utf8');
    log(`OK: status.json geschrieben (status=${statusJson.status}).`);

    // Kleine Konsistenz-Warnung, falls Codes nicht sauber 24 lang waren.
    if (normalizeCodes(model.rueckblickCodes) !== String(model.rueckblickCodes || '').toUpperCase().replace(/[^GYR]/g, '')) {
      log('Hinweis: rueckblickCodes wurde auf 24 Zeichen normalisiert.');
    }
  } catch (err) {
    log(`FEHLER beim Aufbau/Schreiben von status.json: ${err.message}`);
    log('Die bestehende status.json bleibt unverändert.');
    process.exit(0);
  }
}

main();
