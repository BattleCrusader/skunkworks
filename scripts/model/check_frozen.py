#!/usr/bin/env python3
"""Assert that docs/sds/SDS.md quotes the register verbatim.

The SDS is allowed to add diagrams, tables and derived contracts; it is not allowed to paraphrase a
frozen sentence, an environment name, an error-code pattern or the consume statement. This check
parses docs/sds/00-adjudication.md for (a) the blockquote under every "The sentence the SDS adopts."
marker and (b) the frozen blocks of register §4, normalises whitespace and markdown emphasis, and
requires each string in SDS.md.

SUPERSESSIONS (02-errata). An errata item may replace a frozen artefact outright. That is not a
licence to relax this check: every replacement is listed by name in SUPERSEDED below, with the errata
item that carries the `SUPERSEDES` marker, the exact text it retired and the exact text that must now
appear instead. The assertion for a superseded artefact is the *strongest* form of the same
assertion — the old text must be ABSENT, the replacement must be PRESENT verbatim, and the errata item
must be present in 02-errata.md and must carry the marker. An artefact that is not listed here is
still checked exactly as before, and there is no pattern, wildcard or "skip if missing" anywhere in
this file.

    python3 scripts/model/check_frozen.py      exit 0 = the SDS is a faithful implementation
"""
import re, sys, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
REG = open(os.path.join(ROOT, "docs/sds/00-adjudication.md")).read()
SDS = open(os.path.join(ROOT, "docs/sds/SDS.md")).read()
ERRATA = open(os.path.join(ROOT, "docs/sds/02-errata.md")).read()

# ---- the five SUPERSEDES markers of 02-errata §1, and which of them this check can see
# E-1 (the §4.1 step table) changes ordering and numbering only; the row numbers 1-10 are
# unchanged and the `| N |` assertion below still holds, so no entry is needed.
# E-4 (§4.2 code lists) and E-13 (§4.2 body shape, scope only) touch text this check does not
# quote: the pattern is still asserted, and the code lists were never a frozen block here.
SUPERSEDED = {
    "C-25": dict(
        item="E-2",
        marker="SUPERSEDES 00-adjudication.md §2 C-25",
        old="""A host that serves tenant-authored HTML never serves the admin listener: demos live at
`demos.<our-domain>/demo/<key>/`, admin at `admin.<our-domain>`, and the admin listener returns
`421 SKW_E_PLT_EDGE_PROOF` for any request whose `Host` maps to a tenant with `mode='demo'`.""",
        new="""A host that serves tenant-authored HTML never serves the admin listener: demos live at
`demos.<our-domain>/demo/<key>/`, admin at `admin.<our-domain>`, and the admin surface is mounted on
no other Host — so a demo page cannot reach it at all, and neither can a production tenant's page.
`mode='demo'` no longer participates in that decision (§9.1 rule 4).""",
    ),
    "proxy snippet": dict(
        item="E-11",
        marker="SUPERSEDES 00-adjudication.md §4.1",
        old="""proxy_set_header X-Skunkworks-Edge  "<SKW_EDGE_TOKEN rendered at install>";
proxy_set_header X-Skunkworks-Tenant "";          # fail closed: a client claim never survives
proxy_ignore_headers X-Accel-Redirect;            # on any location proxying to a non-app upstream""",
        new="""proxy_set_header X-Skunkworks-Edge  "<SKW_EDGE_TOKEN rendered at install>";
proxy_set_header X-Skunkworks-Tenant "";          # fail closed: a client claim never survives
proxy_set_header X-Forwarded-Prefix  "";          # fail closed: a client prefix never survives
proxy_ignore_headers X-Accel-Redirect;            # on any location proxying to a non-app upstream""",
    ),
}


def norm(t):
    t = "\n".join(re.sub(r"^>\s?", "", l) for l in t.splitlines())
    t = re.sub(r"[`*]", "", t)
    t = re.sub(r"\s+", " ", t)
    return t.strip()


NSDS = norm(SDS)
NERRATA = norm(ERRATA)


def errata_section(item):
    """The text of `### E-<n> — …` up to the next `### E-` heading."""
    m = re.search(rf"^### {item} —.*?(?=^### E-|\Z)", ERRATA, re.S | re.M)
    return m.group(0) if m else ""


def superseded(name):
    """Assert a supersession properly: marker, retired text absent, replacement present."""
    spec = SUPERSEDED[name]
    section = errata_section(spec["item"])
    if section == "":
        return f"{name}: errata item {spec['item']} is missing from 02-errata.md"
    if norm(spec["marker"]) not in norm(section):
        return f"{name}: {spec['item']} does not carry the marker '{spec['marker']}'"
    if norm(spec["old"]) in NSDS:
        return f"{name}: the retired text is STILL in SDS.md — the supersession was not applied"
    if norm(spec["new"]) not in NSDS:
        return f"{name}: the {spec['item']} replacement is not verbatim in SDS.md"
    return None


superseded_bad = {n: e for n, e in ((n, superseded(n)) for n in SUPERSEDED) if e is not None}

# ---- the 25 adopted sentences
lines = REG.splitlines()
found = {}
i = 0
while i < len(lines):
    if lines[i].startswith("### C-") and "—" in lines[i]:
        cid = lines[i].split()[1]
        j = i + 1
        while j < len(lines) and not (lines[j].startswith("### C-") or lines[j].startswith("## 3.")):
            if lines[j].strip() == "**The sentence the SDS adopts.**":
                k, buf = j + 1, []
                while k < len(lines) and lines[k].startswith(">"):
                    buf.append(lines[k].lstrip("> ").strip())
                    k += 1
                if buf:
                    found[cid] = " ".join(buf)
                break
            j += 1
    i += 1

missing = [cid for cid, s in found.items() if norm(s) not in NSDS and cid not in SUPERSEDED]
print(f"adopted sentences: {len(found) - len(missing) - len([c for c in found if c in SUPERSEDED])}/{len(found)} verbatim in SDS.md; "
      f"{len([c for c in found if c in SUPERSEDED])} superseded by 02-errata")
for cid in sorted(missing, key=lambda c: int(c.split("-")[1])):
    print(f"  MISSING {cid}: {found[cid][:160]}…")
for cid in sorted(c for c in found if c in SUPERSEDED):
    msg = superseded_bad.get(cid)
    print(f"  {'SUPERSEDED by ' + SUPERSEDED[cid]['item'] + ' (asserted)' if msg is None else 'BAD SUPERSESSION: ' + msg}")

# ---- the frozen blocks of register §4
BLOCKS = {
    "tenancy headers": """X-Skunkworks-Tenant: <key>        # "" on every host-routed location; <key> on every path-prefix location
X-Skunkworks-Edge:   <token>      # SKW_EDGE_TOKEN, rendered into the snippet by install.sh
X-Forwarded-Prefix:  /demo/<key>  # path-prefix locations only; the only source of tenant.prefix""",
    "proxy snippet": """proxy_set_header X-Skunkworks-Edge  "<SKW_EDGE_TOKEN rendered at install>";
proxy_set_header X-Skunkworks-Tenant "";          # fail closed: a client claim never survives
proxy_ignore_headers X-Accel-Redirect;            # on any location proxying to a non-app upstream""",
    "consume insert": """INSERT INTO cms_download_event(jti, kind, code_id, asset_id, bytes_declared, ip_hash, ua_hash, outcome)
     VALUES(?, 'first', ?, ?, ?, ?, ?, 'ok') ON CONFLICT DO NOTHING;""",
    "consume update": """UPDATE cms_download_code SET uses = uses + 1 WHERE id = ? AND revoked_at IS NULL AND (max_uses IS NULL OR uses < max_uses)""",
    "token wire format": """v1.<base64url(payload)>.<base64url(HMAC-SHA256(SKW_DOWNLOAD_TOKEN_KEY, "v1." + payload))>""",
    "download cookie": """__Host-sk-dl-<tenantKey>=<token>; Path=/; Secure; HttpOnly; SameSite=Lax""",
    "bundle schema": '"schema": "skunkworks/site-bundle/v3"',
    "bundle projection version": '"projection_version": 2',
    "error-code pattern": "^SKW_E_(RT|DM|SEC|PLT|EXP|PL)_[A-Z0-9_]+$",
    "class postcondition": """SELECT count(*) FROM sqlite_master WHERE type='table'""",
    "plugin prefix glob": """GLOB 'p_?*'""",
    "CSP": """default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: https:; frame-src <declared per tenant>; frame-ancestors 'none'; base-uri 'none'; object-src 'none'""",
}
bad = [name for name, text in BLOCKS.items() if norm(text) not in NSDS and name not in SUPERSEDED]
print(f"frozen §4 blocks: {len(BLOCKS) - len(bad) - len([n for n in BLOCKS if n in SUPERSEDED])}/{len(BLOCKS)} verbatim"
      f"{'; ' + str(len([n for n in BLOCKS if n in SUPERSEDED])) + ' superseded by 02-errata' if any(n in SUPERSEDED for n in BLOCKS) else ''}")
for name in bad:
    print(f"  MISSING block: {name}")
for name in BLOCKS:
    if name in SUPERSEDED:
        msg = superseded_bad.get(name)
        print(f"  {'SUPERSEDED by ' + SUPERSEDED[name]['item'] + ' (asserted)' if msg is None else 'BAD SUPERSESSION: ' + msg}")

# ---- the resolution table's step numberings, and every SKW_ name from §4.2
steps = re.findall(r"\| (\d{1,2}) \| `[^|]+\| `[^`]+`", REG)
nums = sorted({n for n in steps}, key=int)
step_missing = [n for n in nums if not re.search(rf"\| {n} \| ", SDS)]
env = sorted(set(re.findall(r"\| `(SKW_[A-Z0-9_]+)` \|", REG)))
env_missing = [e for e in env if e not in SDS]
print(f"resolution steps: {len(nums) - len(step_missing)}/{len(nums)} present; "
      f"env names: {len(env) - len(env_missing)}/{len(env)} present")
if step_missing:
    print("  MISSING steps:", step_missing)
if env_missing:
    print("  MISSING env:", env_missing)

bad_supersessions = [e for e in superseded_bad.values()]
if bad_supersessions:
    for msg in bad_supersessions:
        print(f"  BAD SUPERSESSION: {msg}")

ok = not (missing or bad or step_missing or env_missing or bad_supersessions)
print("\n" + ("PASS the SDS quotes the register" if ok else "FAIL the SDS paraphrases the register"))
sys.exit(0 if ok else 1)
