import pathlib
import sys

target = pathlib.Path(sys.argv[1])
s = target.read_text()
old = "      if (stampable(asset) !== null) {"
new = "      if (false) {"
if old not in s:
    raise SystemExit(f"MUTATION DID NOT MATCH in {target}")
target.write_text(s.replace(old, new, 1))
print(f"mutated {target}: the stamp branch is now dead, so a stampable asset falls back to content/media/")
