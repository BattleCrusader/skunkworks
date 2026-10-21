#!/usr/bin/env python3
"""One mutation at a time: edit -> run the gate file -> restore -> prove sha256 before == after.

This is the record behind docs/build/S5-inprocess-report.md's D1/D3/N5 sections. Nothing here is
a gate: the gate is the test file, and this script's only job is to show the gate can go red for
the reason the fix names.
"""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

REPO = Path("/Volumes/Backup/Development/skunkworks")

MUTATIONS = [
    {
        "id": "MD1a",
        "why": "D1 — the E-33 sentence deleted from the install screen",
        "file": "app/cli/skwctl.ts",
        "old": "  lines.push(`${pad('what this means')}${CAPABILITIES_ARE_DISCLOSURE}`);",
        "new": "  // MUTATION MD1a: the E-33 item 6 sentence is not printed",
        "test": "test/plugin-install.test.ts",
        "expect_red": ["P1"],
    },
    {
        "id": "MD1b",
        "why": "D1 — the false containment claim put back on the zero-capability line",
        "file": "app/cli/skwctl.ts",
        "old": "    lines.push(`${pad('capabilities')}none declared — the package asks this CMS for no operations`);",
        "new": "    lines.push(`${pad('capabilities')}none — it can reach neither this site's data nor its mailer`);",
        "test": "test/plugin-install.test.ts",
        "expect_red": ["P2"],
    },
    {
        "id": "MD3a",
        "why": "D3 — uninstall() skips the drain (the pre-fix behaviour: no caller of uninstallBegin)",
        "file": "app/plugins/runtime.ts",
        "old": "    await this.uninstallBegin(tenant, pluginId, opts.timeoutMs ?? DRAIN_TIMEOUT_MS);",
        "new": "    // MUTATION MD3a: the drain is skipped\n    void opts;",
        "test": "test/plugin-lifecycle.test.ts",
        "expect_red": ["U1"],
    },
    {
        "id": "MD3b",
        "why": "D3 — the busy refusal rethrown as drain() writes it, naming the tenant and not the plugin",
        "file": "app/plugins/runtime.ts",
        "old": """      if (err instanceof AppError && err.code === 'SKW_E_PL_BUSY') {
        const inFlight = this.inFlightCount(tenant);
        throw new AppError(
          'SKW_E_PL_BUSY',
          `${pluginId} was not uninstalled: tenant ${tenant} still has ${inFlight} request(s) in flight after ${timeoutMs} ms, and nothing was removed`,
          { tenant, plugin: pluginId, in_flight: inFlight, waited_ms: timeoutMs },
        );
      }
      throw err;""",
        "new": "      // MUTATION MD3b: the tenant-shaped refusal is passed through unchanged\n      void pluginId;\n      void timeoutMs;\n      throw err;",
        "test": "test/plugin-lifecycle.test.ts",
        "expect_red": ["U1"],
    },
    {
        "id": "MN5a",
        "why": "notices — the durable write removed: the pre-fix state (an in-memory array only)",
        "file": "app/plugins/runtime.ts",
        "old": "    this.persistNotice(db, tenant ?? '', notice);",
        "new": "    // MUTATION MN5a: the notice is not persisted",
        "test": "test/admin-plugin-notices.test.ts",
        "expect_red": ["N5"],
    },
]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(test_file: str) -> tuple[int, str]:
    proc = subprocess.run(
        ["node", "scripts/run-node-tests.mjs", "--timeout=126000", test_file],
        cwd=REPO,
        capture_output=True,
        text=True,
    )
    return proc.returncode, proc.stdout + proc.stderr


def summary(out: str) -> tuple[list[str], list[str], str]:
    red = [line.split(" - ")[0].replace("not ok ", "").strip() for line in out.splitlines() if line.startswith("not ok ")]
    names = [line.strip() for line in out.splitlines() if line.startswith("not ok ")]
    first_error = ""
    for line in out.splitlines():
        if line.strip().startswith("error:"):
            first_error = line.strip()
            break
    return red, names, first_error


records = []
for mut in MUTATIONS:
    path = REPO / mut["file"]
    before = sha(path)
    original = path.read_text()
    if mut["old"] not in original:
        records.append({**mut, "applied": False, "note": "old_string not found"})
        print(f"!! {mut['id']}: old_string not found in {mut['file']}", file=sys.stderr)
        continue
    path.write_text(original.replace(mut["old"], mut["new"], 1))
    try:
        code, out = run(mut["test"])
    finally:
        path.write_text(original)
    after = sha(path)
    red, names, first_error = summary(out)
    record = {
        "id": mut["id"],
        "why": mut["why"],
        "file": mut["file"],
        "test": mut["test"],
        "sha256_before": before,
        "sha256_after": after,
        "restored_identical": before == after,
        "exit": code,
        "red": names,
        "expect_red": mut["expect_red"],
        "first_error": first_error,
    }
    records.append(record)
    print(json.dumps(record, ensure_ascii=False))

(REPO / "scratch/fix/mutations.json").write_text(json.dumps(records, indent=2, ensure_ascii=False) + "\n")
bad = [r for r in records if not r.get("restored_identical", False)]
print(f"\n{len(records)} mutations, {len(bad)} not restored identically")
