#!/usr/bin/env python3
"""Ad-hoc verification of the claims in docs/debate/r1-data-model.md. NOT a test suite.

Re-derives, from scratch, the eight facts the position paper leans on. Each check asserts on
observed output, so a silent regression in the schema — or a measurement that no longer
reproduces — fails loudly here instead of shipping in the paper.

    python3 scripts/model/verify_claims.py
    exit 0 = all pass · 1 = a claim failed · 2 = a claim could not be checked here
"""
import hashlib, json, os, re, shutil, sqlite3, statistics, subprocess, sys, tempfile, threading, time

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


# ================================================================ R2 additions
# Each check below settles a dispute raised in round 2 and is named in
# docs/debate/r2-data-model.md §5 by number. Nothing here is a proposal that has not run.

SITE_SQL = os.path.join(ROOT, "schema/site.sql")
AMENDMENTS = os.path.join(ROOT, "schema/r2-amendments.sql")
PROJECTION = os.path.join(ROOT, "schema/export-projection.json")


def v1_fixture(name="r2base.db"):
    """A user_version=1 site.db with one of everything the amendments touch.

    Three pages, the highest one deleted, so sqlite_sequence (3) is ahead of max(id) (2): that is the
    state in which a rebuild without the counter carry-forward reissues an id (R1 M5).
    """
    c, p = fresh(name)
    c.executescript(open(SITE_SQL).read())
    c.execute("INSERT INTO cms_asset(key,filename,mime,bytes,sha256,kind,storage_path,width,height)"
              " VALUES('banner-home','b.jpg','image/jpeg',10,?,'image','content/media/ab/x.jpg',10,10)",
              ("ab" * 32,))
    c.execute("INSERT INTO cms_asset(key,filename,mime,bytes,sha256,kind,storage_path)"
              " VALUES('book','b.pdf','application/pdf',20,?,'document','content/media/cd/y.pdf')",
              ("cd" * 32,))
    for i in (1, 2, 3):
        c.execute("INSERT INTO cms_page(path,slug,title,etag,body_html,css)"
                  " VALUES(?,?,?,'e','<p>hi</p>','.x{}')", (f"/p{i}", f"p{i}", f"P{i}"))
    c.execute("DELETE FROM cms_page WHERE id = 3")
    c.execute("INSERT INTO cms_page_revision(page_id,body_html,css) VALUES(1,'<p>v1</p>','')")
    c.execute("INSERT INTO cms_page_revision(page_id,body_html,css) VALUES(1,'<p>v2</p>','')")
    c.execute("INSERT INTO cms_asset_link(asset_id,owner_kind,owner_id) VALUES(1,'page',1)")
    c.execute("INSERT INTO cms_asset_bundle(key,title) VALUES('set','Set')")
    c.execute("INSERT INTO cms_asset_bundle_item(bundle_id,asset_id,position) VALUES(1,1,0)")
    c.execute("INSERT INTO cms_asset_variant(asset_id,label,format,width,height,bytes,sha256,storage_path)"
              " VALUES(1,'thumb','webp',1,1,5,'ee','x')")
    c.execute("INSERT INTO cms_asset_alias(key,asset_id) VALUES('old-banner',1)")
    c.execute("INSERT INTO cms_download_code(code_lookup,code_hash,asset_id) VALUES(?,'h',1)",
              ("f" * 64,))
    c.execute("INSERT INTO cms_download_event(code_id,asset_id,bytes_sent,ranged,outcome)"
              " VALUES(1,1,123,0,'ok')")
    c.execute("INSERT INTO cms_watermark_render(asset_id,spec_sha,source_sha,bytes,path)"
              " VALUES(1,'s','src',1,'p')")
    return c, p


_AMENDED = {}


def amended(name="r2.db"):
    """v1 fixture + schema/r2-amendments.sql, built once per run."""
    if name not in _AMENDED:
        c, p = v1_fixture(name + ".base")
        c.close()
        c = sqlite3.connect(p, isolation_level=None)
        c.executescript(open(AMENDMENTS).read())
        _AMENDED[name] = (c, p)
    return _AMENDED[name]


def r2_amendments_apply():
    """The amendment file applies to a populated v1 file and preserves every row it must."""
    c, p = amended()
    assert c.execute("PRAGMA user_version").fetchone()[0] == 2
    assert c.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert c.execute("PRAGMA foreign_key_check").fetchall() == []
    revs = c.execute("SELECT count(*) FROM cms_page_revision").fetchone()[0]
    assert revs == 2, f"page revisions lost in the rebuild: {revs}"
    seqs = dict(c.execute("SELECT name, seq FROM sqlite_sequence").fetchall())
    assert seqs["cms_page"] == 3, f"sequence not carried forward: {seqs['cms_page']} != 3"
    paths = c.execute("SELECT key, storage_path FROM cms_asset ORDER BY id").fetchall()
    rx = re.compile(r"^content/media/[0-9a-f]{2}/[0-9a-f]{64}\.(jpg|pdf|webp|png|mp4|mp3|zip|bin)$")
    for key, sp in paths:
        assert rx.match(sp), f"derived path malformed for {key}: {sp}"
    reg = {r[0] for r in c.execute("SELECT name FROM cms_trigger_registry")}
    live = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='trigger'")}
    assert reg == live, f"triggers unregistered: {live - reg} / stale: {reg - live}"
    cols = {r[1] for r in c.execute("PRAGMA table_info(cms_page)")}
    assert {"rev", "body_sha", "body_css", "managed_by"} <= cols and "etag" not in cols, cols
    ev = {r[1] for r in c.execute("PRAGMA table_info(cms_download_event)")}
    assert {"jti", "kind", "bytes_declared", "bytes_sent"} <= ev and "ranged" not in ev, ev
    return (f"user_version 2, integrity ok, fk_check 0, revisions={revs}, "
            f"seq cms_page={seqs['cms_page']}, {len(live)} triggers all registered")


def root_path_accepted():
    """Path columns are canonical: '/' insertable, '//evil' and '..' rejected (page + redirect)."""
    c, _ = fresh("root.db")
    c.executescript(open(SITE_SQL).read())
    v1 = None
    try:
        c.execute("INSERT INTO cms_page(path,slug,title,etag) VALUES('/','home','Home','e')")
    except sqlite3.IntegrityError as e:
        v1 = str(e)
    # the shipped redirect CHECK accepted a protocol-relative target, which is an open redirect
    v1_redir = None
    try:
        c.execute("INSERT INTO cms_redirect(from_path,to_path) VALUES('/go','//evil.example')")
        v1_redir = "ACCEPTED"
    except sqlite3.IntegrityError as e:
        v1_redir = f"rejected ({e})"
    c.close()
    a, _ = amended()
    a.execute("INSERT INTO cms_page(path,slug,title,body_sha) VALUES('/','home','Home','')")
    kept = a.execute("SELECT count(*) FROM cms_page WHERE path='/'").fetchone()[0]
    assert v1 and "CHECK constraint failed" in v1, f"v1 unexpectedly accepted the root path: {v1}"
    assert kept == 1
    assert v1_redir == "ACCEPTED", f"v1 redirect CHECK was already strict: {v1_redir}"
    for bad in ("/a/", "/../x", "/x//y"):
        try:
            a.execute("INSERT INTO cms_page(path,slug,title,body_sha) VALUES(?,?,?,'')",
                      (bad, "z", "Z"))
            raise AssertionError(f"amended CHECK accepted {bad!r}")
        except sqlite3.IntegrityError:
            pass
    for bad in ("//evil.example", "/a/../b", "/x/"):
        try:
            a.execute("INSERT INTO cms_redirect(from_path,to_path) VALUES('/go',?)", (bad,))
            raise AssertionError(f"amended redirect CHECK accepted to_path={bad!r}")
        except sqlite3.IntegrityError:
            pass
    a.execute("INSERT INTO cms_redirect(from_path,to_path) VALUES('/old-home','/')")
    a.execute("DELETE FROM cms_page WHERE path='/'")
    a.execute("DELETE FROM cms_redirect WHERE from_path='/old-home'")
    return ("v1 REJECTED '/' (homepage uninsertable) and ACCEPTED to_path='//evil.example'; "
            "amended accepts '/', rejects '/a/', '/../x', '/x//y' and '//evil.example', '/a/../b', '/x/'")


def generated_path_is_unwritable():
    """storage_path is a generated column: no INSERT, no UPDATE, from any driver (Red Team O5)."""
    c, _ = amended()
    errs = []
    for stmt, args in (
        ("INSERT INTO cms_asset(key,filename,mime,bytes,sha256,kind,storage_path)"
         " VALUES('evil','e.txt','text/plain',1,?,'document','../../etc/passwd')", ("9" * 64,)),
        ("UPDATE cms_asset SET storage_path='/etc/passwd' WHERE key='banner-home'", ()),
    ):
        try:
            c.execute(stmt, args)
            raise AssertionError(f"wrote a generated column: {stmt[:40]}")
        except sqlite3.OperationalError as e:
            errs.append(str(e))
    # sha256 is immutable by trigger, and the guard blocks deleting a referenced asset with FKs OFF
    try:
        c.execute("UPDATE cms_asset SET sha256=? WHERE key='banner-home'", ("1" * 64,))
        raise AssertionError("sha256 update was not blocked")
    except sqlite3.IntegrityError as e:
        sha_err = str(e)
    return f"{errs[0]}; {errs[1]}; sha256 -> {sha_err}"


def trigger_guard_without_fk():
    """The delete guard fires with foreign_keys=OFF, including from the sqlite3 CLI (Security A-4)."""
    c, p = amended("guard.db")
    assert c.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    c.execute("PRAGMA foreign_keys=OFF")
    assert c.execute("PRAGMA foreign_keys").fetchone()[0] == 0
    py_err = None
    try:
        c.execute("DELETE FROM cms_asset WHERE key='banner-home'")
    except sqlite3.IntegrityError as e:
        py_err = str(e)
    assert py_err == "DM_E_ASSET_IN_USE", py_err
    cli = subprocess.run(["sqlite3", p, "DELETE FROM cms_asset WHERE key='banner-home';"],
                         capture_output=True, text=True)
    assert cli.returncode != 0 and "DM_E_ASSET_IN_USE" in (cli.stderr or ""), (cli.returncode, cli.stderr)
    live = c.execute("SELECT count(*) FROM cms_asset WHERE key='banner-home'").fetchone()[0]
    assert live == 1, "asset disappeared despite the guard"
    # Derived rows cascade only with the pragma ON — with it OFF a CASCADE child is orphaned, not
    # deleted, which is one more reason the export gates on foreign_key_check (I4).
    c.execute("PRAGMA foreign_keys=ON")
    assert c.execute("SELECT count(*) FROM cms_asset_variant").fetchone()[0] == 1
    c.execute("DELETE FROM cms_asset_link WHERE asset_id=1")
    c.execute("DELETE FROM cms_asset_bundle_item WHERE asset_id=1")
    c.execute("DELETE FROM cms_download_code WHERE asset_id=1")
    c.execute("DELETE FROM cms_asset WHERE key='banner-home'")
    assert c.execute("SELECT count(*) FROM cms_asset WHERE key='banner-home'").fetchone()[0] == 0
    cascaded = {t: c.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
                for t in ("cms_asset_variant", "cms_asset_alias", "cms_watermark_render")}
    assert cascaded == {"cms_asset_variant": 0, "cms_asset_alias": 0, "cms_watermark_render": 0}, cascaded
    return (f"fk=0 python -> {py_err}; cli rc={cli.returncode} -> {cli.stderr.strip()}; "
            f"unreferenced delete OK with fk=1, derived rows cascaded {cascaded}")


def rebuild_cascade_hazard():
    """Rebuilding a parent table with foreign_keys=ON cascade-deletes the children it must preserve."""
    def build(name):
        c, p = fresh(name)
        c.executescript(open(SITE_SQL).read())
        c.execute("INSERT INTO cms_page(path,slug,title,etag) VALUES('/home','home','Home','e')")
        c.execute("INSERT INTO cms_page_revision(page_id,body_html,css) VALUES(1,'<p>v1</p>','')")
        c.execute("INSERT INTO cms_page_revision(page_id,body_html,css) VALUES(1,'<p>v2</p>','')")
        return c

    on = build("casc_on.db")
    on.execute("PRAGMA foreign_keys=ON")
    on.execute("BEGIN IMMEDIATE")
    on.execute("CREATE TABLE cms_page_new(id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE,"
               " slug TEXT, title TEXT, status TEXT, template TEXT, body_html TEXT, body_css TEXT)")
    on.execute("INSERT INTO cms_page_new SELECT id,path,slug,title,status,template,body_html,css"
               " FROM cms_page")
    before = on.execute("SELECT count(*) FROM cms_page_revision").fetchone()[0]
    on.execute("DROP TABLE cms_page")
    after_on = on.execute("SELECT count(*) FROM cms_page_revision").fetchone()[0]
    on.execute("ROLLBACK")
    on.close()

    off = build("casc_off.db")
    off.execute("PRAGMA foreign_keys=OFF")
    off.execute("BEGIN IMMEDIATE")
    off.execute("CREATE TABLE cms_page_new(id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE,"
                " slug TEXT, title TEXT, status TEXT, template TEXT, body_html TEXT, body_css TEXT)")
    off.execute("INSERT INTO cms_page_new SELECT id,path,slug,title,status,template,body_html,css"
                " FROM cms_page")
    off.execute("DROP TABLE cms_page")
    off.execute("ALTER TABLE cms_page_new RENAME TO cms_page")
    after_off = off.execute("SELECT count(*) FROM cms_page_revision").fetchone()[0]
    off.execute("COMMIT")
    off.close()
    assert (before, after_on, after_off) == (2, 0, 2), (before, after_on, after_off)
    return (f"revisions before={before}; DROP with fk=ON -> {after_on} (cascade deleted); "
            f"rebuild with fk=OFF -> {after_off}")


def dedupe_order_matters():
    """Security DS-5's write order spends one use per request; insert-first spends one per download."""
    N = 24

    def run(scheme):
        p = os.path.join(WORK, f"race_{scheme}.db")
        for s in ("", "-wal", "-shm"):
            if os.path.exists(p + s):
                os.remove(p + s)
        c = sqlite3.connect(p, isolation_level=None)
        c.execute("PRAGMA journal_mode=WAL")
        c.executescript(
            "CREATE TABLE code(id INTEGER PRIMARY KEY, max_uses INT, uses INT NOT NULL DEFAULT 0);"
            "CREATE TABLE ev(id INTEGER PRIMARY KEY, jti TEXT, kind TEXT NOT NULL);"
            "CREATE UNIQUE INDEX ux ON ev(jti) WHERE kind='first';"
            "INSERT INTO code(id,max_uses,uses) VALUES(1,100,0);")
        c.close()
        errs = []

        def worker():
            try:
                d = sqlite3.connect(p, isolation_level=None, timeout=10)
                d.execute("PRAGMA busy_timeout=10000")
                d.execute("BEGIN IMMEDIATE")
                if scheme == "A":
                    d.execute("UPDATE code SET uses=uses+1 WHERE id=1 AND uses<max_uses")
                    d.execute("INSERT INTO ev(jti,kind) VALUES('J1','first') ON CONFLICT DO NOTHING")
                else:
                    cur = d.execute("INSERT INTO ev(jti,kind) VALUES('J1','first')"
                                    " ON CONFLICT DO NOTHING")
                    if cur.rowcount == 1:
                        d.execute("UPDATE code SET uses=uses+1 WHERE id=1 AND uses<max_uses")
                d.execute("COMMIT")
                d.close()
            except Exception as e:  # pragma: no cover - surfaced in the assertion
                errs.append(f"{type(e).__name__}: {e}")

        ts = [threading.Thread(target=worker) for _ in range(N)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        d = sqlite3.connect(p)
        uses = d.execute("SELECT uses FROM code WHERE id=1").fetchone()[0]
        rows = d.execute("SELECT count(*) FROM ev").fetchone()[0]
        d.close()
        assert not errs, errs
        return uses, rows

    a_uses, a_rows = run("A")
    b_uses, b_rows = run("B")
    assert (a_rows, b_rows) == (1, 1), (a_rows, b_rows)
    assert a_uses == 24 and b_uses == 1, (a_uses, b_uses)
    return (f"{N} concurrent requests, one jti: update-first uses={a_uses} (events={a_rows}); "
            f"insert-first uses={b_uses} (events={b_rows})")


def partial_unique_jti():
    """(jti) WHERE kind='first' constrains the first row only and tolerates NULL jti."""
    c, _ = amended("jti.db")
    for _ in range(3):
        c.execute("INSERT INTO cms_download_event(jti,kind,outcome) VALUES(NULL,'denied','denied_token')")
    c.execute("INSERT INTO cms_download_event(jti,kind,outcome) VALUES('J1','first','ok')")
    c.execute("INSERT INTO cms_download_event(jti,kind,outcome) VALUES('J1','range','ok')")
    dup = None
    try:
        c.execute("INSERT INTO cms_download_event(jti,kind,outcome) VALUES('J1','first','ok')")
    except sqlite3.IntegrityError as e:
        dup = str(e)
    assert dup and "UNIQUE" in dup, dup
    n = c.execute("SELECT count(*) FROM cms_download_event WHERE jti IS NULL").fetchone()[0]
    c.close()
    return f"3 NULL-jti denials accepted; (J1,'first') twice -> {dup}; (J1,'range') accepted; null={n}"


def export_projection_reproducible():
    """Two exports of the same content are not byte-identical, but the projection digest is."""
    proj = json.load(open(PROJECTION))
    ddl = {l.split()[2] for l in open(SITE_SQL) if l.startswith("CREATE TABLE ")}
    assert ddl == set(proj["tables"]), f"unclassified={ddl - set(proj['tables'])} stale={set(proj['tables']) - ddl}"

    c, p = fresh("proj_src.db")
    c.executescript(open(SITE_SQL).read())
    c.execute("INSERT INTO cms_page(path,slug,title,etag) VALUES('/home','home','Home','e')")
    c.execute("INSERT INTO cms_asset(key,filename,mime,bytes,sha256,kind,storage_path,width,height)"
              " VALUES('banner-home','b.jpg','image/jpeg',10,?,'image','x',10,10)", ("ab" * 32,))
    c.execute("INSERT INTO cms_settings(key,value_json,type) VALUES('site.name','\"Acme\"','string')")
    c.execute("INSERT INTO cms_settings(key,value_json,type) VALUES('demo.banner','true','bool')")
    c.execute("INSERT INTO cms_form(key,title,fields_json) VALUES('contact','Contact','[]')")
    c.execute("INSERT INTO cms_redirect(from_path,to_path) VALUES('/old','/home')")

    def sha(pth):
        return hashlib.sha256(open(pth, "rb").read()).hexdigest()

    def digest(pth):
        d = sqlite3.connect(pth)
        h = hashlib.sha256()
        for t in sorted(proj["tables"]):
            spec = proj["tables"][t]
            if spec["mode"] == "empty":
                continue
            where = f" WHERE {spec['filter']}" if spec.get("filter") else ""
            rows = [json.dumps(r, default=str, sort_keys=True)
                    for r in d.execute(f"SELECT * FROM {t}{where}").fetchall()]
            h.update(t.encode())
            h.update(json.dumps(sorted(rows)).encode())
        d.close()
        return h.hexdigest()

    def vac(name):
        out = os.path.join(WORK, name)
        if os.path.exists(out):
            os.remove(out)
        c.execute("VACUUM INTO ?", (out,))
        return out

    e1 = vac("e1.db")
    e1b = vac("e1b.db")
    # volatile rows: a download event, an audit row, a form submission, a watermark render
    c.execute("INSERT INTO cms_download_event(asset_id,outcome) VALUES(1,'ok')")
    c.execute("INSERT INTO cms_audit(actor_label,action) VALUES('op@us','page.save')")
    c.execute("INSERT INTO cms_form_submission(form_id,payload_json) VALUES(1,'{\"a\":1}')")
    e2 = vac("e2.db")
    # a content change must move the digest, or the digest is a constant
    c.execute("UPDATE cms_page SET title='Home v2' WHERE path='/home'")
    e3 = vac("e3.db")
    c.close()
    assert sha(e1) == sha(e1b), "VACUUM INTO is not deterministic on an unchanged source"
    assert sha(e1) != sha(e2), "volatile rows did not change the file — the claim under test is moot"
    assert digest(e1) == digest(e2), "projection digest moved on volatile-only rows"
    assert digest(e1) != digest(e3), "projection digest ignored a content change"
    return (f"{len(ddl)}/{len(ddl)} tables classified; vac==vac {sha(e1)[:12]}; "
            f"after volatile rows file {sha(e2)[:12]} (differs) but projection {digest(e2)[:12]} "
            f"(identical); content change -> {digest(e3)[:12]} (differs)")


def argon2_param_cost():
    """What the 19456/2/1 vs 65536/3/1 disagreement costs per verification on this box."""
    try:
        from argon2.low_level import hash_secret_raw, Type
    except ImportError:
        raise Skip("pip install argon2-cffi")
    def bench(mem, tc, par, n=8):
        salt = os.urandom(16)
        ts = []
        for _ in range(n):
            t0 = time.perf_counter()
            hash_secret_raw(b"A7K2M9QX4T3B", salt, time_cost=tc, memory_cost=mem,
                            parallelism=par, hash_len=32, type=Type.ID)
            ts.append((time.perf_counter() - t0) * 1000)
        return ts

    fast = bench(19456, 2, 1)
    heavy = bench(65536, 3, 1)
    assert all(0 < x < 5000 for x in fast + heavy)
    assert statistics.median(fast) < statistics.median(heavy)
    return (f"m=19456,t=2,p=1 min={min(fast):.1f} med={statistics.median(fast):.1f}ms; "
            f"m=65536,t=3,p=1 min={min(heavy):.1f} med={statistics.median(heavy):.1f}ms "
            f"({statistics.median(heavy) / statistics.median(fast):.1f}x)")


def audit_chain_needs_an_anchor():
    """A hash chain in the file the attacker can write re-verifies after tampering. An anchor does not."""
    def chain(rows, prev="0" * 32):
        out = []
        for r in rows:
            h = hashlib.sha256((prev + json.dumps(r, sort_keys=True)).encode()).hexdigest()
            out.append((prev, h, r))
            prev = h
        return out, prev

    rows = [{"id": 1, "action": "page.save"}, {"id": 2, "action": "asset.delete"},
            {"id": 3, "action": "code.issue"}]
    built, head = chain(rows)
    tampered = [{"id": 1, "action": "page.save"}, {"id": 2, "action": "asset.delete"},
                {"id": 3, "action": "code.issue"}]
    tampered[1]["action"] = "asset.restore"
    rebuilt, new_head = chain(tampered)
    # an attacker with write access also rewrites every hash column
    unanchored_ok = rebuilt[-1][1] == new_head
    anchored_ok = (new_head == head)
    assert unanchored_ok and not anchored_ok, (unanchored_ok, anchored_ok)
    return (f"tamper row 2 + recompute chain -> unanchored chain verifies ({unanchored_ok}); "
            f"anchored head mismatches ({head[:8]}.. -> {new_head[:8]}..)")


def asset_guard_cost():
    """What the delete guard costs when the ASSET column it probes is not indexed."""
    def build(name, indexed):
        c, p = fresh(name)
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        c.executescript(
            "CREATE TABLE cms_asset(id INTEGER PRIMARY KEY, key TEXT UNIQUE COLLATE NOCASE);"
            "CREATE TABLE u_post(id INTEGER PRIMARY KEY, cover TEXT REFERENCES cms_asset(key));"
            "CREATE TRIGGER trg_asset_guard_u_post BEFORE DELETE ON cms_asset"
            " WHEN EXISTS (SELECT 1 FROM u_post WHERE cover = OLD.key)"
            " BEGIN SELECT RAISE(ABORT,'DM_E_KEY_IN_USE'); END;")
        c.execute("BEGIN")
        c.execute("INSERT INTO cms_asset(key) VALUES('banner-home')")
        c.executemany("INSERT INTO u_post(id,cover) VALUES(?,?)",
                      [(i, "banner-home") for i in range(200000)])
        c.execute("COMMIT")
        if indexed:
            c.execute("CREATE INDEX ix_post_cover ON u_post(cover)")
        return c

    out = {}
    for indexed in (False, True):
        c = build(f"gcost_{indexed}.db", indexed)
        ts = []
        for n in range(5):
            c.execute("INSERT INTO cms_asset(key) VALUES(?)", (f"orphan{n}",))
            t0 = time.perf_counter()
            c.execute("DELETE FROM cms_asset WHERE key=?", (f"orphan{n}",))
            ts.append((time.perf_counter() - t0) * 1000)
        out[indexed] = statistics.median(ts)
        c.close()
    assert out[False] > 1.0, f"unindexed probe too cheap to demonstrate the point: {out[False]}"
    assert out[True] < out[False] / 10, out
    return (f"200k referencing rows, unreferenced delete: no index {out[False]:.2f} ms, "
            f"indexed {out[True]:.3f} ms (n=5 each)")


CHECKS = [
    ("1 schema/ER parity + negative tests", schema_parity),
    ("2 cp loses data, VACUUM INTO keeps it", cp_loses_data),
    ("3 key immutable by FK, not by app", key_immutability),
    ("4 partial unique index breaks FK parent", partial_index_breaks_fk),
    ("5 sqlite_sequence survives restore, not rebuild", sequence_rebuild),
    ("6 PRAGMA foreign_keys is a no-op in a txn", fk_pragma_in_txn),
    ("7 argon2id equality lookup is impossible", argon2_lookup),
    ("8 readonly is not a tenancy boundary", readonly_attach),
    # ---- R2 ----
    ("9  r2 amendments apply to a populated v1", r2_amendments_apply),
    ("10 root path '/' is insertable", root_path_accepted),
    ("11 storage_path is generated, sha256 immutable", generated_path_is_unwritable),
    ("12 asset delete guard holds with foreign_keys=OFF", trigger_guard_without_fk),
    ("13 rebuild with fk=ON cascade-deletes children", rebuild_cascade_hazard),
    ("14 dedupe write order: 24 requests, 1 download", dedupe_order_matters),
    ("15 (jti) WHERE kind='first' tolerates NULL", partial_unique_jti),
    ("16 export projection is the reproducible unit", export_projection_reproducible),
    ("17 argon2 parameter cost on this box", argon2_param_cost),
    ("18 an unanchored audit chain proves nothing", audit_chain_needs_an_anchor),
    ("19 delete-guard cost, indexed vs not", asset_guard_cost),
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
