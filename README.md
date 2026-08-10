# NQ Pause-Board

Ein Dashboard, das dir als **NQ-Futures Mean-Reversion-Trader** anzeigt, wann du
deine automatisierten Trading-Bots wegen Marktrisiko (News, Geopolitik,
Wirtschaftsdaten) besser pausieren solltest.

Statisches Frontend + GitHub Action als Backend, gehostet auf GitHub Pages.
Sprache der Oberfläche: Deutsch, Zeitzone Europe/Zurich.

> ⚠️ **Keine Anlageberatung.** Persönliches Hilfsmittel. Einschätzungen können
> falsch oder veraltet sein — Handelsentscheidungen triffst du eigenverantwortlich.

---

## Architektur

Bewusst **kein Live-API-Call im Browser** (wäre langsam/unzuverlässig). Stattdessen:

```
GitHub Action (Zeitplan-Cron + manuell)
   → scripts/fetch-assessment.mjs
        → Anthropic Messages API (Tool: web_search)
        → Termin-Cross-Check (NFP/CPI/PCE/FOMC erzwingen ROT)
        → schreibt data/status.json, data/signal.json, data/history.json
        → Push bei Eskalation nach ROT (ntfy / Telegram)
        → committet die Dateien zurück ins Repo
GitHub Pages (statisch)
   → index.html liest data/status.json + data/history.json (same-origin)
Trading-Bots
   → pollen data/signal.json direkt (maschinenlesbares Pause-Flag)
```

Der Anthropic API-Key liegt als **GitHub Actions Secret** (`ANTHROPIC_API_KEY`),
nie im Code. Das Modell liefert kompakte Codes (24-Zeichen `G`/`Y`/`R` + 6
Kommentare + Quellen + Confidence); die **Uhrzeiten** berechnet das Skript
deterministisch (Europe/Zurich) und mappt sie per Index auf die Codes.

### Zeitplan

An die NQ-Handelswoche angepasst (nicht 24/7 — spart Kosten):

| Tag | Läufe (CEST) |
|-----|--------------|
| Sonntag | 22:00 (Wochenstart) |
| Mo–Do | 02 · 06 · 10 · 14 · 18 · 22 (alle 4 h) |
| Freitag | 02 · 06 · 10 · 14 · 18 (Stopp) |
| Samstag | — aus |

~30 Läufe/Woche. GitHub-Cron läuft in UTC (`CEST = UTC+2`); im Winter (CET)
verschieben sich die lokalen Zeiten um 1 h — Kommentar dazu im Workflow.
Manuelles Auslösen (**Actions → Run workflow**) geht jederzeit zusätzlich.

---

## Funktionen

### Tages-Ampel & Stunden-Ampel
Gesamteinschätzung (grün/gelb/rot) + horizontal scrollbarer 48-Punkte-Zeitstrahl
(24 h zurück · „Jetzt" · 24 h voraus), automatisch zur Jetzt-Position gescrollt.

### Termin-Cross-Check
Bekannte High-Impact-Events (NFP, US-CPI, PCE, FOMC) **erzwingen ROT** in der
betroffenen Stunde — unabhängig von der Modell-Einschätzung. Liegt ein solches
Event im aktuellen Stundenfenster, wird auch die Tages-Ampel auf ROT gezogen.

### Push-Benachrichtigung
Beim **Wechsel nach ROT** (und bei Entwarnung) schickt das Skript einen Push —
per **ntfy.sh** (ohne Account) und/oder **Telegram**. Nur bei Zustandswechsel,
kein Spam. Ohne konfigurierte Kanäle wird der Push übersprungen.

### Bot-Signal (`data/signal.json`)
Kompaktes, maschinenlesbares Flag, das deine Bots direkt pollen können:

```json
{
  "generatedAt": "2026-08-10T14:00:00.000Z",
  "effectiveStatus": "rot",
  "pause": true,
  "caution": false,
  "dayStatus": "rot",
  "statusText": "FOMC-Entscheid",
  "empfehlung": "…",
  "source": "nq-pause-board"
}
```

Bot-Logik z. B.: `if (signal.pause) botsAnhalten()`. Wird bei jedem Lauf
aktualisiert (alle ~4 h); für stündliche Details siehe `status.json`.

### Verlauf & Quellen
`data/history.json` protokolliert die Gesamt-Ampel jedes Laufs. Das Frontend
zeigt einen Verlaufs-Streifen und **„Zeit seit letztem ROT"**. Zusätzlich liefert
das Modell 2–4 **Quell-Links** und ein **Confidence-Level** zur Nachprüfung.

### Stale-/Wochenend-Warnung
Ist die letzte Einschätzung im Handelsfenster älter als ~6 h, warnt das Frontend
(„Daten veraltet"). Am Wochenende zeigt es stattdessen einen ruhigen Hinweis
(„Markt geschlossen").

### `data/status.json` — Schema

```json
{
  "generatedAt": "2026-08-10T21:00:00.000Z",
  "status": "gruen",
  "statusText": "Ruhige Lage",
  "empfehlung": "Bots normal laufen lassen",
  "headline": "Kurze Ticker-Zeile",
  "body": "2-3 Sätze Begründung",
  "confidence": "mittel",
  "quellen": [{ "titel": "Reuters", "url": "https://…" }],
  "rueckblickSummary": "2-3 Sätze",
  "rueckblick": [{ "stunde": "14:00", "status": "gruen" }],
  "ausblickSummary": "2-3 Sätze",
  "forecast": [{ "stunde": "22:00", "status": "gelb" }],
  "forecastDetail": [{ "stunde": "22:00", "status": "gelb", "kommentar": "…" }]
}
```

---

## Setup

### 1. Anthropic API-Key als Secret
**Settings → Secrets and variables → Actions → New repository secret**
Name `ANTHROPIC_API_KEY`, Wert dein Key. Konto braucht **Guthaben** (Billing).

Optional (Variables statt Secret): `ANTHROPIC_MODEL` (Default `claude-sonnet-4-5`),
`BOARD_URL`, `NTFY_SERVER`.

### 2. Push-Kanäle (optional)
Als **Secrets** hinterlegen — je nach gewünschtem Kanal:

- **ntfy.sh** (ohne Account): `NTFY_TOPIC` = ein frei gewähltes, geheimes Topic
  (z. B. `nq-pause-board-a7x9`). In der ntfy-App dasselbe Topic abonnieren. Fertig.
- **Telegram**: `TELEGRAM_BOT_TOKEN` (von @BotFather) und `TELEGRAM_CHAT_ID`.

Ohne diese Secrets läuft alles normal, nur ohne Push.

### 3. GitHub Pages aktivieren
**Settings → Pages** → Source `Deploy from a branch` → Branch `main`, Ordner
`/ (root)`. Danach live unter `https://<user>.github.io/<repo>/`.

### 4. Workflow-Schreibrechte
Falls der Rück-Push scheitert: **Settings → Actions → General → Workflow
permissions → Read and write permissions**.

### 5. Erste Einschätzung auslösen
**Actions → „Update NQ Pause-Board Assessment" → Run workflow**. Danach läuft es
automatisch nach obigem Zeitplan.

---

## Lokal testen

```bash
cp .env.example .env      # ANTHROPIC_API_KEY (+ optional Push) eintragen
node --env-file=.env scripts/fetch-assessment.mjs
python3 -m http.server 8080   # Frontend unter http://localhost:8080
```

Voraussetzung: **Node 20+** (natives `fetch` und `--env-file`).

---

## Fehler-Verhalten

Der Workflow crasht bei API-Fehlern **nicht**: 3 Versuche mit Backoff (2 s, 4 s);
bleibt es dabei, werden **alle Dateien unangetastet** gelassen, ein klarer Log
geschrieben und mit Exit 0 beendet. Commit passiert nur bei tatsächlicher Änderung.

---

## Wartung: FOMC-/CPI-/PCE-Termine

| Termin | Berechnung | Pflege |
|--------|-----------|--------|
| **NFP** | 1. Freitag, 14:30 Zurich | automatisch |
| **US-CPI** | Heuristik: 2. Mittwoch, 14:30 | Datum prüfen |
| **PCE** | Heuristik: letzter Freitag, 14:30 | Datum prüfen |
| **FOMC** | feste Terminliste, 20:00 | **manuell nachpflegen** |

> ⚠️ Die **FOMC-Terminliste** steht an **zwei** Stellen und muss synchron gehalten
> werden: `FOMC_DATES` in `scripts/fetch-assessment.mjs` (für den Cross-Check) und
> in `index.html` (für die Termin-Anzeige). Aktuell gepflegt bis **Dez 2026**.

---

## Projektstruktur

```
.github/workflows/update-assessment.yml   # Zeitplan-Cron + manuelles Triggern
scripts/fetch-assessment.mjs              # Backend: API + Cross-Check + Push
data/status.json                          # volle Einschätzung (Frontend)
data/signal.json                          # Pause-Flag (Bots)
data/history.json                         # Verlauf der Gesamt-Ampel
index.html                                # statisches Frontend
.env.example · .gitignore · README.md
```
