#!/usr/bin/env python3
"""Generate one Contexo daily puzzle via the Meta contributor API.

Two calls per puzzle (small outputs keep reasoning inside the token budget):
  1. ranking call (xhigh)  -> 150-word human ranking + 2 bipolar axes + difficulty
  2. coords call (medium)   -> absolute [x,y] coords for the 149 words + answer_coords
     (coords are intuitive spatial layout; xhigh overthinks them into length failures)

Usage:
    SPARK_API_KEY=... python3 generate_puzzle.py --date 2026-09-14
    SPARK_API_KEY=... python3 generate_puzzle.py --next   # next date after latest puzzle file

Reads prompts from prompt_rank.txt and prompt_coords.txt (same directory as this script).
Writes site/data/puzzles/YYYY-MM-DD.json (repo-relative).
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

HERE = os.path.dirname(os.path.abspath(__file__))
if os.path.basename(HERE) == "scripts":
    REPO = os.path.dirname(HERE)  # running from a repo checkout (GitHub Actions)
else:
    REPO = os.path.join(HERE, "repo")  # running from ~/workspace/contexo
DATA = os.environ.get("CONTEXO_DATA", "/home/hatch/workspace/nearword/data")
API_URL = "https://api.meta.ai/v1/chat/completions"
MODEL = "muse-spark-1.3-contributor"
EFFORT_RANK = "xhigh"   # user's engine spec: the semantic ranking is the game's brain, max reasoning
EFFORT_COORDS = "medium"  # coords are intuitive spatial layout; xhigh overthinks them into length failures
MAX_TOKENS = 32000      # xhigh reasoning shares the output budget; 32k leaves room for reasoning + JSON
EPOCH = dt.date(2026, 9, 14)  # puzzle #1 (secret rotation anchor; do NOT change)
SERIES_START = dt.date(2026, 9, 7)  # first backfilled daily; puzzle_number counts from here

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


def _answer_order() -> list:
    # candidates.json keys are the answer pool in stable insertion order
    # (verified identical to the legacy answers.json ordering).
    with open(CANDIDATES_JSON) as f:
        return list(json.load(f).keys())


answers = _answer_order()
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


def load_prompts() -> tuple[str, str]:
    rank_tpl = open(os.path.join(HERE, "prompt_rank.txt")).read()
    coords_tpl = open(os.path.join(HERE, "prompt_coords.txt")).read()
    return rank_tpl, coords_tpl


def call_api(prompt: str, api_key: str | None, call_name: str, effort: str) -> str:
    """One contributor call with retries.

    Retries transient network errors AND finish_reason=length (model rambled):
    on length, nudge it to be concise and try again.
    """
    import time
    import http.client

    payload = {
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "reasoning_effort": effort,
        "max_tokens": MAX_TOKENS,
    }
    last_err = None
    concise_nudge = (
        "\n\nIMPORTANT: Your previous attempt was too long. Reason as briefly as "
        "possible and output the JSON object immediately."
    )
    for attempt in range(3):
        body_payload = dict(payload)
        if attempt > 0 and last_err == "length":
            body_payload["messages"] = [
                {"role": "user", "content": prompt + concise_nudge}
            ]
        req = urllib.request.Request(
            API_URL,
            data=json.dumps(body_payload).encode(),
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
            with urllib.request.urlopen(req, timeout=600) as resp:
                body = json.load(resp)
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                last_err = exc
                time.sleep(10 * (attempt + 1))
                continue
            raise RuntimeError(f"API HTTP {exc.code}: {exc.read().decode()[:500]}")
        except (http.client.IncompleteRead, http.client.RemoteDisconnected, TimeoutError) as exc:
            last_err = exc
            time.sleep(5 * (attempt + 1))
            continue
        choice = (body.get("choices") or [{}])[0]
        content = (choice.get("message") or {}).get("content")
        if not content:
            if choice.get("finish_reason") == "length":
                last_err = "length"
                time.sleep(5)
                continue
            raise RuntimeError(
                f"API returned no content (finish_reason={choice.get('finish_reason')}, "
                f"model={body.get('model')})"
            )
        return content
    raise RuntimeError(f"API {call_name} failed after 3 attempts: {last_err}")


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
    assert set(p.keys()) == {"secret", "axes", "ranks", "coords", "answer_coords"}, f"keys: {p.keys()}"
    assert p["secret"] == secret, "secret mismatch"
    assert len(p["axes"]) == 2 and all(set(a) == {"label", "negative", "positive"} for a in p["axes"])
    assert len(p["ranks"]) == 150 and p["ranks"][0] == secret and len(set(p["ranks"])) == 150
    assert len(p["coords"]) == 149 and secret not in p["coords"]
    assert set(p["coords"].keys()) == set(p["ranks"][1:])
    for w, xy in p["coords"].items():
        assert len(xy) == 2 and all(-1 <= v <= 1 for v in xy), f"bad coords {w}"
    assert len(p["answer_coords"]) == 2 and all(-1 <= v <= 1 for v in p["answer_coords"])


def gen_ranking(secret: str, api_key: str | None, rank_tpl: str) -> dict:
    """Call 1 (xhigh): 150-word human ranking + 2 bipolar axes."""
    prompt = rank_tpl.replace("{{SECRET}}", secret).replace(
        "{{CANDIDATES}}", get_candidates(secret)
    )
    raw = call_api(prompt, api_key, "ranking", EFFORT_RANK)
    p = extract_json(raw)
    assert p.get("secret") == secret, "secret mismatch in ranking call"
    assert len(p.get("axes", [])) == 2 and all(
        set(a) == {"label", "negative", "positive"} for a in p["axes"]
    ), "bad axes"
    ranks = p.get("ranks", [])
    assert len(ranks) == 150 and ranks[0] == secret and len(set(ranks)) == 150, "bad ranks"
    return p


def load_difficulty() -> dict:
    """Deterministic difficulty from word-frequency order (data/difficulty.json).

    The LLM defaulted to 'Easy' for everything, so difficulty is assigned by
    frequency rank: Easy <1500, Standard <3500, Hard otherwise.
    """
    with open(os.path.join(REPO, "data", "difficulty.json")) as f:
        return json.load(f)


def gen_coords(secret: str, ranks: list, axes: list, api_key: str | None, coords_tpl: str) -> dict:
    """Call 2 (medium): absolute [x,y] coords for the 149 non-secret words + answer_coords.

    Retries on key mismatch (model occasionally drops/renames a word).
    """
    ranked_lines = "\n".join(f"{i + 1}: {w}" for i, w in enumerate(ranks))
    base_prompt = (
        coords_tpl.replace("{{SECRET}}", secret)
        .replace("{{RANKS}}", ranked_lines)
        .replace("{{AXIS1_NEG}}", axes[0]["negative"])
        .replace("{{AXIS1_POS}}", axes[0]["positive"])
        .replace("{{AXIS2_NEG}}", axes[1]["negative"])
        .replace("{{AXIS2_POS}}", axes[1]["positive"])
    )
    expected = set(ranks[1:])
    last_err = None
    for attempt in range(3):
        prompt = base_prompt
        if attempt > 0:
            prompt += (
                "\n\nIMPORTANT: Your previous response had wrong keys. Output coords for "
                "EXACTLY these 149 words, no more, no fewer, spelled exactly as shown, "
                "and do NOT include the secret:\n" + ", ".join(ranks[1:])
            )
        raw = call_api(prompt, api_key, "coords", EFFORT_COORDS)
        p = extract_json(raw)
        coords = p.get("coords", {})
        if set(coords.keys()) != expected or secret in coords:
            last_err = f"coords keys != ranks[1:] (got {len(coords)} keys)"
            continue
        for w, xy in coords.items():
            assert len(xy) == 2 and all(-1 <= v <= 1 for v in xy), f"bad coords {w}"
        ac = p.get("answer_coords", [])
        assert len(ac) == 2 and all(-1 <= v <= 1 for v in ac), "bad answer_coords"
        return p
    raise AssertionError(last_err or "coords key mismatch")


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


def generate(date: dt.date, api_key: str, rank_tpl: str, coords_tpl: str) -> dict:
    secret = secret_for_date(date)
    # Call 1 (xhigh): ranking + axes + difficulty
    part1 = gen_ranking(secret, api_key, rank_tpl)
    # Call 2 (xhigh): coordinates, grounded in the ranking + axes
    part2 = gen_coords(secret, part1["ranks"], part1["axes"], api_key, coords_tpl)
    puzzle = {
        "secret": secret,
        "axes": part1["axes"],
        "ranks": part1["ranks"],
        "coords": part2["coords"],
        "answer_coords": part2["answer_coords"],
    }
    validate(puzzle, secret)
    rank_set = set(puzzle["ranks"])
    tail = [w for w, _ in candidates_cache[secret] if w not in rank_set][:350]
    puzzle["tail"] = tail
    difficulty = load_difficulty().get(secret, "Standard")
    puzzle["meta"] = {
        "puzzle_number": (date - SERIES_START).days + 1,
        "date": date.isoformat(),
        "difficulty": difficulty,
        "model": MODEL,
        "effort": f"rank:{EFFORT_RANK}/coords:{EFFORT_COORDS}",
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
    rank_tpl, coords_tpl = load_prompts()
    try:
        generate(date, api_key, rank_tpl, coords_tpl)
    except Exception as exc:
        print(f"FAILED {date}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
