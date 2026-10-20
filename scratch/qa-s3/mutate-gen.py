import pathlib
import sys

target = pathlib.Path(sys.argv[1])
mode = sys.argv[2]
s = target.read_text()

if mode == "c4a":
    # The immutability header moves to no-store: the location still serves the bytes, but
    # N1's third reading (the header a proxy would have passed through) must catch it.
    old = """    out.push('        add_header Cache-Control "public, max-age=31536000, immutable";');"""
    new = """    out.push('        add_header Cache-Control "no-store";');"""
elif mode == "c4b":
    # The farm is moved behind Node: /media/ proxies to the app instead of an alias.
    old = """    out.push('        alias /srv/content/public/;');
    out.push('        try_files $uri =404;');"""
    new = """    out.push('        proxy_pass http://app:3000;');"""
else:
    raise SystemExit(f"unknown mode {mode}")

if old not in s:
    raise SystemExit(f"MUTATION DID NOT MATCH in {target}")
target.write_text(s.replace(old, new, 1))
print(f"mutated {target} ({mode})")
