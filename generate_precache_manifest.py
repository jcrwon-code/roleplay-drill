#!/usr/bin/env python3
"""Lists every file under webapp/ (except this script and its own output) into
precache-manifest.json, which sw.js reads to cache everything for full
offline use after the first visit."""

import json
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
EXCLUDE = {"generate_precache_manifest.py", "precache-manifest.json", "sw.js"}

files = []
for dirpath, dirnames, filenames in os.walk(ROOT):
    dirnames[:] = [d for d in dirnames if not d.startswith(".")]
    for fn in filenames:
        if fn in EXCLUDE or fn.startswith("."):
            continue
        full = os.path.join(dirpath, fn)
        rel = os.path.relpath(full, ROOT)
        files.append(rel.replace(os.sep, "/"))

files.sort()
with open(os.path.join(ROOT, "precache-manifest.json"), "w", encoding="utf-8") as f:
    json.dump(files, f, ensure_ascii=False)

print(f"Wrote {len(files)} files to precache-manifest.json")
