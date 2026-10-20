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
    # E-31 (02-errata §14) retires C-8's "sentence the SDS adopts". D36 deleted the fourth service, the
    # socket and the RPC enum, so the sentence now describes a container that does not exist. Asserted the
    # strongest way available: the retired text must be ABSENT from SDS.md, E-31's replacement must be
    # PRESENT verbatim, and E-31 must carry the marker. C-8's *verdict* is withdrawn rather than rewritten
    # (§17.1), and its arithmetic — 49.8 MB and 34 ms per tenant, 47.4–48.0 MB for the runner — is kept in
    # §8.4 as the price the model declined to pay. Nothing here relaxes the check for any other artefact.
    "C-8": dict(
        item="E-31",
        marker="SUPERSEDES 00-adjudication.md §2 C-8",
        old="""`docker-compose.yml` has four services — `nginx`, `app`, `plugin-runner`, `acme` — and `plugin-runner` runs with `network_mode: none`, `read_only: true`, `cap_drop: [ALL]`, `pids_limit: 64` and one `node --permission` child per installed package with `--allow-fs-read` limited to that package and its scratch directory and with no `--allow-addons`, `--allow-child-process` or `--allow-worker`; the app reaches it only over the unix socket `run/plugin.sock`, and the protocol is the operation enum in §4.3.""",
        new="""`docker-compose.yml` has three services — `nginx`, `app`, `acme` — and no `plugin-runner`: there is no `network_mode: none`, no `node --permission` child, no per-package cgroup, no `run/plugin.sock` and no operation enum, because a plugin is a module imported into the `app` process and shares that process's network namespace, filesystem, memory and database handles.""",
    ),
    # E-20 (02-errata §8) retires C-21's "sentence the SDS adopts" and nothing else. C-21's verdict
    # — a per-day digest in the second file is what makes a chain tamper-evident — is untouched; what
    # changes is what a digest COVERS, because a whole-file digest cannot distinguish tamper from the
    # next day's traffic, which is the one property the verdict was bought for. As with the two entries
    # below this is asserted the strongest way available: the retired text must be ABSENT, the
    # replacement must be PRESENT verbatim, and E-20 must carry the marker.
    "C-21": dict(
        item="E-20",
        marker="SUPERSEDES 00-adjudication.md §2 C-21",
        old="""`cms_audit` rows are hash-chained (`prev_hash`, `hash` over the canonical row) inside `site.db` and written in the same transaction as the change they record; one `audit_seal(tenant_key, day, rows, head)` row per tenant per UTC day is written to `control.db`; the verifier compares `count(cms_audit)` and the recomputed head to the seal and raises `SKW_E_SEC_AUDIT_SEAL` when either disagrees.""",
        new="""`cms_audit` rows are hash-chained (`prev_hash`, `hash` over the canonical row) inside `site.db` and written in the same transaction as the change they record; one `audit_seal` row per tenant per UTC **day segment** is written to `control.db` — `(tenant_key, day, first_id, last_id, rows_in_day, head, anchor, sealed_at, late)` — where `[first_id, last_id]` is that day's own id range, `rows_in_day` is how many rows are in it, `head` is the last hash **inside that range**, and `anchor` is the hash of the row immediately **before** it (`''` when the segment begins at the chain's first row); the verifier walks that range only, starting from `anchor`, and raises `SKW_E_SEC_AUDIT_SEAL` when the anchor, a link, `rows_in_day` or `head` disagrees. A day that was never sealed stays **visibly unsealed**, and a day sealed after the fact carries `late = 1`.""",
    ),
    # E-19 replaces §11.6's block quote with the unclaimed-seed text plus §11.6a. That item carries no
    # `SUPERSEDES` line — it names the block quote as the drop-in target instead — so the marker asserted
    # here is that phrase, verbatim from E-19. Everything else is the strongest form: C-24's sentence must
    # be ABSENT from the SDS and E-19's replacement PRESENT verbatim.
    "C-24": dict(
        item="E-19",
        marker="drop-in for `SDS.md` §11.6's block quote",
        old="""A bundle carries `data/control.seed.json` — one tenant with `mode='production'`, its hosts, one `owner` user with an argon2id hash and `must_change=1`, `db_version` and settings — and `install.sh` applies `schema/control.sql` and seeds exactly those rows in one transaction before `compose up`; no bundle contains `data/control.db`, `data/site.db-wal`, `data/site.db-shm`, `content/protected/wm/`, `content/sources/` or a populated `.env`.""",
        new="""A bundle carries `data/control.seed.json` — one tenant with `mode='production'`, its hosts, one `owner` user marked **unclaimed**: `must_change=1`, `totp_secret` NULL, and a `password_hash` that is a real argon2id hash of 32 random bytes discarded at export, so a verification costs exactly what a real one costs and can never succeed — `db_version` and settings — and `install.sh` applies `schema/control.sql` and seeds exactly those rows in one transaction before `compose up`; no bundle contains `data/control.db`, `data/site.db-wal`, `data/site.db-shm`, `content/protected/wm/`, `content/sources/`, a populated `.env`, or a non-NULL `totp_secret` (a §11.3 preflight refusal, so a bundle can never ship a working second factor). The seeded row is a **claim marker, not a credential**: `install.sh` runs `skwctl admin bootstrap` (§11.6a) between `bundle_verify` and `compose up`, so the box has exactly one operator who can log in, and has one before the admin surface is reachable.""",
    ),
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

# ---- second phase (02-errata E-23): completeness, which a quote check cannot see ----------------
#
# `make test` was green with E-16..E-19 absent from the SDS: the quote phase above compares quotes,
# and a missing row, a missing table row and a missing pointer are not quotes. This phase counts them
# and fails naming the missing row, the missing string or the missing pointer.
S2_ROWS = 13
S2_REQUIRED = (
    "a fresh seeded `control.db` and nothing else yields exactly one operator",
    "a second bootstrap writes nothing",
    "no TOTP secret or password reaches stdout",
    "a day sealed on the 20th still verifies after the chain grows on the 21st",
    "a `view` source is anchored to its definition",
)
# Every item that must have landed a pointer line in SDS.md — the whole list, not this section's four.
#
# E-29's item 5 asked for `range(1, 31)` and E-31's item 7 for `range(1, 34)`. The range is raised
# **with** the pointer lines in the same pass (S5 item 3): E-24 → §6.2, E-25/E-28 → §16, E-26 → §7.4,
# E-27 → §7.5, E-29 → §12.5, E-30 → §8.4, E-31 → §3 and §13.3, E-32 → §8.6, §13.3 and §15.2,
# E-33 → §13.1a. A range raised without the lines is a gate made worse to look more complete.
POINTERS = tuple(f"E-{n}" for n in range(1, 34))


def s2_section_text():
    m = re.search(r"^### S2 — .*?(?=^### S3 —)", SDS, re.S | re.M)
    return m.group(0) if m is not None else None


def s2_table_rows():
    """The §16 S2 acceptance table's data rows, counted rather than eyeballed."""
    section = s2_section_text()
    if section is None:
        return None
    rows = []
    for line in section.splitlines():
        text = line.strip()
        if not text.startswith("|"):
            continue
        if text.startswith("| Acceptance criterion"):
            continue
        if set(text) <= set("|-: "):          # the |---|---| separator
            continue
        rows.append(text)
    return rows


s2_rows = s2_table_rows()
row_problems = []
if s2_rows is None:
    row_problems.append("§16 has no S2 section")
else:
    if len(s2_rows) != S2_ROWS:
        row_problems.append(f"§16 S2 has {len(s2_rows)} rows, expected {S2_ROWS}")
    s2_norm = norm(s2_section_text())
    for required in S2_REQUIRED:
        if norm(required) not in s2_norm:
            row_problems.append(f"§16 S2 is missing the row beginning {required!r}")

pointer_lines = re.findall(r"^> Amended by 02-errata\.md ([^.\n]*)\.", SDS, re.M)
pointer_have = set()
for group in pointer_lines:
    pointer_have.update(re.findall(r"E-\d+", group))
pointer_missing = [p for p in POINTERS if p not in pointer_have]

present_required = len(S2_REQUIRED) - len([p for p in row_problems if "missing the row" in p])
print(f"§16 S2 rows: {len(s2_rows) if s2_rows is not None else '?'}/{S2_ROWS}; "
      f"required strings: {present_required}/{len(S2_REQUIRED)}; "
      f"pointers: {len(POINTERS) - len(pointer_missing)}/{len(POINTERS)}")
for problem in row_problems:
    print(f"  {problem}")
if pointer_missing:
    print(f"  MISSING pointers: {', '.join(pointer_missing)}")

ok = not (missing or bad or step_missing or env_missing or bad_supersessions or row_problems or pointer_missing)
print("\n" + ("PASS the SDS quotes the register" if ok else "FAIL the SDS paraphrases the register"))
sys.exit(0 if ok else 1)
