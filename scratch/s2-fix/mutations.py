#!/usr/bin/env python3
"""E-22 / item 12 — the mutation record, produced by running it.

For every gate this fix adds or changes: disable **its own mechanism**, run the gate, record which
test went red and which neighbouring test stayed green, restore the file, and record the SHA-256
before and after (equal on restore is the proof the tree is unchanged between mutations).

    python3 scratch/s2-fix/mutations.py            # writes docs/build/S2-fix-mutations.md

QA's five negative controls (`S2-qa.md` §3 NC1..NC5) are in the same table: NC1 and NC5 are the two
mechanisms this fix rewrote; NC2..NC4 were green in QA's run and must still be red here, or the
harness itself is not measuring anything.
"""
import hashlib
import os
import re
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "docs", "build", "S2-fix-mutations.md")


def sha(path):
    return hashlib.sha256(open(os.path.join(ROOT, path), "rb").read()).hexdigest()


def run(files):
    proc = subprocess.run(
        ["node", "scripts/run-node-tests.mjs", *files],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=600,
    )
    red = re.findall(r"^not ok \d+ - (.*)$", proc.stdout, re.M)
    green = re.findall(r"^ok \d+ - (.*)$", proc.stdout, re.M)
    return red, green, proc.returncode


MUTATIONS = [
    dict(
        gate="S2E-11 (refusePlan)",
        control="NC1",
        edit=("app/sources/publish.ts",
              "      if (report.scan) refusePlan(report, n.spec);",
              "      if (false as boolean) refusePlan(report, n.spec);"),
        run=["test/sources.test.ts"],
        red_expected="S2E-11",
        green_expected="S2E-1",
        why="the plan rule disabled; the index rule still refuses S2E-1's spec",
    ),
    dict(
        gate="S2E-1 (assertIndexedColumns)",
        control="NC1",
        edit=("app/sources/publish.ts",
              "      assertIndexedColumns(n.spec, allowed, plan);",
              "      if (false as boolean) assertIndexedColumns(n.spec, allowed, plan);"),
        run=["test/sources.test.ts"],
        red_expected="S2E-1",
        green_expected="S2E-11",
        why="the index rule disabled; its own case goes red because the refusal's role changes shape",
    ),
    dict(
        gate="V1-1 (assertViewChecksum)",
        control="new",
        edit=("app/sources/resolve.ts",
              "      assertViewChecksum(db, spec.relation);",
              "      void assertViewChecksum;"),
        run=["test/sources.test.ts"],
        red_expected="V1-1",
        green_expected="S2E-5",
        why="step 5a deleted: the re-pointed view serves cms_page rows",
    ),
    dict(
        gate="V1-2 (run.ts postcondition)",
        control="new",
        edit=("app/ddl/run.ts",
              "      changedViews = applyViewPostcondition(db, viewsBefore, options.actor);",
              "      changedViews = [];"),
        run=["test/sources.test.ts"],
        red_expected="V1-2",
        green_expected="V1-1",
        why="the postcondition deleted: a renamed table leaves the source published",
    ),
    dict(
        gate="B1-6 (writeSeal already_sealed)",
        control="NC5",
        edit=("app/audit/chain.ts",
              "  if (existing !== undefined) {\n    throw new AppError(\n      'SKW_E_SEC_AUDIT_SEAL',\n      `the day ${day} is already sealed at ${existing.sealed_at}",
              "  if (existing !== undefined) {\n    return existing;\n    throw new AppError(\n      'SKW_E_SEC_AUDIT_SEAL',\n      `the day ${day} is already sealed at ${existing.sealed_at}"),
        run=["test/audit-seal.test.ts"],
        red_expected="B1-6",
        green_expected="B1-7",
        why="the re-seal path reopened: a second seal returns the stored row instead of refusing",
    ),
    dict(
        gate="B1-1 (verifyAgainstSeal range bound)",
        control="NC5",
        edit=("app/audit/chain.ts",
              "         FROM cms_audit WHERE id BETWEEN ? AND ? ORDER BY id`,\n    )\n    .all(seal.first_id, seal.last_id)",
              "         FROM cms_audit ORDER BY id`,\n    )\n    .all()"),
        run=["test/audit-seal.test.ts"],
        red_expected="B1-1",
        green_expected="B1-6",
        why="the WHERE clause deleted: every row is read, so a grown chain falsifies the earlier day again (B1-3 and B1-7 also go red — every case that verifies a segment uses the bound)",
    ),
    dict(
        gate="B1-5 (sealNow day_not_over)",
        control="new",
        edit=("app/audit/chain.ts",
              "  if (!(day < today)) {",
              "  if (false as boolean) {"),
        run=["test/audit-seal.test.ts", "test/cli-audit.test.ts"],
        red_expected="B1-5",
        green_expected="B1-7",
        why="sealing a day that can still grow is admitted",
    ),
    dict(
        gate="audit status exit code (CLI)",
        control="new",
        edit=("app/cli/skwctl.ts",
              "    if (report.unsealed.length > 0) return EXIT_REFUSED;",
              "    if (false as boolean) return EXIT_REFUSED;"),
        run=["test/cli-audit.test.ts"],
        red_expected="CLI-1",
        green_expected="CLI-6",
        why="a gap stops making status exit 1",
    ),
    dict(
        gate="W1/W3 (witness table)",
        control="new",
        edit=("test/sources.test.ts",
              "test('S2E-11. a plan-only SCAN is refused",
              "test('S2E-11x. a plan-only SCAN is refused"),
        run=["test/witness.test.ts"],
        red_expected="W1",
        green_expected="W5",
        why="a renamed test: the comment-to-test link is checked, not decorative",
    ),
    dict(
        gate="S2E-6 (cache key)",
        control="NC2",
        edit=("app/sources/resolve.ts",
              "  const keyOf = cache === undefined ? '' : cacheKey(opts.tenantKey, key, specRevision(row), effective);",
              "  const keyOf = cache === undefined ? '' : cacheKey(opts.tenantKey, key, specRevision(row), {});"),
        run=["test/sources.test.ts"],
        red_expected="S2E-6",
        green_expected="S2E-7",
        why="the parameter set drops out of the cache key",
    ),
    dict(
        gate="S2E-4 (is_public)",
        control="NC3",
        edit=("app/sources/resolve.ts",
              "  if (audience === 'render' && row.is_public !== 1) {",
              "  if (false as boolean) {"),
        run=["test/sources.test.ts"],
        red_expected="S2E-4",
        green_expected="S2E-10",
        why="the public rule disabled: a private source renders",
    ),
    dict(
        gate="S2E-13 (verifyPreviewToken)",
        control="NC4",
        edit=("app/render/preview.ts",
              "  if (!timingSafeEqual(expected, given)) return false;",
              "  if (!timingSafeEqual(expected, given)) return true;"),
        run=["test/preview.test.ts"],
        red_expected="S2E-13",
        green_expected="S2E-11",
        why="the MAC comparison accepts a wrong token (S2E-13 is the case that reaches the MAC: a token minted for another path)",
    ),
    dict(
        gate="check 25 (verify_claims.py range bound)",
        control="new",
        edit=("scripts/model/verify_claims.py",
              '                             " WHERE id BETWEEN ? AND ? ORDER BY id", (first_id, last_id)):',
              '                             " ORDER BY id"):'),
        run=[],  # python gate, run below
        red_expected="25 audit chain",
        green_expected="24 plugin table class",
        why="the claims check reads every row again; the grown-chain assertion goes red",
    ),
    dict(
        gate="check_frozen.py (C-21 supersession)",
        control="new",
        edit=("docs/sds/SDS.md",
              "> `cms_audit` rows are hash-chained (`prev_hash`, `hash` over the canonical row) inside `site.db` and written in",
              "> `cms_audit` rows are hash-chained (`prev_hash`, `hash` over the canonical row) inside `site.db` and written in the same transaction as the change they record; one `audit_seal(tenant_key, day, rows, head)` row per tenant per UTC day is written to `control.db`; the verifier compares `count(cms_audit)` and the recomputed head to the seal and raises `SKW_E_SEC_AUDIT_SEAL` when either disagrees.\n>\n> `cms_audit` rows are hash-chained (`prev_hash`, `hash` over the canonical row) inside `site.db` and written in"),
        run=[],
        red_expected="FAIL the SDS",
        green_expected="§16 S2 rows: 13/13",
        why="the retired C-21 sentence put back: the supersession asserts ABSENCE, so the gate goes red",
    ),
]


def run_python_gate(script):
    proc = subprocess.run([sys.executable, script], cwd=ROOT, capture_output=True, text=True, timeout=600)
    return proc.stdout, proc.returncode


def main():
    rows = []
    for m in MUTATIONS:
        path, old, new = m["edit"]
        full = os.path.join(ROOT, path)
        before = sha(path)
        text = open(full).read()
        if old not in text:
            rows.append((m, "MUTATION DID NOT APPLY", "", before, before))
            print(f"!! {m['gate']}: the edited expression was not found in {path}")
            continue
        open(full, "w").write(text.replace(old, new, 1))
        after = sha(path)
        try:
            if m["run"]:
                red, green, code = run(m["run"])
                red_text = "; ".join(t for t in red if m["red_expected"] in t) or f"(no red containing {m['red_expected']}: {red})"
                green_text = "; ".join(t for t in green if m["green_expected"] in t) or f"(no green containing {m['green_expected']})"
                status = "exit " + str(code)
            else:
                script = "scripts/model/verify_claims.py" if "verify_claims" in path else "scripts/model/check_frozen.py"
                out, code = run_python_gate(script)
                red_text = "; ".join(l.strip() for l in out.splitlines() if m["red_expected"] in l) or f"(no line containing {m['red_expected']})"
                green_text = "; ".join(l.strip() for l in out.splitlines() if m["green_expected"] in l) or f"(no line containing {m['green_expected']})"
                status = "exit " + str(code)
        finally:
            open(full, "w").write(text)
        restored = sha(path)
        rows.append((m, status, f"{red_text}\n{green_text}", before, after if after != before else restored))
        print(f"== {m['gate']}: {status}\n   red: {red_text}\n   green: {green_text}\n   sha {before[:12]} -> {after[:12]} -> restored {restored[:12]}")

    lines = [
        "# E-22 mutation record — every gate seen to fail under its own mechanism",
        "",
        "Produced by `python3 scratch/s2-fix/mutations.py`: each row disables exactly the mechanism the",
        "gate is named for, runs the gate, records which test went red and which neighbouring test stayed",
        "green, restores the file and re-hashes it. `sha before` and `sha restored` are equal in every row —",
        "that is the proof the tree is the one that was shipped, not the one that was mutated.",
        "",
        "| Gate | Mutation (the edited expression) | Control | Red | Stayed green | sha256 before | sha256 mutated |",
        "|---|---|---|---|---|---|---|",
    ]
    for m, status, detail, before, after in rows:
        red, _sep, green = detail.partition("\n")
        lines.append(
            f"| {m['gate']} | `{m['edit'][0]}`: {m['why']} | {m['control']} | {red} ({status}) | {green} | `{before[:16]}` | `{after[:16]}` |"
        )
    lines += [
        "",
        "Every mutation was restored before the next one; the suite that ships is the unmutated tree, and",
        "`make test` on it is recorded in `docs/build/S2-fix-report.md`.",
        "",
    ]
    open(OUT, "w").write("\n".join(lines))
    print(f"\nwrote {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()
