#!/usr/bin/env python3
"""Validate every Contexo puzzle file against the SPEC.

Checks per file:
  - 150 unique ranked words, secret at rank #1
  - exactly 149 coordinate entries, keys == ranks[1:]
  - coords within [-1, 1]; answer_coords present and in [-1, 1]
  - 350 unique tail words, no overlap with ranks
  - valid axes (2 bipolar) and metadata (puzzle_number, date, difficulty, model, effort)
Also: all secrets unique across files; index.json matches filenames.

Usage: python3 scripts/validate_puzzles.py
Exit 0 if all pass, 1 with a report otherwise.
"""
import datetime as dt
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
PZ = os.path.join(REPO, "site", "data", "puzzles")

errors = []
files = sorted(glob.glob(os.path.join(PZ, "*.json")))
secrets = {}

for f in files:
    ds = os.path.basename(f)[:-5]
    try:
        p = json.load(open(f))
    except Exception as exc:
        errors.append(f"{ds}: not valid JSON ({exc})")
        continue
    tag = ds
    try:
        assert set(p.keys()) == {"secret", "axes", "ranks", "coords", "answer_coords", "tail", "meta"}, f"keys={sorted(p.keys())}"
        secret = p["secret"]
        assert isinstance(secret, str) and secret, "bad secret"
        if secret in secrets:
            errors.append(f"{ds}: secret '{secret}' duplicates {secrets[secret]}")
        else:
            secrets[secret] = ds
        ranks = p["ranks"]
        assert isinstance(ranks, list) and len(ranks) == 150, f"ranks len={len(ranks) if isinstance(ranks, list) else '?'}"
        assert len(set(ranks)) == 150, "ranks not unique"
        assert ranks[0] == secret, "secret not rank #1"
        assert all(isinstance(w, str) and w for w in ranks), "bad rank words"
        coords = p["coords"]
        assert isinstance(coords, dict) and len(coords) == 149, f"coords len={len(coords) if isinstance(coords, dict) else '?'}"
        assert secret not in coords, "secret in coords"
        assert set(coords.keys()) == set(ranks[1:]), "coords keys != ranks[1:]"
        for w, xy in coords.items():
            assert isinstance(xy, list) and len(xy) == 2 and all(isinstance(v, (int, float)) and -1 <= v <= 1 for v in xy), f"bad coords {w}"
        ac = p["answer_coords"]
        assert isinstance(ac, list) and len(ac) == 2 and all(isinstance(v, (int, float)) and -1 <= v <= 1 for v in ac), "bad answer_coords"
        tail = p["tail"]
        assert isinstance(tail, list) and len(tail) == 350, f"tail len={len(tail) if isinstance(tail, list) else '?'}"
        assert len(set(tail)) == 350, "tail not unique"
        assert not (set(tail) & set(ranks)), "tail overlaps ranks"
        axes = p["axes"]
        assert isinstance(axes, list) and len(axes) == 2, "axes != 2"
        for a in axes:
            assert set(a.keys()) == {"label", "negative", "positive"}, f"axis keys={a.keys()}"
            assert all(isinstance(a[k], str) and a[k] for k in ("label", "negative", "positive")), "bad axis strings"
        meta = p["meta"]
        for k in ("puzzle_number", "date", "difficulty", "model", "effort"):
            assert k in meta, f"meta missing {k}"
        assert meta["date"] == ds, f"meta.date {meta['date']} != filename {ds}"
        assert meta["difficulty"] in ("Easy", "Standard", "Hard"), f"bad difficulty {meta['difficulty']}"
        assert meta["puzzle_number"] == (dt.date.fromisoformat(ds) - dt.date(2026, 9, 7)).days + 1, \
            f"puzzle_number {meta['puzzle_number']} wrong"
    except AssertionError as exc:
        errors.append(f"{tag}: {exc}")

# index.json must list exactly the puzzle files, sorted
try:
    idx = json.load(open(os.path.join(REPO, "site", "data", "index.json")))
    want = sorted(os.path.basename(f)[:-5] for f in files)
    assert idx.get("puzzles") == want, f"index puzzles mismatch (have {len(idx.get('puzzles', []))}, want {len(want)})"
    assert idx.get("latest") == (want[-1] if want else None), "index latest wrong"
except AssertionError as exc:
    errors.append(f"index.json: {exc}")
except Exception as exc:
    errors.append(f"index.json: unreadable ({exc})")

print(f"validated {len(files)} puzzles, {len(secrets)} unique secrets")
if errors:
    print(f"FAILED ({len(errors)}):")
    for e in errors:
        print("  -", e)
    sys.exit(1)
print("ALL GREEN")
