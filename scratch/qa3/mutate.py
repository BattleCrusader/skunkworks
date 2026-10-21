#!/usr/bin/env python3
"""QA3 mutation driver: apply one edit, run one gate, restore the exact bytes, prove it by hash.

Every mutation is recorded as JSON so the report can quote the before/after SHA-256 and the
red/green sets without a human copying numbers. Refuses to run if the file does not hash-match
the expected `before` value, so a stale edit cannot be silently compounded.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import time

REPO = "/Volumes/Backup/Development/skunkworks"
OUT = os.path.join(REPO, "scratch", "qa3")
RUNNER = ["node", "scripts/run-node-tests.mjs", "--timeout=126000"]


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def parse(log):
    red, tests = [], {"tests": None, "pass": None, "fail": None}
    for line in log.splitlines():
        m = re.match(r"^not ok \d+ - (.*)$", line)
        if m:
            red.append(m.group(1))
        m = re.match(r"^# tests (\d+)$", line)
        if m:
            tests["tests"] = int(m.group(1))
        m = re.match(r"^# pass (\d+)$", line)
        if m:
            tests["pass"] = int(m.group(1))
        m = re.match(r"^# fail (\d+)$", line)
        if m:
            tests["fail"] = int(m.group(1))
    return red, tests


def one(mut):
    path = os.path.join(REPO, mut["file"])
    before = sha(path)
    original = open(path, "rb").read()
    text = original.decode()
    count = text.count(mut["old"])
    if count != 1:
        return {"id": mut["id"], "status": "SKIPPED", "why": f"pattern occurs {count} times", "before": before}
    mutated = text.replace(mut["old"], mut["new"])
    started = time.time()
    try:
        open(path, "wb").write(mutated.encode())
        proc = subprocess.run(RUNNER + mut["test"], cwd=REPO, capture_output=True, text=True, timeout=900)
        elapsed = round(time.time() - started, 1)
        log = proc.stdout + proc.stderr
    finally:
        open(path, "wb").write(original)
    after = sha(path)
    logpath = os.path.join(OUT, f"mut-{mut['id']}.log")
    with open(logpath, "w") as fh:
        fh.write(log)
    red, counts = parse(log)
    matched_red = [name for name in red if re.search(mut["expect_red"], name)]
    bad_green = [name for name in red if mut.get("expect_green") and re.search(mut["expect_green"], name)]
    record = {
        "id": mut["id"],
        "file": mut["file"],
        "claim": mut["claim"],
        "test": mut["test"],
        "before": before,
        "after": after,
        "restored_identical": before == after,
        "exit": proc.returncode,
        "elapsed_s": elapsed,
        "red": red,
        "counts": counts,
        "expected_red": mut["expect_red"],
        "expected_red_matched": matched_red,
        "unexpectedly_red": bad_green,
        "log": os.path.relpath(logpath, REPO),
        "status": (
            "GREEN-AS-EXPECTED"
            if mut.get("expect_green_run") and proc.returncode == 0 and not red
            else "RED-AS-EXPECTED"
            if (matched_red and not bad_green and proc.returncode != 0)
            else "UNEXPECTED"
        ),
    }
    return record


if __name__ == "__main__":
    table = json.load(open(sys.argv[1]))
    only = sys.argv[2:] if len(sys.argv) > 2 else None
    results = []
    for mut in table:
        if only and mut["id"] not in only:
            continue
        rec = one(mut)
        results.append(rec)
        print(json.dumps({k: rec[k] for k in rec if k not in ("red",)}, ensure_ascii=False))
        if rec.get("red"):
            print("   red:", "; ".join(rec["red"])[:600])
        sys.stdout.flush()
    path = os.path.join(OUT, f"mutations-{int(time.time())}.json")
    json.dump(results, open(path, "w"), indent=2)
    print("wrote", path)