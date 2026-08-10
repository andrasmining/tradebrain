# NQ Pause-Board

Ein Dashboard, das dir als **NQ-Futures Mean-Reversion-Trader** anzeigt, wann du
deine automatisierten Trading-Bots wegen Marktrisiko (News, Geopolitik,
Wirtschaftsdaten) besser pausieren solltest.

Statisches Frontend + GitHub Action als Backend, gehostet auf GitHub Pages.
Sprache der Oberfläche: Deutsch, Zeitzone Europe/Zurich.

> ⚠️ **Keine Anlageberatung.** Dieses Projekt ist ein persönliches Hilfsmittel.
> Einschätzungen können falsch oder veraltet sein — Handelsentscheidungen triffst
> du eigenverantwortlich.

---

## Architektur

Bewusst **kein Live-API-Call im Browser**. Ein Browser-seitiger Aufruf wäre bei
jedem Laden langsam und unzuverlässig; einmal pro Stunde im Hintergrund reicht.

```
   ┌──────────────────────────────────────────────┐
   │ GitHub Action (stündlich per cron +           │
   │ workflow_dispatch)                            │
   │   → scripts/fetch-assessment.mjs              │
   │        → Anthropic Messages API               │
   │          (Tool: web_search)                   │
   │        → schreibt data/status.json            │
   │        → committet die Datei zurück ins Repo  │
   └──────────────────────────────────────────────┘
                        │
                        ▼
   ┌──────────────────────────────────────────────┐
   │ GitHub Pages (statisch)                       │
   │   index.html liest beim Laden nur             │
   │   fetch('./data/status.json')                 │
   │   – kein API-Key, kein Live-Call, kein CORS   │
   │     (same-origin auf GitHub Pages)            │
   └──────────────────────────────────────────────┘
```

1. Die **GitHub Action** (`.github/workflows/update-assessment.yml`) läuft
   stündlich (`schedule`) plus manuell (`workflow_dispatch`).
2. Sie ruft `scripts/fetch-assessment.mjs` auf. Das Skript nutzt die Anthropic
   Messages API mit dem `web_search`-Tool, um die aktuelle Marktlage
   einzuschätzen.
3. Das Skript schreibt das Ergebnis nach `data/status.json` und der Workflow
   committet die Datei zurück ins Repo.
4. Das **Frontend** (`index.html`, reines HTML/CSS/JS, kein Framework) liest
   beim Laden nur `data/status.json` — kein API-Key im Frontend, keine Live-Calls.
5. Der Anthropic API-Key liegt als **GitHub Actions Secret** (`ANTHROPIC_API_KEY`),
   nie im Code.

### Kompaktes Prompt-Design

Das Modell liefert bewusst **keine 48 einzelnen JSON-Objekte** (Token-/Latenz-
Verschwendung, fehleranfällig), sondern kompakte Codes:

- `rueckblickCodes` — 24-Zeichen-String aus `G`/`Y`/`R` (ein Zeichen pro Stunde,
  älteste zuerst)
- `forecastCodes` — gleiches Format für die nächsten 24h
- `forecastKommentare` — 6 kurze Sätze für die ersten 6 Zukunftsstunden

Die **Uhrzeiten** berechnet das Skript deterministisch aus der aktuellen Zeit und
mappt sie per Index auf die Codes. Das Frontend muss dadurch nichts mehr
decodieren, sondern nur rendern.

### `data/status.json` — Schema

```json
{
  "generatedAt": "2026-08-10T21:00:00.000Z",
  "status": "gruen",
  "statusText": "Ruhige Lage",
  "empfehlung": "Bots normal laufen lassen",
  "headline": "Kurze Ticker-Zeile",
  "body": "2-3 Sätze Begründung",
  "rueckblickSummary": "2-3 Sätze",
  "rueckblick": [{ "stunde": "14:00", "status": "gruen" }],
  "ausblickSummary": "2-3 Sätze",
  "forecast": [{ "stunde": "22:00", "status": "gelb" }],
  "forecastDetail": [{ "stunde": "22:00", "status": "gelb", "kommentar": "..." }]
}
```

---

## Setup

### 1. Repository vorbereiten

Dieses Repo enthält bereits alles Nötige. Falls du forkst: nichts weiter zu tun.

### 2. Anthropic API-Key als Secret hinterlegen

1. Anthropic API-Key erstellen: <https://console.anthropic.com/>
2. Im Repo: **Settings → Secrets and variables → Actions → New repository secret**
3. Name: `ANTHROPIC_API_KEY`, Wert: dein Key.

Optional kannst du das Modell überschreiben:
**Settings → Secrets and variables → Actions → Variables → New variable**,
Name `ANTHROPIC_MODEL` (Default: `claude-sonnet-4-5`).

### 3. GitHub Pages aktivieren

1. Im Repo: **Settings → Pages**
2. **Source**: `Deploy from a branch`
3. **Branch**: `main` (bzw. dein Default-Branch), Ordner `/ (root)` → **Save**
4. Nach kurzer Zeit ist die Seite unter
   `https://<user>.github.io/<repo>/` erreichbar.

### 4. Erste Einschätzung auslösen

Die Action läuft stündlich automatisch. Für einen sofortigen Lauf:
**Actions → „Update NQ Pause-Board Assessment“ → Run workflow**.

> Hinweis: `schedule`-Trigger in GitHub Actions können sich um einige Minuten
> verzögern und laufen nur auf dem Default-Branch.

---

## Lokal testen

```bash
cp .env.example .env      # ANTHROPIC_API_KEY eintragen
node --env-file=.env scripts/fetch-assessment.mjs
```

Das schreibt (bei Erfolg) `data/status.json`. Das Frontend kannst du z.B. so
lokal ansehen:

```bash
python3 -m http.server 8080
# dann http://localhost:8080 öffnen
```

Voraussetzung: **Node 20+** (nutzt natives `fetch` und `--env-file`).

---

## Fehler-Verhalten

Der Workflow crasht bei API-Fehlern **nicht**. Das Skript:

- versucht den API-Call bis zu **3×** mit exponentiellem Backoff (2s, 4s),
- lässt bei anhaltendem Fehler die **alte `data/status.json` unangetastet**,
- schreibt einen **klaren Log-Eintrag** und beendet sich mit Exit-Code 0.

Der Commit-Schritt committet nur, wenn sich `data/status.json` tatsächlich
geändert hat.

---

## Wartung: FOMC-/CPI-/PCE-Termine

Ein Teil der Termine wird **statisch im Frontend** berechnet (kein API-Call):

| Termin | Berechnung | Pflege |
|--------|-----------|--------|
| **NFP** | 1. Freitag im Monat, 14:30 Zurich | automatisch |
| **US-CPI** | Heuristik: 2. Mittwoch, 14:30 Zurich | Datum periodisch prüfen |
| **PCE** | Heuristik: letzter Freitag, 14:30 Zurich | Datum periodisch prüfen |
| **FOMC** | feste Terminliste, 20:00 Zurich | **manuell nachpflegen** |

> ⚠️ Die **FOMC-Termine** stehen als Konstante `FOMC_DATES` in `index.html` und
> müssen **jährlich manuell aktualisiert** werden (offizielle Fed-Termine).
> CPI/PCE sind Heuristiken — für exakte Tage die offiziellen BLS/BEA-Termine
> abgleichen.

---

## Projektstruktur

```
.
├── .github/workflows/update-assessment.yml   # stündlicher Cron + manuelles Triggern
├── scripts/fetch-assessment.mjs              # Backend: API-Call → status.json
├── data/status.json                          # generierte Einschätzung (committet)
├── index.html                                # statisches Frontend
├── .env.example                              # lokales Testen
└── README.md
```
