#!/usr/bin/env python3
"""Independent tree hash: relpath\\0kind\\0sha256-or-link-target\\n, sorted. Not the product's."""
import hashlib, os, sys, json

def tree(root):
    rows = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort(); filenames.sort()
        for d in dirnames:
            p = os.path.join(dirpath, d)
            rows.append(("d", os.path.relpath(p, root), ""))
        for f in filenames:
            p = os.path.join(dirpath, f)
            rel = os.path.relpath(p, root)
            if os.path.islink(p):
                rows.append(("l", rel, os.readlink(p)))
            else:
                h = hashlib.sha256(open(p, "rb").read()).hexdigest()
                rows.append(("f", rel, h))
    rows.sort()
    blob = "".join(f"{k}\0{r}\0{v}\n" for k, r, v in rows).encode()
    return hashlib.sha256(blob).hexdigest(), len(rows)

if __name__ == "__main__":
    out = {}
    for root in sys.argv[1:]:
        h, n = tree(root)
        out[root] = {"sha256": h, "entries": n}
    print(json.dumps(out, indent=2))
