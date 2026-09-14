# Contexo

The LLM-powered word-guessing game. Guess the secret word — every guess gets a **rank** (1 = the secret), a dot on a **2-D semantic radar**, and a **compass arrow** pointing toward the answer. Triangulate it with logic, not luck.

Live at: **https://dejoski.github.io/contexo/** (GitHub Pages, auto-built from the `gh-pages` branch)

## How it works

- 97 daily puzzles preloaded (2026-09-07 … 2026-12-12), each **precomputed by an LLM** (`muse-spark-1.3-contributor`): a human-quality top-150 ranking, two bipolar semantic axes (e.g. *Drink ↔ Food*, *Calming ↔ Stimulating*), and (x, y) coordinates for every ranked word. Secrets are unique across all 97 puzzles.
- The site itself is fully static (`site/`): `index.html` + `styles.css` + `app.js`. No backend, no build step.
- A GitHub Action (`.github/workflows/daily-puzzle.yml`) generates the next day's puzzle every night at 00:05 ET and commits it.

## Repo layout

```
site/                    # the game (static)
  index.html
  styles.css
  app.js
  data/
    vocab.json           # 20,022 guessable words
    index.json           # puzzle date index (97 dates)
    puzzles/YYYY-MM-DD.json
scripts/
  generate_puzzle.py     # builds one puzzle via the Meta model API
  run_dates.py           # batch-generate a list of dates
  validate_puzzles.py    # full SPEC validation of every puzzle + index
data/
  candidates.json        # MiniLM top-500 candidates per answer (generator input)
  difficulty.json        # deterministic difficulty per secret (frequency rule)
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

- Daily puzzle (local-midnight reset) + infinite Practice mode + **Archive** (replay any past daily; counts toward stats, never touches streak)
- 2-D radar with per-guess compass arrows and signal strength
- Unlimited one-tap halving hints, give-up with full answer list
- Stats dashboard, streaks with weekly repair, Wordle-grade emoji share cards (auto-opens on win, native share on mobile)
- Friend challenges via date-encoded links, dark/light themes, offline-friendly
