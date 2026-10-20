import pathlib
import sys

target = pathlib.Path(sys.argv[1])
s = target.read_text()
old = "  const suffix = metaUrl.endsWith('.ts') ? '.ts' : '.js';"
new = "  const suffix = '.ts';"
if old not in s:
    raise SystemExit(f"MUTATION DID NOT MATCH in {target}")
target.write_text(s.replace(old, new, 1))
print("mutated stampWorkerUrl: it now always names the .ts sibling (the pre-fix defect)")
