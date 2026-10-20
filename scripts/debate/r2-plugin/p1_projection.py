#!/usr/bin/env python3
"""R2.5 plugin probe 1 — does the export projection survive a table created at runtime?

Builds a real site.db from schema/site.sql + schema/r2-amendments.sql, then applies a
plugin's migrations and asks the same question verify_claims.py check 16 asks, but of the
*actual* schema rather than of site.sql's text.

Run: python3 scripts/debate/r2-plugin/p1_projection.py
"""
import hashlib, json, os, sqlite3, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
WORK = os.environ.get("SK_PLUGIN_WORK", os.path.expanduser(
    "~/.hermes/profiles/ceo/cache/scratch/pluginprobe/work"))
os.makedirs(WORK, exist_ok=True)

SITE = os.path.join(ROOT, "schema/site.sql")
AMEND = os.path.join(ROOT, "schema/r2-amendments.sql")
PROJ = os.path.join(ROOT, "schema/export-projection.json")

PLUGIN_MIGRATION = """
CREATE TABLE p_contact_message (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  email TEXT NOT NULL CHECK(email LIKE '%_@_%.__%'),
  message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 4000),
  ip_hash TEXT NOT NULL,
  ua_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'new' CHECK(state IN ('new','read','spam')),
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX ix_p_contact_message_ts ON p_contact_message(ts);
CREATE TABLE p_contact_setting (
  key TEXT PRIMARY KEY CHECK(key GLOB '[a-z0-9._]*'),
  value_json TEXT NOT NULL
);
"""


def fresh(name):
    p = os.path.join(WORK, name)
    for s in ("", "-wal", "-shm", "-journal"):
        if os.path.exists(p + s):
            os.remove(p + s)
    c = sqlite3.connect(p, isolation_level=None)
    c.execute("PRAGMA foreign_keys = ON")
    return c, p


def tables(c):
    return {r[0] for r in c.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}


def classify(con, proj):
    ddl = tables(con)
    return ddl, set(proj["tables"]), ddl - set(proj["tables"]), set(proj["tables"]) - ddl


def main():
    proj = json.load(open(PROJ))

    # ---- the gate as shipped: text of site.sql vs the projection file -------------
    ddl_text = {l.split()[2] for l in open(SITE) if l.startswith("CREATE TABLE ")}
    print("1. the shipped gate reads one DDL file, not the schema")
    print(f"   tables in site.sql                     : {len(ddl_text)}")
    print(f"   tables in export-projection.json       : {len(proj['tables'])}")
    print(f"   site.sql - projection                  : {sorted(ddl_text - set(proj['tables']))}")

    # ---- the schema a tenant actually runs ---------------------------------------
    con, db = fresh("site_v2.db")
    con.executescript(open(SITE).read())
    con.executescript(open(AMEND).read())
    ddl, pk, unclassified, stale = classify(con, proj)
    print("\n2. same question against the schema a tenant actually runs (site.sql + r2-amendments.sql)")
    print(f"   user_version                           : {con.execute('PRAGMA user_version').fetchone()[0]}")
    print(f"   tables in sqlite_master                : {len(ddl)}")
    print(f"   unclassified (build failure per I10)   : {sorted(unclassified)}")
    print(f"   stale entries in projection            : {sorted(stale)}")

    # ---- with one plugin installed ----------------------------------------------
    con.executescript(PLUGIN_MIGRATION)
    ddl2, _, unclassified2, stale2 = classify(con, proj)
    print("\n3. after installing one plugin with 2 tables + 1 index")
    print(f"   tables in sqlite_master                : {len(ddl2)}")
    print(f"   unclassified (build failure per I10)   : {sorted(unclassified2)}")
    print(f"   of which plugin-owned                  : {sorted(t for t in unclassified2 if t.startswith('p_'))}")

    # ---- can the DDL runner's identifier regex express a plugin table? -----------
    import re
    rx = re.compile(r"^u_[a-z0-9_]+$")
    print("\n4. IDEA §6 DDL runner regex ^u_[a-z0-9_]+$ against plugin identifiers")
    for name in ("u_product", "p_contact_message", "cms_page"):
        print(f"   {name:22s} accepted={bool(rx.match(name))}")

    # ---- the GLOB lesson from Data Model round 2, applied to a prefix CHECK ------
    print("\n5. prefix CHECK: GLOB 'p_*' accepts an empty plugin id (the '*/' mistake, one level up)")
    for pat in ("p_*", "p_?*"):
        row = con.execute("SELECT ? GLOB ?, ? GLOB ?", ("p_", pat, "p_contact", pat)).fetchone()
        print(f"   GLOB {pat:6s}  'p_'->{row[0]}   'p_contact'->{row[1]}")

    # ---- does VACUUM INTO carry plugin rows, and what does it cost? --------------
    ins = con.prepare if False else None
    rows = [(f"Person {i}", f"p{i}@example.com", "x" * 300, "a" * 64, "b" * 64)
            for i in range(200)]
    con.execute("BEGIN IMMEDIATE")
    con.executemany("INSERT INTO p_contact_message(name,email,message,ip_hash,ua_hash)"
                    " VALUES(?,?,?,?,?)", rows)
    con.execute("COMMIT")
    before = os.path.getsize(db)
    out = os.path.join(WORK, "site_plugin_export.db")
    if os.path.exists(out):
        os.remove(out)
    con.execute("VACUUM INTO ?", (out,))
    after = os.path.getsize(out)
    n = con.execute("SELECT count(*) FROM p_contact_message").fetchone()[0]
    e = sqlite3.connect(out)
    n2 = e.execute("SELECT count(*) FROM p_contact_message").fetchone()[0]
    print("\n6. VACUUM INTO with 200 plugin rows (no filter can be applied: the file is the unit)")
    print(f"   live file {before} B -> snapshot {after} B ; rows live={n} snapshot={n2}")
    print(f"   snapshot unclassified tables           : {sorted(classify(e, proj)[2])}")
    e.close()

    # ---- the u_* registry cannot represent a plugin table -----------------------
    print("\n7. cms_table_registry declares u_* only (CHECK table_name GLOB 'u_*')")
    for name in ("u_product", "p_contact_message"):
        try:
            con.execute("INSERT INTO cms_table_registry(table_name,column_count) VALUES(?,1)", (name,))
            print(f"   {name:22s} accepted")
        except sqlite3.Error as e:
            print(f"   {name:22s} rejected ({str(e).split(':')[0]})")

    # ---- does the asset delete guard cover a plugin table? ----------------------
    print("\n8. a plugin table with an ASSET column, and the delete guard that does not exist yet")
    con.executescript('''
        CREATE TABLE p_contact_attachment (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id INTEGER NOT NULL REFERENCES p_contact_message(id) ON DELETE CASCADE,
          asset_key TEXT NOT NULL REFERENCES cms_asset(key) ON UPDATE RESTRICT ON DELETE RESTRICT
        );''')
    con.execute("INSERT INTO cms_asset(key,filename,mime,bytes,sha256,kind,width,height)"
                " VALUES('quote-pdf','q.pdf','application/pdf',10,?,'document',NULL,NULL)", ("c" * 64,))
    con.execute("INSERT INTO p_contact_attachment(message_id,asset_key) VALUES(1,'quote-pdf')")
    con.execute("PRAGMA foreign_keys = OFF")
    con.execute("DELETE FROM cms_asset WHERE key='quote-pdf'")
    dangling = con.execute("SELECT count(*) FROM p_contact_attachment WHERE asset_key='quote-pdf'").fetchone()[0]
    print(f"   fk=OFF, no plugin guard: asset deleted, rows still pointing at it = {dangling}")
    con.execute('''CREATE TRIGGER trg_asset_guard_p_contact_attachment BEFORE DELETE ON cms_asset
                   WHEN EXISTS (SELECT 1 FROM p_contact_attachment WHERE asset_key = OLD.key)
                   BEGIN SELECT RAISE(ABORT, 'DM_E_ASSET_IN_USE'); END''')
    con.execute("INSERT INTO cms_asset(key,filename,mime,bytes,sha256,kind,width,height)"
                " VALUES('quote-pdf','q.pdf','application/pdf',10,?,'document',NULL,NULL)", ("c" * 64,))
    try:
        con.execute("DELETE FROM cms_asset WHERE key='quote-pdf'")
        print("   with a generated guard: DELETE accepted (guard did nothing)")
    except sqlite3.Error as e:
        print(f"   with a generated guard: DELETE refused ({e})")
    con.execute("PRAGMA foreign_keys = ON")
    trig = [r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger'")]
    print(f"   triggers in sqlite_master: {trig}")

    # ---- what a 'class' per table would have to be declared on ------------------
    print("\n9. a manifest-declared class, validated against the same closed set")
    declared = {"p_contact_message": "rows", "p_contact_setting": "rows"}
    print(f"   plugin declares                        : {declared}")
    print(f"   covers its own tables                  : {set(declared) == {t for t in ddl2 if t.startswith('p_')}}")
    print(f"   every value in the projection's closed set: "
          f"{set(declared.values()) <= {'rows','empty','filtered'}}")
    con.close()


if __name__ == "__main__":
    main()
