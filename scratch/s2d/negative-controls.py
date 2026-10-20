#!/usr/bin/env python3
"""Negative controls for S2d: each gate is broken on purpose, and must go red.

A test that has never failed is not evidence. Every mutation here is applied to the
working tree, the one affected gate is run, and the tree is restored and verified by
sha256 — the script exits non-zero if any mutation is not caught, or if the tree does not
come back byte-identical.

    python3 scratch/s2d/negative-controls.py

Mutations, and the gate each one must trip:

  M1  auth.ts: one extra durable write on the unknown-email failure path
      -> admin-auth.test.ts case 4 (E-16 timing), the flake this slice was asked to fix
  M2  run.ts: the registry row is no longer written
      -> ddl-runner.test.ts O1 / C2 (the postcondition sees an unregistered table)
  M3  run.ts: COMMIT before the postcondition
      -> ddl-runner.test.ts R2 (a table outside the four prefixes would commit)
  M4  run.ts: no ROLLBACK on failure
      -> ddl-runner.test.ts C2 (the third statement's failure leaves the first behind)
  M5  ops.ts: the `default_required` refusal is deleted
      -> ddl-runner.test.ts O2 (SQLite's own refusal, which C-13 forbids reaching a user)
  M6  ops.ts: the `rebuild_required` refusal is deleted
      -> ddl-runner.test.ts O3
  M7  audit/chain.ts: the verifier stops comparing against the seal
      -> audit-seal.test.ts A4 / ddl-runner.test.ts C6 (the round-2 finding, exactly)
  M8  emit.ts: the `id` column is dropped from CREATE TABLE (the S2c defect)
      -> ddl-runner.test.ts C5 / admin-builder.test.ts DDL-1
"""
import hashlib
import os
import re
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def sha(path: str) -> str:
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


MUTATIONS = [
    {
        "name": "M1 auth: a real delay on one failure path (E-16)",
        "file": "app/admin/auth.ts",
        "old": """    if (row === undefined || !passwordOk || (this.#totpRequired && !totpOk)) {
      if (row !== undefined) this.#recordFailure(row.id, row.failed_logins, input.atMs);""",
        "new": """    if (row === undefined || !passwordOk || (this.#totpRequired && !totpOk)) {
      if (row === undefined) await new Promise((resolve) => setTimeout(resolve, 12));
      if (row !== undefined) this.#recordFailure(row.id, row.failed_logins, input.atMs);""",
        "tests": ["test/admin-auth.test.ts"],
        "pattern": "^4\\. three login",
        "expect": "4. three login failure causes",
    },
    {
        "name": "M2 runner: the registry row is not written",
        "file": "app/ddl/run.ts",
        "old": "        applyRegistry(db, plan);",
        "new": "        if (plan.registry.kind === 'insert') { /* mutated: no registry row */ } else applyRegistry(db, plan);",
        "tests": ["test/ddl-runner.test.ts"],
        "pattern": "^O1\\.",
        "expect": "O1.",
    },
    {
        "name": "M3 runner: COMMIT before the postcondition",
        "file": "app/ddl/run.ts",
        "old": """      postcondition(db);
      options.hooks?.beforeCommit?.({ db, plan: plans[plans.length - 1] as DdlPlan });
      db.exec('COMMIT');""",
        "new": """      options.hooks?.beforeCommit?.({ db, plan: plans[plans.length - 1] as DdlPlan });
      db.exec('COMMIT');
      postcondition(db);""",
        "tests": ["test/ddl-runner.test.ts"],
        "pattern": "^R2\\.",
        "expect": "R2.",
    },
    {
        "name": "M4 runner: the failure path commits the partial batch",
        "file": "app/ddl/run.ts",
        "old": """      if (db.inTransaction) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* a rollback that fails is still a discarded connection */
        }
      }
      throw err instanceof AppError ? err : taxonomy(err);""",
        # Skipping the rollback entirely is NOT a mutation here: the `finally` rolls the
        # transaction back and `close()` discards it, which is the belt-and-braces this
        # runner already has. What must be caught is committing the partial batch.
        "new": """      if (db.inTransaction) db.exec('COMMIT');
      throw err instanceof AppError ? err : taxonomy(err);""",
        "tests": ["test/ddl-runner.test.ts"],
        "pattern": "^C2\\.",
        "expect": "C2.",
    },
    {
        "name": "M5 AST: no default_required refusal",
        "file": "app/ddl/ops.ts",
        "old": """      if (op.column.notNull === true && op.column.default === undefined) {
        throw refuse(
          'default_required',
          `${op.column.name} is NOT NULL with no default: SQLite refuses "Cannot add a NOT NULL column with default value NULL"`,
        );
      }""",
        "new": """      // mutated: the default_required refusal is gone""",
        "tests": ["test/ddl-runner.test.ts"],
        "pattern": "^O2\\.",
        "expect": "O2.",
    },
    {
        "name": "M6 AST: no rebuild_required refusal",
        "file": "app/ddl/ops.ts",
        "old": """      if (op.rebuild !== true && (indexed !== undefined || referenced)) {
        const why = indexed !== undefined ? `indexed by ${indexed.name}` : 'referenced by a foreign key';
        throw refuse('rebuild_required', `${op.table}.${op.column} is ${why}; pass rebuild: true`);
      }""",
        "new": """      // mutated: the rebuild_required refusal is gone
      void indexed;
      void referenced;""",
        "tests": ["test/ddl-runner.test.ts"],
        "pattern": "^O3\\.",
        "expect": "O3.",
    },
    {
        "name": "M7 verifier: compares the chain but not the seal",
        "file": "app/audit/chain.ts",
        "old": """  if (seal.rows !== report.rows || seal.head !== report.head) {""",
        "new": """  if (false) {""",
        "tests": ["test/audit-seal.test.ts"],
        "pattern": "^A4\\.",
        "expect": "A4.",
    },
    {
        "name": "M8 emitter: CREATE TABLE loses its id column (the S2c defect)",
        "file": "app/ddl/emit.ts",
        "old": """  const parts: string[] = ['"id" INTEGER'];""",
        "new": """  const parts: string[] = [];""",
        "tests": ["test/ddl-runner.test.ts", "test/admin-builder.test.ts"],
        "pattern": "^(C5|DDL-1)\\.",
        "expect": "C5.",
    },
]


def run_tests(files, pattern):
    cmd = [sys.executable.replace("python3", "node") if False else "node",
           "--test", "--test-reporter=tap", "--test-concurrency=1",
           f"--test-name-pattern={pattern}", *files]
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    failures = []
    print(f"root: {ROOT}")
    for m in MUTATIONS:
        path = os.path.join(ROOT, m["file"])
        original = open(path, "r", encoding="utf-8").read()
        before = sha(path)
        if m["old"] not in original:
            print(f"SKIP {m['name']}: the target text is not in {m['file']} (the gate would be vacuous)")
            failures.append(f"{m['name']}: target text missing")
            continue
        if original.count(m["old"]) != 1:
            print(f"SKIP {m['name']}: the target text appears {original.count(m['old'])} times")
            failures.append(f"{m['name']}: ambiguous target")
            continue
        mutated = original.replace(m["old"], m["new"])
        try:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(mutated)
            code, out = run_tests(m["tests"], m["pattern"])
            reds = [line for line in out.splitlines() if line.startswith("not ok")]
            # The named gate must be the one that failed: a mutation that made some other
            # test red would be evidence about that test, not about this one.
            caught = code != 0 and any(m["expect"] in line for line in reds)
            first = reds[0] if reds else ""
            print(f"{'RED ' if caught else 'MISS'} {m['name']}")
            print(f"       {m['file']}: {len(original)} -> {len(mutated)} bytes; exit {code}; {first.strip()[:110]}")
            if not caught:
                failures.append(f"{m['name']}: gate did not go red ({m['expect']!r} absent, exit {code})")
        finally:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(original)
            after = sha(path)
            if after != before:
                failures.append(f"{m['name']}: restore failed ({before} -> {after})")
            print(f"       restored: sha256 {'ok' if after == before else 'MISMATCH'}")
    print()
    if failures:
        for f in failures:
            print(f"FAIL {f}")
        return 1
    print(f"proof: PASS — all {len(MUTATIONS)} mutations tripped their gate, and every file came back byte-identical")
    return 0


if __name__ == "__main__":
    sys.exit(main())
