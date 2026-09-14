#!/usr/bin/env python3
"""Generate one Contexo daily puzzle via the Meta contributor API.

Usage:
    SPARK_API_KEY=... python3 generate_puzzle.py --date 2026-09-14
    SPARK_API_KEY=... python3 generate_puzzle.py --next   # next date after latest puzzle file

Reads the generator prompt from prompt.txt (extracted from design_puzzle.txt).
Writes data/puzzles/YYYY-MM-DD.json (repo-relative).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import random
import sys
import urllib.request
import urllib.error

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
if os.path.basename(HERE) == "scripts":
    REPO = os.path.dirname(HERE)  # running from a repo checkout (GitHub Actions)
else:
    REPO = os.path.join(HERE, "repo")  # running from ~/workspace/contexo
DATA = os.environ.get("CONTEXO_DATA", "/home/hatch/workspace/nearword/data")
API_URL = "https://api.meta.ai/v1/chat/completions"
MODEL = "muse-spark-1.3-contributor"
EFFORT = "medium"      # ranking/coords are intuitive judgments; keep reasoning small so the JSON fits
MAX_TOKENS = 16000
EPOCH = dt.date(2026, 9, 14)  # puzzle #1

CANDIDATES_JSON = os.path.join(REPO, "data", "candidates.json")
candidates_cache = None


def load_words():
    """Local dev path: numpy + embeddings. Not used in Actions."""
    import numpy as np
    words = json.load(open(os.path.join(DATA, "words.json")))
    E = np.fromfile(os.path.join(DATA, "embeddings.f32"), dtype=np.float32).reshape(len(words), 384)
    En = E / np.linalg.norm(E, axis=1, keepdims=True)
    return words, En, {w: i for i, w in enumerate(words)}


def get_candidates(secret: str, n: int = 300) -> str:
    global candidates_cache
    if candidates_cache is None:
        candidates_cache = json.load(open(CANDIDATES_JSON))
    return "\n".join(f"{w}: {s:.4f}" for w, s in candidates_cache[secret][:n])


answers = json.load(open(os.path.join(DATA, "answers.json")))
try:
    _w, _En, _w2i = load_words()
    w2i = _w2i
    answers = [a for a in answers if a in w2i]
except Exception:
    w2i = {}
rng = random.Random(20260914)
order = answers[:]
rng.shuffle(order)


def secret_for_date(date: dt.date) -> str:
    return order[(date - EPOCH).days % len(order)]


def load_prompt() -> str:
    text = open(os.path.join(HERE, "prompt_gen.txt")).read()
    return text


def call_api(prompt: str, api_key: str | None) -> str:
    import time
    import http.client

    payload = {
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "reasoning_effort": EFFORT,
        "max_tokens": MAX_TOKENS,
    }
    last_err = None
    for attempt in range(4):
        req = urllib.request.Request(
            API_URL,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        if api_key:
            req.add_header("Authorization", f"Bearer {api_key}")
        else:
            # Local dev: use the connected credential via authd surrogate.
            sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
            import dynamic_credentials as dc
            dc.add_surrogate_to_request(req, "custom.meta-model-api", allowed_hosts=["api.meta.ai"])
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                body = json.load(resp)
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"API HTTP {exc.code}: {exc.read().decode()[:500]}")
        except (http.client.IncompleteRead, http.client.RemoteDisconnected, TimeoutError) as exc:
            last_err = exc
            time.sleep(5 * (attempt + 1))
            continue
        choice = (body.get("choices") or [{}])[0]
        content = (choice.get("message") or {}).get("content")
        if not content:
            raise RuntimeError(
                f"API returned no content (finish_reason={choice.get('finish_reason')}, "
                f"model={body.get('model')})"
            )
        return content
    raise RuntimeError(f"API read failed after 4 attempts: {last_err}")


def extract_json(text: str) -> dict:
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else t
        if t.rsplit("```", 1)[0].strip():
            t = t.rsplit("```", 1)[0]
    t = t.strip()
    if t.endswith("```"):
        t = t[:-3]
    start = t.find("{")
    end = t.rfind("}")
    return json.loads(t[start:end + 1])


def validate(p: dict, secret: str):
    assert set(p.keys()) == {"secret", "axes", "ranks", "coords", "answer_coords", "difficulty"}, f"keys: {p.keys()}"
    assert p["secret"] == secret, "secret mismatch"
    assert p["difficulty"] in ("Easy", "Standard", "Hard"), "bad difficulty"
    assert len(p["axes"]) == 2 and all(set(a) == {"label", "negative", "positive"} for a in p["axes"])
    assert len(p["ranks"]) == 150 and p["ranks"][0] == secret and len(set(p["ranks"])) == 150
    assert len(p["coords"]) == 149 and secret not in p["coords"]
    assert set(p["coords"].keys()) == set(p["ranks"][1:])
    for w, xy in p["coords"].items():
        assert len(xy) == 2 and all(-1 <= v <= 1 for v in xy), f"bad coords {w}"
    assert len(p["answer_coords"]) == 2 and all(-1 <= v <= 1 for v in p["answer_coords"])


def difficulty(secret: str) -> str:
    if not w2i:
        return "Standard"
    i = w2i[secret]
    return "Easy" if i < 1500 else ("Standard" if i < 3500 else "Hard")


def latest_puzzle_date() -> dt.date | None:
    d = os.path.join(REPO, "site", "data", "puzzles")
    if not os.path.isdir(d):
        return None
    dates = []
    for f in os.listdir(d):
        if f.endswith(".json"):
            try:
                dates.append(dt.date.fromisoformat(f[:-5]))
            except ValueError:
                pass
    return max(dates) if dates else None


def generate(date: dt.date, api_key: str, prompt_tpl: str) -> dict:
    secret = secret_for_date(date)
    prompt = prompt_tpl.replace("{{SECRET}}", secret).replace("{{CANDIDATES}}", get_candidates(secret))
    raw = call_api(prompt, api_key)
    puzzle = extract_json(raw)
    validate(puzzle, secret)
    rank_set = set(puzzle["ranks"])
    tail = [w for w, _ in candidates_cache[secret] if w not in rank_set][:350]
    puzzle["tail"] = tail
    difficulty = puzzle.pop("difficulty")
    puzzle["meta"] = {
        "puzzle_number": (date - EPOCH).days + 1,
        "date": date.isoformat(),
        "difficulty": difficulty,
        "model": MODEL,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    out = os.path.join(REPO, "site", "data", "puzzles", date.isoformat() + ".json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump(puzzle, open(out, "w"), separators=(",", ":"))
    # refresh index.json
    idx_path = os.path.join(REPO, "site", "data", "index.json")
    try:
        idx = json.load(open(idx_path))
    except Exception:
        idx = {"puzzles": [], "latest": None}
    ds = date.isoformat()
    if ds not in idx["puzzles"]:
        idx["puzzles"].append(ds)
        idx["puzzles"].sort()
    idx["latest"] = idx["puzzles"][-1]
    json.dump(idx, open(idx_path, "w"))
    print(f"OK {out} secret={secret} difficulty={difficulty}")
    return puzzle


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date")
    ap.add_argument("--next", action="store_true")
    args = ap.parse_args()
    api_key = os.environ.get("SPARK_API_KEY")  # set in GitHub Actions secrets; local falls back to surrogate
    if args.next:
        latest = latest_puzzle_date()
        date = (latest + dt.timedelta(days=1)) if latest else EPOCH
    else:
        date = dt.date.fromisoformat(args.date)
    prompt_tpl = load_prompt()
    try:
        generate(date, api_key, prompt_tpl)
    except Exception as exc:
        print(f"FAILED {date}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
