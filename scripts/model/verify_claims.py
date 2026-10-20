#!/usr/bin/env python3
"""Ad-hoc verification of the claims in docs/debate/r1-data-model.md. NOT a test suite.

Re-derives, from scratch, the eight facts the position paper leans on. Each check asserts on
observed output, so a silent regression in the schema — or a measurement that no longer
reproduces — fails loudly here instead of shipping in the paper.

    python3 scripts/model/verify_claims.py
    exit 0 = all pass · 1 = a claim failed · 2 = a claim could not be checked here
"""
import json, os, shutil, sqlite3, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
WORK: str = ""  # set by main(); module-level so the checks can stay zero-arg
results = []


class Skip(Exception):
    """A claim that needs a dependency this checkout does not have. Reported, never a pass."""


def check(name, fn):
    try:
        results.append((name, "PASS", fn()))
    except Skip as e:
        results.append((name, "SKIP", str(e)))
    except Exception as e:
        results.append((name, "FAIL", f"{type(e).__name__}: {e}"))


def fresh(name):
    p = os.path.join(WORK, name)
    for s in ("", "-wal", "-shm"):
        if os.path.exists(p + s):
            os.remove(p + s)
    return sqlite3.connect(p, isolation_level=None), p


# ------------------------------------------------------------------ 1
def schema_parity():
    """The DDL applies, the negative tests hold, and the .puml has exactly the DDL's tables."""
    subprocess.run([sys.executable, os.path.join(ROOT, "scripts/model/gen_schema.py")],
                   capture_output=True, text=True, check=True)
    val = subprocess.run([sys.executable, os.path.join(ROOT, "scripts/model/validate_schema.py")],
                         capture_output=True, text=True)
    assert val.returncode == 0, val.stdout + val.stderr
    assert "ERRORS: none" in val.stdout, val.stdout
    site = next(l for l in val.stdout.splitlines() if l.startswith("site.db:"))
    assert "20 tables" in site and "14 FK clauses" in site and "fk_check=0" in site, site

    puml = open(os.path.join(ROOT, "docs/debate/diagrams/r1-data-model.puml")).read()
    entities = {l.split("entity ")[1].split(" as ")[0]
                for l in puml.splitlines() if l.strip().startswith("entity ")}
    ddl = set()
    for f in ("schema/control.sql", "schema/site.sql"):
        with open(os.path.join(ROOT, f)) as fh:
            ddl |= {l.split()[2] for l in fh if l.startswith("CREATE TABLE ")}
    assert entities == ddl, f"puml-only={entities - ddl} ddl-only={ddl - entities}"

    png = os.path.join(ROOT, "docs/debate/diagrams/r1-data-model.png")
    assert os.path.getsize(png) > 50_000, "png missing or stale"
    return f"{len(ddl)} entities == {len(ddl)} CREATE TABLE, png {os.path.getsize(png)} B"


# ------------------------------------------------------------------ 2
def cp_loses_data():
    """A copy of a live .db is empty; VACUUM INTO carries rows, user_version and views."""
    c, p = fresh("cp.db")
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("CREATE TABLE u_post(id INTEGER PRIMARY KEY, title TEXT)")
    c.execute("BEGIN")
    for i in range(1000):
        c.execute("INSERT INTO u_post(title) VALUES(?)", (f"p{i}",))
    c.execute("COMMIT")
    wal = os.path.getsize(p + "-wal")
    shutil.copyfile(p, os.path.join(WORK, "naive.db"))
    n = sqlite3.connect(os.path.join(WORK, "naive.db"))
    try:
        n.execute("SELECT count(*) FROM u_post").fetchone()
        raise AssertionError("cp unexpectedly carried the rows")
    except sqlite3.OperationalError as e:
        assert "no such table" in str(e), e
    finally:
        n.close()

    c.execute("CREATE VIEW v_x AS SELECT title FROM u_post")
    c.execute("PRAGMA user_version=9")
    c.execute("VACUUM INTO ?", (os.path.join(WORK, "vac.db"),))
    v = sqlite3.connect(os.path.join(WORK, "vac.db"))
    rows = v.execute("SELECT count(*) FROM u_post").fetchone()[0]
    uv = v.execute("PRAGMA user_version").fetchone()[0]
    views = v.execute("SELECT count(*) FROM sqlite_master WHERE type='view'").fetchone()[0]
    jm = v.execute("PRAGMA journal_mode").fetchone()[0]
    v.close()
    c.close()
    assert (rows, uv, views) == (1000, 9, 1), (rows, uv, views)
    assert jm == "delete", f"VACUUM INTO should drop WAL mode, got {jm}"
    return (f"cp=no such table; VACUUM INTO rows={rows} user_version={uv} views={views} "
            f"jm={jm} wal_before={wal}B")


# ------------------------------------------------------------------ 3
def key_immutability():
    """A referenced key cannot be renamed — a foreign key, not application code."""
    c, _ = fresh("immut.db")
    c.execute("PRAGMA foreign_keys=ON")
    c.execute("CREATE TABLE cms_asset(id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE COLLATE NOCASE)")
    c.execute("CREATE TABLE u_post(id INTEGER PRIMARY KEY, cover TEXT REFERENCES cms_asset(key)"
              " ON UPDATE RESTRICT ON DELETE RESTRICT)")
    c.execute("INSERT INTO cms_asset(key) VALUES('banner-home')")
    c.execute("INSERT INTO u_post(cover) VALUES('banner-home')")
    try:
        c.execute("UPDATE cms_asset SET key='renamed'")
        raise AssertionError("referenced key rename was NOT blocked by the FK")
    except sqlite3.IntegrityError:
        pass
    c.execute("DELETE FROM u_post")
    c.execute("UPDATE cms_asset SET key='renamed'")
    assert c.execute("SELECT key FROM cms_asset").fetchone()[0] == "renamed"
    c.close()
    return "referenced rename REJECTED, unreferenced rename ACCEPTED"


# ------------------------------------------------------------------ 4
def partial_index_breaks_fk():
    """A partial UNIQUE index cannot be an FK parent."""
    c, _ = fresh("partial.db")
    c.execute("PRAGMA foreign_keys=ON")
    c.execute("CREATE TABLE cms_asset(id INTEGER PRIMARY KEY, key TEXT NOT NULL, deleted_at TEXT)")
    c.execute("CREATE UNIQUE INDEX ix ON cms_asset(key) WHERE deleted_at IS NULL")
    c.execute("CREATE TABLE u_p(id INTEGER PRIMARY KEY, cover TEXT REFERENCES cms_asset(key))")
    err = None
    try:
        c.execute("INSERT INTO cms_asset(key) VALUES('x')")
        c.execute("INSERT INTO u_p(cover) VALUES('x')")
    except sqlite3.Error as e:
        err = str(e)
    c.close()
    assert err and "foreign key mismatch" in err, err
    return err


# ------------------------------------------------------------------ 5
def sequence_rebuild():
    """A table rebuild resets sqlite_sequence; a plain UPDATE restores it."""
    c, _ = fresh("seq.db")
    c.execute("CREATE TABLE u_t(id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)")
    for i in range(1, 6):
        c.execute("INSERT INTO u_t(v) VALUES(?)", (f"v{i}",))
    c.execute("DELETE FROM u_t WHERE id > 3")
    before = c.execute("SELECT seq FROM sqlite_sequence WHERE name='u_t'").fetchone()[0]
    c.execute("CREATE TABLE u_t2(id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)")
    c.execute("INSERT INTO u_t2(id,v) SELECT id,v FROM u_t")
    c.execute("DROP TABLE u_t")
    c.execute("ALTER TABLE u_t2 RENAME TO u_t")
    after = c.execute("SELECT seq FROM sqlite_sequence WHERE name='u_t'").fetchone()[0]
    assert (before, after) == (5, 3), (before, after)
    c.execute("UPDATE sqlite_sequence SET seq=5 WHERE name='u_t'")
    c.execute("INSERT INTO u_t(v) VALUES('after')")
    nxt = c.execute("SELECT max(id) FROM u_t").fetchone()[0]
    c.close()
    assert nxt == 6, nxt
    return f"seq {before}->{after} across rebuild; restored -> next id {nxt}"


# ------------------------------------------------------------------ 6
def fk_pragma_in_txn():
    """PRAGMA foreign_keys cannot be changed inside a transaction, and says nothing."""
    c, _ = fresh("fktxn.db")
    c.execute("PRAGMA foreign_keys=ON")
    c.execute("BEGIN")
    c.execute("PRAGMA foreign_keys=OFF")
    inside = c.execute("PRAGMA foreign_keys").fetchone()[0]
    c.execute("COMMIT")
    after = c.execute("PRAGMA foreign_keys").fetchone()[0]
    c.close()
    assert (inside, after) == (1, 1), (inside, after)
    return f"inside txn={inside}, after commit={after} (silently ignored)"


# ------------------------------------------------------------------ 7
def argon2_lookup():
    """Argon2id is salted, so equality lookup is impossible and redemption degenerates to a scan."""
    mod = next((c for c in (os.environ.get("SKW_ARGON2_MODULE"),
                            os.path.join(ROOT, "node_modules/@node-rs/argon2"))
                if c and os.path.isdir(c)), None)
    if not mod:
        raise Skip("npm i @node-rs/argon2 (or set SKW_ARGON2_MODULE) — the only check needing node_modules")

    js = os.path.join(WORK, "a.js")
    with open(js, "w") as fh:
        fh.write("""
const {hash, verify, Algorithm} = require(process.argv[2]);
const crypto = require('crypto');
(async () => {
  const code='A7K2M9QX4T3B', o={algorithm:Algorithm.Argon2id,timeCost:3,memoryCost:65536,parallelism:1,outputLen:32};
  const t0=process.hrtime.bigint(); const h=await hash(code,o); const tHash=Number(process.hrtime.bigint()-t0)/1e6;
  const t1=process.hrtime.bigint(); const ok=await verify(h,code,o); const tVer=Number(process.hrtime.bigint()-t1)/1e6;
  const h2=await hash(code,o);
  const t2=process.hrtime.bigint(); crypto.createHmac('sha256',crypto.randomBytes(32)).update(code).digest('hex');
  const tH=Number(process.hrtime.bigint()-t2)/1e6;
  console.log(JSON.stringify({tHash:+tHash.toFixed(1),tVer:+tVer.toFixed(1),same:h===h2,ok,tHmac:+tH.toFixed(3)}));
})();
""")
    out = subprocess.run(["node", js, mod], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr.strip()
    d = json.loads(out.stdout.strip())
    assert d["same"] is False, "two hashes of the same code matched — the paper's premise breaks"
    assert d["ok"] is True
    scan = d["tVer"] * 5000 / 1000
    assert scan > 300, f"scan cost only {scan}s; the infeasibility claim weakens"
    return (f"verify={d['tVer']}ms, salted (different hashes) -> 5000-code scan={scan:.0f}s; "
            f"hmac={d['tHmac']}ms")


# ------------------------------------------------------------------ 8
def readonly_attach():
    """A readonly handle reads a foreign tenant's file: it is a write boundary, not a tenancy one."""
    a, pa = fresh("tenant_a.db")
    a.execute("CREATE TABLE cms_page(id INTEGER PRIMARY KEY, path TEXT)")
    a.execute("INSERT INTO cms_page(path) VALUES('/x')")
    a.close()
    b, pb = fresh("tenant_b.db")
    b.execute("CREATE TABLE cms_download_code(id INTEGER PRIMARY KEY, email TEXT)")
    b.execute("INSERT INTO cms_download_code(email) VALUES('buyer@acme.com')")
    b.close()
    ro = sqlite3.connect(f"file:{pa}?mode=ro", uri=True)
    try:
        ro.execute(f"ATTACH DATABASE '{pb}' AS other")
        rows = ro.execute("SELECT email FROM other.cms_download_code").fetchall()
    finally:
        ro.close()
    assert rows and rows[0][0] == "buyer@acme.com", rows
    return f"readonly handle read {len(rows)} foreign row(s): {rows[0][0]}"


CHECKS = [
    ("1 schema/ER parity + negative tests", schema_parity),
    ("2 cp loses data, VACUUM INTO keeps it", cp_loses_data),
    ("3 key immutable by FK, not by app", key_immutability),
    ("4 partial unique index breaks FK parent", partial_index_breaks_fk),
    ("5 sqlite_sequence survives restore, not rebuild", sequence_rebuild),
    ("6 PRAGMA foreign_keys is a no-op in a txn", fk_pragma_in_txn),
    ("7 argon2id equality lookup is impossible", argon2_lookup),
    ("8 readonly is not a tenancy boundary", readonly_attach),
]


def main():
    global WORK
    WORK = tempfile.mkdtemp(prefix="skw-verify-claims-")
    for name, fn in CHECKS:
        check(name, fn)
    width = max(len(n) for n, _, _ in results)
    for name, status, detail in results:
        print(f"{status}  {name.ljust(width)}  {detail}")
    failed = [r for r in results if r[1] == "FAIL"]
    skipped = [r for r in results if r[1] == "SKIP"]
    print(f"\n{len(results) - len(failed) - len(skipped)}/{len(results)} passed, "
          f"{len(skipped)} skipped, {len(failed)} failed")
    shutil.rmtree(WORK, ignore_errors=True)
    sys.exit(1 if failed else (2 if skipped else 0))


if __name__ == "__main__":
    main()
