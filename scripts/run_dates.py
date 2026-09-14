#!/usr/bin/env python3
"""Generate puzzles for explicit dates: run_dates.py 2026-09-15 2026-09-16 ..."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import generate_puzzle as gp

api_key = os.environ.get("SPARK_API_KEY")
rank_tpl, coords_tpl = gp.load_prompts()
failed = []
for ds in sys.argv[1:]:
    date = gp.dt.date.fromisoformat(ds)
    out = os.path.join(gp.REPO, "site", "data", "puzzles", ds + ".json")
    if os.path.exists(out):
        print(f"SKIP {ds} (exists)", flush=True)
        continue
    try:
        gp.generate(date, api_key, rank_tpl, coords_tpl)
    except Exception as exc:
        print(f"FAILED {ds}: {exc}", flush=True)
        failed.append(ds)
print(f"worker done: {len(sys.argv)-1-len(failed)} ok, {len(failed)} failed {failed}", flush=True)
