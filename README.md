# Contexo

The LLM-powered word-guessing game. Guess the secret word — every guess gets a **rank** (1 = the secret), a dot on a **2-D semantic radar**, and a **compass arrow** pointing toward the answer. Triangulate it with logic, not luck.

Live at: *(connect this repo in Vercel — one click, no config needed)*

## How it works

- Each daily puzzle is **precomputed by an LLM** (`muse-spark-1.3-contributor`): a human-quality top-150 ranking, two bipolar semantic axes (e.g. *Drink ↔ Food*, *Calming ↔ Stimulating*), and (x, y) coordinates for every ranked word.
- The site itself is fully static (`site/`): `index.html` + `styles.css` + `app.js`. No backend, no build step.
- A GitHub Action (`.github/workflows/daily-puzzle.yml`) generates the next day's puzzle every night at 00:05 ET and commits it. Vercel redeploys automatically.

## Repo layout

```
site/                    # the game (static)
  index.html
  styles.css
  app.js
  data/
    vocab.json           # 5,219 guessable words
    index.json           # puzzle date index
    puzzles/YYYY-MM-DD.json
scripts/
  generate_puzzle.py     # builds one puzzle via the Meta model API
data/
  candidates.json        # MiniLM top-500 candidates per answer (generator input)
SPEC.md                  # full game design spec
```

## Setup needed (one time)

1. **Model API key** — the daily Action needs `SPARK_API_KEY` in repo Settings → Secrets → Actions. It's a Bearer token for `https://api.meta.ai/v1/chat/completions` (model `muse-spark-1.3-contributor`).
2. **Vercel** — Import `dejoski/contexo` in the Vercel dashboard, set root to `site/` (or leave root and it serves statically). Every push redeploys.

## Generating puzzles manually

```bash
python3 scripts/generate_puzzle.py --date 2026-09-20   # one date
python3 scripts/generate_puzzle.py --next               # day after latest puzzle
```

Local runs use the connected credential automatically; CI uses `SPARK_API_KEY`.

## Game features

- Daily puzzle (local-midnight reset) + infinite Practice mode
- 2-D radar with per-guess compass arrows and signal strength
- Unlimited one-tap halving hints, give-up with full answer list
- Stats dashboard, streaks with weekly repair, Wordle-grade emoji share cards
- Friend challenges via date-encoded links, dark/light themes, offline-friendly
