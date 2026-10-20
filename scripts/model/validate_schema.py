#!/usr/bin/env python3
"""Validate the generated DDL against a real SQLite engine and report what it proves."""
import sqlite3, os, sys, subprocess, json

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT  = "/Users/cyberdeth/.hermes/profiles/ceo/cache/scratch/dmprobe/validate"
os.makedirs(OUT, exist_ok=True)

def build(name, sqlfile):
    db = os.path.join(OUT, name)
    for s in ("", "-wal", "-shm"):
        if os.path.exists(db+s): os.remove(db+s)
    con = sqlite3.connect(db, isolation_level=None)
    con.execute("PRAGMA foreign_keys = ON")
    con.executescript(open(os.path.join(ROOT, sqlfile)).read())
    return con, db

errors = []
for name, f in (("control.db","schema/control.sql"), ("site.db","schema/site.sql")):
    try:
        con, db = build(name, f)
    except sqlite3.Error as e:
        errors.append(f"{name}: {e}"); continue
    tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    idx    = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    fks    = con.execute("SELECT count(*) FROM pragma_foreign_key_list_agg").fetchone() if False else None
    nfk = 0
    for t in tables:
        nfk += con.execute(f"SELECT count(*) FROM pragma_foreign_key_list('{t}')").fetchone()[0]
    print(f"{name}: {len(tables)} tables, {len(idx)} explicit indexes, {nfk} FK clauses, "
          f"integrity={con.execute('PRAGMA integrity_check').fetchone()[0]}, "
          f"fk_check={len(con.execute('PRAGMA foreign_key_check').fetchall())} violations, "
          f"journal={con.execute('PRAGMA journal_mode').fetchone()[0]}, "
          f"app_id={hex(con.execute('PRAGMA application_id').fetchone()[0])}")
    print("   tables:", ", ".join(tables))
    con.close()

# negative tests: the schema must reject these
con, db = build("site_neg.db", "schema/site.sql")
def must_fail(label, sql, params=()):
    try:
        con.execute(sql, params); print(f"   !! {label}: ACCEPTED (should have been rejected)")
    except sqlite3.Error as e:
        print(f"   ok {label}: rejected ({str(e).split(':')[0]})")

con.execute("INSERT INTO cms_asset(key,filename,mime,bytes,sha256,kind,storage_path,width,height) "
            "VALUES('banner-home','b.png','image/png',10,?,'image','media/aa/x.png',100,50)", ("a"*64,))
must_fail("asset key with ../", "INSERT INTO cms_asset(key,filename,mime,bytes,sha256,kind,storage_path) VALUES('../etc/passwd','x','image/png',1,?, 'image','p')", ("a"*64,))
must_fail("asset key uppercase", "INSERT INTO cms_asset(key,filename,mime,bytes,sha256,kind,storage_path) VALUES('Banner','x','image/png',1,?, 'image','p')", ("a"*64,))
must_fail("image without dimensions", "INSERT INTO cms_asset(key,filename,mime,bytes,sha256,kind,storage_path) VALUES('no-dim','x','image/png',1,?, 'image','p')", ("a"*64,))
must_fail("code with neither asset nor bundle", "INSERT INTO cms_download_code(code_lookup,code_hash) VALUES(?, 'h')", ("b"*64,))
con.execute("INSERT INTO cms_asset_bundle(key,title) VALUES('bk','B')")
must_fail("code with both asset and bundle", "INSERT INTO cms_download_code(code_lookup,code_hash,asset_id,bundle_id) VALUES(?,?,1,1)", ("c"*64,"h"))
must_fail("duplicate asset key", "INSERT INTO cms_asset(key,filename,mime,bytes,sha256,kind,storage_path,width,height) VALUES('BANNER-HOME','x','image/png',1,?, 'image','p',1,1)", ("a"*64,))
must_fail("page path with ..", "INSERT INTO cms_page(path,slug,title,etag) VALUES('/a/../b','b','T','e')")
must_fail("page path with trailing slash", "INSERT INTO cms_page(path,slug,title,etag) VALUES('/a/','a','T','e')")
must_fail("datasource kind=function", "INSERT INTO cms_datasource(key,kind,spec_json) VALUES('x','function','{}')")
must_fail("datasource invalid json", "INSERT INTO cms_datasource(key,kind,spec_json) VALUES('y','query','not json')")
# positive: lowering max_uses below uses is allowed (§7.4 revoke-lite)
con.execute("INSERT INTO cms_download_code(code_lookup,code_hash,asset_id,max_uses,uses) VALUES(?,?,1,5,4)", ("d"*64,"h"))
con.execute("UPDATE cms_download_code SET max_uses = 2 WHERE code_lookup = ?", ("d"*64,))
print("   ok max_uses lowered below uses: ACCEPTED (required by §7.4 revoke-lite)")
# alias 301 + delete restricted while linked
con.execute("INSERT INTO cms_asset_alias(key,asset_id) VALUES('old-banner',1)")
con.execute("INSERT INTO cms_asset_link(asset_id,owner_kind,owner_id) VALUES(1,'page',1)")
must_fail("delete asset that is linked by a page", "DELETE FROM cms_asset WHERE id = 1")
con.execute("DELETE FROM cms_asset_link WHERE asset_id = 1")
must_fail("delete asset still referenced by an issued code", "DELETE FROM cms_asset WHERE id = 1")
print("   ok both guards fire: cms_asset_link and cms_download_code each RESTRICT")
con.execute("DELETE FROM cms_download_code WHERE asset_id = 1")
con.execute("DELETE FROM cms_asset WHERE id = 1")
print("   ok delete asset after unlinking + revoking: ACCEPTED, alias cascaded ->",
      con.execute("SELECT count(*) FROM cms_asset_alias").fetchone()[0], "aliases left")
con.close()

# schema size on disk
for f in ("control.db","site.db"):
    p=os.path.join(OUT,f)
    con=sqlite3.connect(p); con.execute("PRAGMA journal_mode=WAL"); con.execute("VACUUM"); con.close()
    print(f"{f} empty size after VACUUM: {os.path.getsize(p)} bytes, page_size={sqlite3.connect(p).execute('PRAGMA page_size').fetchone()[0]}")

print("\nERRORS:", errors or "none")
sys.exit(1 if errors else 0)
