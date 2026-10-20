import pathlib
import sys

target = pathlib.Path(sys.argv[1])
mode = sys.argv[2]
s = target.read_text()

if mode == "c4a":
    old = '        add_header Cache-Control "public, max-age=31536000, immutable";'
    new = '        add_header Cache-Control "no-store";'
elif mode == "c4b":
    old = "        alias /srv/content/public/;\n        try_files $uri =404;"
    new = "        proxy_pass http://app:3000;"
else:
    raise SystemExit(f"unknown mode {mode}")

if old not in s:
    raise SystemExit(f"MUTATION DID NOT MATCH in {target}")
target.write_text(s.replace(old, new, 1))
print(f"mutated {target} ({mode})")
