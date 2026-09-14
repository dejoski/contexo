# Contexo — Site Build Spec

Static site. No build step, no backend, no framework. Mobile-first (iPhone), dark/light themes.

## File layout (all under `site/`)
- `index.html` — shell, modals (how-to, stats, give-up, share), radar canvas, guess list
- `styles.css` — themes via CSS vars, mobile-first
- `app.js` — all game logic
- `data/vocab.json` — array of 5,219 lowercase words (guess validation)
- `data/index.json` — `{"puzzles":["2026-09-14",...],"latest":"2026-10-13"}`
- `data/puzzles/YYYY-MM-DD.json` — one puzzle per day

## Puzzle JSON format
```json
{
  "secret": "coffee",
  "axes": [
    {"label": "Drink vs Food", "negative": "Food", "positive": "Drink"},
    {"label": "Energy", "negative": "Calming", "positive": "Stimulating"}
  ],
  "ranks": ["coffee", "espresso", ... 150 total, ranks[0] is the secret],
  "tail": ["word", ... 350 more words in rough order],
  "coords": {"espresso": [0.92, 0.75], ... 149 entries, every ranks[1..149] word, [x,y] in [-1,1]},
  "answer_coords": [0.95, 0.8],
  "meta": {"puzzle_number": 1, "date": "2026-09-14", "difficulty": "Easy"}
}
```
Rank lookup: word in `ranks` → index+1. Else in `tail` → 151+index. Else → null, displayed as "500+".

## Game modes
- **Daily**: puzzle file for the player's local date (`data/puzzles/<local YYYY-MM-DD>.json`). Numbered `#<puzzle_number>`. State in localStorage `contexo:daily:<date>`: `{guesses: [{w, rank}], hints: n, won: bool, gaveUp: bool}`. Streak in `contexo:streak`: `{current, best, lastWonDate, repairsLeft, lastRepairWeek}`.
- **Practice**: random puzzle from `index.json` (not today). State in `contexo:practice` (single slot, overwrite). Never touches daily stats/streak.
- **How to Play** overlay on first visit (`contexo:seenHowTo`).

## Core actions
- **Guess**: text input + button. Normalize lowercase/trim. Must be in vocab.json else shake + "Not in word list". Duplicates ignored with a nudge. Each guess appended with rank; list sorted by rank ascending (best first), each row: rank badge, word, arrow, signal.
- **Hint** (one-tap, unlimited): let best = min rank among guesses+hints so far (secret excluded). Target = round(best/2). Hint = the unused word in `ranks` whose rank is closest to target (ties → smaller rank), never the secret unless best == 2 (then hint IS the secret — player basically won). Hints count in stats/share. Disabled only when rank 1 achieved.
- **Give up**: confirm → reveal secret, show full top-150 list, mark gaveUp (streak breaks, game counts as played-not-won).

## Radar (the killer feature)
- Square canvas. Draw X/Y axis lines with pole labels at the four ends (from `axes`). Subtle grid.
- Each guess with coords → dot at `px = cx + x*R`, `py = cy - y*R`. Dot color by rank band. Latest guess pulses.
- Guesses with rank null (500+) → small gray dots placed on the border circle at evenly spaced angles (in guess order) = "off the map".
- The secret's position is NEVER plotted.
- **Arrow per guess row**: angle from guess to secret: `θ = atan2(wy - gy, wx - gx)`. Render a `➤` glyph rotated by `-θ` in CSS degrees (screen y is down). If guess has no coords, no arrow (show ❄️).
- **Signal readout**: `d = hypot(wx-gx, wy-gy)`, `signal = round((1 - d/2.828) * 100)` → "Signal 87". No coords → "Signal —".
- A 3-guess triangulation must be visually obvious: dots + arrows converging.

## Rank color bands
1 → gold `#ffd700` (row shows ⭐). 2–10 `#22c55e`. 11–25 `#84cc16`. 26–50 `#eab308`. 51–100 `#f97316`. 101–150 `#ef4444`. 151–500 `#9ca3af`. 500+ `#4b5563`.

## Stats modal (localStorage `contexo:stats`)
Played, won, win %, current/best streak, median guesses (wins only), guess-count distribution (1,2-10,11-25,26-50,51-100,101+). Practice excluded.

## Share card (copy to clipboard, spoiler-free)
Exact format:
```
Contexo #12 · Easy
🎯 24 guesses · 2 hints · 🔥 5 streak
🟩🟨🟧🟥⬛⭐
contexo — guess the secret word
```
Heat strip: one emoji per guess in guess order, capped at 30 then `…+N`: rank 1 → ⭐ (only the winning guess), 2–10 🟩, 11–50 🟨, 51–150 🟧, 151–500 🟥, 500+ ⬛. Gave-up games: header `Contexo #12 · gave up` and strip without ⭐.

## Versus / challenge
"Challenge a friend" button copies link `<origin>/?d=2026-09-14`. Opening with `?d=` loads that date's puzzle as a one-off game (doesn't affect streak). Compare share cards.

## Streak repair
If `lastWonDate` is the day before yesterday (one missed day) and `repairsLeft > 0`, show "Repair streak (1 left this week)" → sets lastWonDate to yesterday, decrements. `repairsLeft` resets to 1 each Monday.

## Themes
Dark default, light toggle in header, persisted `contexo:theme`. CSS vars only.

## Offline
After first load, cache the puzzle JSON in localStorage `contexo:cache:<date>`. If fetch fails, use cache.

## QA bar (real Chromium, puppeteer-core, /opt/meta-chromium/chrome, headless 'new', --no-sandbox)
Serve `site/` over http (python http.server). Playtest must OBSERVE and report exact values:
1. Page loads, radar canvas renders with axis labels from the puzzle JSON.
2. Type "dog" (or a vocab word) → row appears with an exact rank number; dot appears on radar.
3. Type the secret → win state, ⭐, stats update, share card copies with exact format.
4. Hint button → adds a word at ~half the best rank; unlimited (press 3×, all add words).
5. Give-up flow reveals secret + top-150.
6. Reload mid-game → guesses persist.
7. Practice mode loads a different puzzle, doesn't touch daily stats.
8. Theme toggle works. Mobile viewport (390×844) renders cleanly.
Report EXACT observed ranks/words/numbers. Fix failures, re-test. Do not report done until all green.
