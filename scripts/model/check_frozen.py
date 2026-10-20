#!/usr/bin/env python3
"""Assert that docs/sds/SDS.md quotes the register verbatim.

The SDS is allowed to add diagrams, tables and derived contracts; it is not allowed to paraphrase a
frozen sentence, an environment name, an error-code pattern or the consume statement. This check
parses docs/sds/00-adjudication.md for (a) the blockquote under every "The sentence the SDS adopts."
marker and (b) the frozen blocks of register §4, normalises whitespace and markdown emphasis, and
requires each string in SDS.md.

    python3 scripts/model/check_frozen.py      exit 0 = the SDS is a faithful implementation
"""
import re, sys, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
REG = open(os.path.join(ROOT, "docs/sds/00-adjudication.md")).read()
SDS = open(os.path.join(ROOT, "docs/sds/SDS.md")).read()


def norm(t):
    t = "\n".join(re.sub(r"^>\s?", "", l) for l in t.splitlines())
    t = re.sub(r"[`*]", "", t)
    t = re.sub(r"\s+", " ", t)
    return t.strip()


NSDS = norm(SDS)

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

missing = [cid for cid, s in found.items() if norm(s) not in NSDS]
print(f"adopted sentences: {len(found) - len(missing)}/{len(found)} verbatim in SDS.md")
for cid in sorted(missing, key=lambda c: int(c.split("-")[1])):
    print(f"  MISSING {cid}: {found[cid][:160]}…")

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
bad = [name for name, text in BLOCKS.items() if norm(text) not in NSDS]
print(f"frozen §4 blocks: {len(BLOCKS) - len(bad)}/{len(BLOCKS)} verbatim")
for name in bad:
    print(f"  MISSING block: {name}")

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

ok = not (missing or bad or step_missing or env_missing)
print("\n" + ("PASS the SDS quotes the register" if ok else "FAIL the SDS paraphrases the register"))
sys.exit(0 if ok else 1)
