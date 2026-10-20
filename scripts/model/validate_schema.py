#!/usr/bin/env python3
"""Validate the generated DDL against a real SQLite engine and report what it proves.

Every assertion here is a negative test against the v3 schema: a statement the design says must
fail, run against a real file. The schema is regenerated first by the Makefile, so a spec edit that
breaks an invariant fails here rather than in a Builder's head.

    python3 scripts/model/validate_schema.py     exit 0 = every invariant holds
"""
import json, os, re, sqlite3, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.environ.get("SKW_VALIDATE_DIR",
                     "/Users/cyberdeth/.hermes/profiles/ceo/cache/scratch/dmprobe/validate")
os.makedirs(OUT, exist_ok=True)

fails = []


def build(name, sqlfile, extra=()):
    db = os.path.join(OUT, name)
    for s in ("", "-wal", "-shm"):
        if os.path.exists(db + s):
            os.remove(db + s)
    con = sqlite3.connect(db, isolation_level=None)
    con.execute("PRAGMA foreign_keys = ON")
    con.executescript(open(os.path.join(ROOT, sqlfile)).read())
    for x in extra:
        con.executescript(open(os.path.join(ROOT, x)).read())
    return con, db


def must_fail(con, label, sql, params=()):
    """A statement the design says cannot succeed. Any sqlite3 error is a pass."""
    try:
        con.execute(sql, params)
    except sqlite3.Error as e:
        print(f"   ok {label}: rejected ({str(e).split(':')[0]})")
        return str(e)
    fails.append(f"{label}: ACCEPTED but the design says it must be rejected")
    print(f"   !! {label}: ACCEPTED (should have been rejected)")
    return None


def must_pass(con, label, sql, params=()):
    try:
        con.execute(sql, params)
    except sqlite3.Error as e:
        fails.append(f"{label}: rejected ({e})")
        print(f"   !! {label}: rejected ({e})")
        return None
    print(f"   ok {label}: accepted")
    return True


ARGON = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2E$" + "A" * 43

# ------------------------------------------------------------------ both planes
for name, f in (("control.db", "schema/control.sql"), ("site.db", "schema/site.sql")):
    try:
        con, db = build(name, f)
    except sqlite3.Error as e:
        fails.append(f"{name}: {e}")
        print(f"!! {name}: {e}")
        continue
    tables = [r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    idx = [r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    trg = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")]
    nfk = sum(con.execute(f"SELECT count(*) FROM pragma_foreign_key_list('{t}')").fetchone()[0]
              for t in tables)
    print(f"{name}: v{con.execute('PRAGMA user_version').fetchone()[0]}, {len(tables)} tables, "
          f"{len(idx)} explicit indexes, {nfk} FK clauses, {len(trg)} triggers, "
          f"integrity={con.execute('PRAGMA integrity_check').fetchone()[0]}, "
          f"fk_check={len(con.execute('PRAGMA foreign_key_check').fetchall())} violations, "
          f"journal={con.execute('PRAGMA journal_mode').fetchone()[0]}, "
          f"app_id={hex(con.execute('PRAGMA application_id').fetchone()[0])}")
    if name == "site.db":
        reg = {r[0] for r in con.execute("SELECT name FROM cms_trigger_registry")}
        live = set(trg)
        if reg == live:
            print(f"   ok every trigger registered: {len(live)} triggers == {len(reg)} registry rows")
        else:
            fails.append(f"unregistered triggers {live - reg} / stale {reg - live}")
            print(f"   !! registry mismatch: unregistered={live - reg} stale={reg - live}")
    con.close()

# ------------------------------------------------------------------ site.db negatives
con, db = build("site_neg.db", "schema/site.sql")
print("\nasset identity and the generated path (C-17)")
must_pass(con, "image asset", "INSERT INTO cms_asset(key,filename,mime,bytes,sha256,kind,width,height)"
          " VALUES('banner-home','b.png','image/png',10,?,'image',100,50)", ("a" * 64,))
must_fail(con, "asset key with ../", "INSERT INTO cms_asset(key,filename,mime,bytes,sha256,kind)"
          " VALUES('../etc/passwd','x','image/png',1,?,'image')", ("a" * 64,))
must_fail(con, "asset key uppercase", "INSERT INTO cms_asset(key,filename,mime,bytes,sha256,kind)"
          " VALUES('Banner','x','image/png',1,?,'image')", ("a" * 64,))
must_fail(con, "image without dimensions", "INSERT INTO cms_asset(key,filename,mime,bytes,sha256,kind)"
          " VALUES('no-dim','x','image/png',1,?,'image')", ("a" * 64,))
must_fail(con, "INSERT naming the generated storage_path",
          "INSERT INTO cms_asset(key,filename,mime,bytes,sha256,kind,storage_path)"
          " VALUES('evil','e.txt','text/plain',1,?,'document','../../etc/passwd')", ("9" * 64,))
must_fail(con, "UPDATE naming the generated storage_path",
          "UPDATE cms_asset SET storage_path='/etc/passwd' WHERE key='banner-home'")
must_fail(con, "sha256 rewrite (address is immutable)",
          "UPDATE cms_asset SET sha256=? WHERE key='banner-home'", ("1" * 64,))
sp = con.execute("SELECT storage_path FROM cms_asset WHERE key='banner-home'").fetchone()[0]
ok = re.match(r"^content/media/[0-9a-f]{2}/[0-9a-f]{64}\.png$", sp) is not None
print(f"   {'ok' if ok else '!!'} generated path is derived from (sha256,mime): {sp}")
if not ok:
    fails.append(f"derived path malformed: {sp}")

print("\naccess codes: selector + argon2, no pepper (C-6)")
must_fail(con, "code with neither asset nor bundle",
          "INSERT INTO cms_download_code(code_selector,code_hash) VALUES('AAAA',?)", (ARGON,))
con.execute("INSERT INTO cms_asset_bundle(key,title) VALUES('bk','B')")
must_fail(con, "code with both asset and bundle",
          "INSERT INTO cms_download_code(code_selector,code_hash,asset_id,bundle_id)"
          " VALUES('AAAB',?,1,1)", (ARGON,))
must_fail(con, "selector of length 5",
          "INSERT INTO cms_download_code(code_selector,code_hash,asset_id)"
          " VALUES('AAAAA',?,1)", (ARGON,))
must_fail(con, "selector of length 3",
          "INSERT INTO cms_download_code(code_selector,code_hash,asset_id)"
          " VALUES('AAA',?,1)", (ARGON,))
must_fail(con, "plaintext code stored as code_hash",
          "INSERT INTO cms_download_code(code_selector,code_hash,asset_id)"
          " VALUES('AAAC','A7K2M9QX4T3B',1)")
must_pass(con, "4-char selector + argon2id PHC",
          "INSERT INTO cms_download_code(code_selector,code_hash,asset_id,max_uses,uses)"
          " VALUES('AAAD',?,1,5,4)", (ARGON,))
must_fail(con, "duplicate selector",
          "INSERT INTO cms_download_code(code_selector,code_hash,asset_id)"
          " VALUES('AAAD',?,1)", (ARGON,))
must_fail(con, "selector rewrite is immutable",
          "UPDATE cms_download_code SET code_selector='ZZZZ' WHERE code_selector='AAAD'")
must_fail(con, "code_hash rewrite is immutable",
          "UPDATE cms_download_code SET code_hash=? WHERE code_selector='AAAD'", (ARGON + "B",))
must_pass(con, "uses bump is allowed", "UPDATE cms_download_code SET uses=uses+1 WHERE code_selector='AAAD'")
must_pass(con, "lowering max_uses below uses (revoke-lite)",
          "UPDATE cms_download_code SET max_uses=2 WHERE code_selector='AAAD'")
cols = {r[1] for r in con.execute("PRAGMA table_info(cms_download_code)")}
bad = {c for c in cols if "pepper" in c.lower() or "lookup" in c.lower()}
print(f"   {'ok' if not bad else '!!'} no pepper or lookup column: {sorted(cols)}")
if bad:
    fails.append(f"recoverable-secret column present: {bad}")

print("\nredemption accounting: jti is the unit (C-7, C-14)")
must_fail(con, "event without bytes_declared",
          "INSERT INTO cms_download_event(jti,kind,outcome) VALUES('J1','first','ok')")
must_fail(con, "event with a made-up kind",
          "INSERT INTO cms_download_event(jti,kind,outcome,bytes_declared) VALUES('J1','firstbyte','ok',1)")
for _ in range(3):
    must_pass(con, "NULL-jti denial", "INSERT INTO cms_download_event(jti,kind,outcome,bytes_declared)"
              " VALUES(NULL,'denied','denied_token',0)")
must_pass(con, "first event", "INSERT INTO cms_download_event(jti,kind,outcome,bytes_declared)"
          " VALUES('J1','first','ok',100)")
must_pass(con, "range continuation under the same jti",
          "INSERT INTO cms_download_event(jti,kind,outcome,bytes_declared) VALUES('J1','range','ok',50)")
must_fail(con, "second first event for one jti",
          "INSERT INTO cms_download_event(jti,kind,outcome,bytes_declared) VALUES('J1','first','ok',100)")
must_pass(con, "bytes_sent may be NULL (v1 never observes it)",
          "INSERT INTO cms_download_event(jti,kind,outcome,bytes_declared,bytes_sent)"
          " VALUES('J2','first','ok',1,NULL)")

print("\npage path, template slug, body ban (O-15, C-23, C-12)")
must_pass(con, "root path '/'", "INSERT INTO cms_page(path,slug,title) VALUES('/','home','Home')")
for bad_path in ("/a/", "/a/../b", "/x//y"):
    must_fail(con, f"page path {bad_path}",
              "INSERT INTO cms_page(path,slug,title) VALUES(?,?,'T')", (bad_path, "z"))
must_fail(con, "template 'Landing' (uppercase)",
          "INSERT INTO cms_page(path,slug,title,template) VALUES('/x','x','X','Landing')")
must_pass(con, "template 'docs-v2' (a slug, not an enum)",
          "INSERT INTO cms_page(path,slug,title,template) VALUES('/docs','docs','D','docs-v2')")
must_fail(con, "body with <script",
          "INSERT INTO cms_page(path,slug,title,body_html) VALUES('/s','s','S','<p>x</p><script>a</script>')")
must_fail(con, "body with <SCRIPT (LIKE folds case)",
          "INSERT INTO cms_page(path,slug,title,body_html) VALUES('/s2','s2','S','<SCRIPT>x</SCRIPT>')")
must_fail(con, "body with an HTML comment",
          "INSERT INTO cms_page(path,slug,title,body_html) VALUES('/s3','s3','S','<!-- x -->')")
must_fail(con, "body with javascript: URL",
          "INSERT INTO cms_page(path,slug,title,body_html) VALUES('/s4','s4','S','<a href=\"javascript:x\">y</a>')")
must_pass(con, "body with a list component",
          "INSERT INTO cms_page(path,slug,title,body_html) VALUES('/l','l','L',"
          "'<div data-gjs-type=\"list\" data-source=\"posts\" data-limit=\"3\">"
          "<article data-repeat data-bind-title=\"title\" data-bind-href-slug=\"slug\"></article>"
          "<p data-empty>No posts yet.</p></div>')")

print("\nredirect targets stay internal (O-16)")
must_pass(con, "redirect to '/'", "INSERT INTO cms_redirect(from_path,to_path) VALUES('/old-home','/')")
for bad in ("//evil.example", "/a/../b", "/x/"):
    must_fail(con, f"to_path {bad}", "INSERT INTO cms_redirect(from_path,to_path) VALUES('/go',?)", (bad,))

print("\ndata sources: no function kind, aggregates are grammar (C-18)")
must_fail(con, "datasource kind=function",
          "INSERT INTO cms_datasource(key,kind,spec_json) VALUES('x','function','{}')")
must_fail(con, "datasource spec is not JSON",
          "INSERT INTO cms_datasource(key,kind,spec_json) VALUES('y','query','not json')")
must_fail(con, "aggregate_json is an array, not an object",
          "INSERT INTO cms_datasource(key,kind,spec_json,aggregate_json) VALUES('z','query','{}','[]')")
must_pass(con, "aggregate count over an indexed column",
          "INSERT INTO cms_datasource(key,kind,spec_json,aggregate_json,group_by_json,cost_ms_max)"
          " VALUES('posts-count','query','{}','{\"fn\":\"count\",\"column\":\"id\"}','[]',1.4)")

print("\nruntime table classes: u_* and p_* only (C-13)")
must_pass(con, "u_* registered as class user",
          "INSERT INTO cms_table_registry(table_name,table_class,column_count,columns_json)"
          " VALUES('u_post','user',3,'[]')")
must_pass(con, "p_* registered as class plugin",
          "INSERT INTO cms_table_registry(table_name,table_class,plugin_id,column_count,columns_json)"
          " VALUES('p_contact_message','plugin','contact',4,'[]')")
must_fail(con, "u_* claiming class plugin",
          "INSERT INTO cms_table_registry(table_name,table_class,plugin_id,column_count,columns_json)"
          " VALUES('u_x','plugin','contact',1,'[]')")
must_fail(con, "p_* with no plugin id",
          "INSERT INTO cms_table_registry(table_name,table_class,column_count,columns_json)"
          " VALUES('p_y','user',1,'[]')")
must_fail(con, "bare 'p_' table name (the GLOB 'p_*' off-by-one)",
          "INSERT INTO cms_table_registry(table_name,table_class,plugin_id,column_count,columns_json)"
          " VALUES('p_','plugin','ab',1,'[]')")
must_fail(con, "a cms_* table in the runtime registry",
          "INSERT INTO cms_table_registry(table_name,table_class,column_count,columns_json)"
          " VALUES('cms_page','user',1,'[]')")

print("\ncomponent registry is the loop contract (C-4)")
COMP = json.load(open(os.path.join(ROOT, "schema/component-registry.json")))
for c in COMP["components"]:
    must_pass(con, f"shipped component {c['name']!r}",
              "INSERT INTO cms_component_registry(name,kind,renderer,repeat_child,bindings_json,"
              "props_schema_json,limit_max,version) VALUES(?,?,?,?,?,?,?,?)",
              (c["name"], c["kind"], c["renderer"], c.get("repeat_child"),
               json.dumps(c.get("bindings", [])), json.dumps(c.get("props", {})),
               c.get("limit_max"), c["version"]))
must_fail(con, "list without a repeat child",
          "INSERT INTO cms_component_registry(name,kind,renderer,limit_max,version)"
          " VALUES('list2','list','components/list2.ts',10,'1.0.0')")
must_fail(con, "list with a different child selector",
          "INSERT INTO cms_component_registry(name,kind,renderer,repeat_child,limit_max,version)"
          " VALUES('list3','list','components/list3.ts','[data-row]',10,'1.0.0')")
must_fail(con, "non-list with a repeat child",
          "INSERT INTO cms_component_registry(name,kind,renderer,repeat_child,version)"
          " VALUES('prose2','block','components/prose2.ts','[data-repeat]','1.0.0')")
must_fail(con, "limit_max out of range",
          "INSERT INTO cms_component_registry(name,kind,renderer,repeat_child,limit_max,version)"
          " VALUES('list4','list','components/list4.ts','[data-repeat]',500,'1.0.0')")

print("\nplugin trust and settings (C-9, O-44)")
must_fail(con, "enabled plugin with no test report (O-37)",
          "INSERT INTO cms_plugin_installed(plugin_id,version,manifest_json,root_hash,publisher,"
          "signature_state,enabled) VALUES('contact','1.0.0','{}',?,'acme-labs','imported',1)", ("c" * 64,))
must_pass(con, "installed plugin with a test report",
          "INSERT INTO cms_plugin_installed(plugin_id,version,manifest_json,root_hash,publisher,"
          "signature_state,enabled,test_report_sha) VALUES('contact','1.0.0','{}',?,'acme-labs','imported',1,?)",
          ("c" * 64, "d" * 64))
must_fail(con, "secret setting not flagged secret",
          "INSERT INTO cms_plugin_setting(plugin_id,key,value_json,type,secret)"
          " VALUES('contact','smtp','\"x\"','secret',0)")
must_pass(con, "secret setting",
          "INSERT INTO cms_plugin_setting(plugin_id,key,value_json,type,secret)"
          " VALUES('contact','smtp','\"x\"','secret',1)")
must_fail(con, "setting for an uninstalled plugin",
          "INSERT INTO cms_plugin_setting(plugin_id,key,value_json,type,secret)"
          " VALUES('ghost','k','\"x\"','string',0)")

print("\naudit is append-only (C-21)")
must_pass(con, "audit insert", "INSERT INTO cms_audit(actor_label,action) VALUES('op@us','page.save')")
must_fail(con, "audit update", "UPDATE cms_audit SET action='page.delete' WHERE id=1")
must_fail(con, "audit delete", "DELETE FROM cms_audit WHERE id=1")

print("\nasset delete guard (O-04)")
con.execute("INSERT INTO cms_asset_link(asset_id,owner_kind,owner_id) VALUES(1,'page',1)")
con.execute("PRAGMA foreign_keys=OFF")
must_fail(con, "delete a linked asset with fk=OFF", "DELETE FROM cms_asset WHERE id=1")
con.execute("PRAGMA foreign_keys=ON")
con.execute("DELETE FROM cms_asset_link WHERE asset_id=1")
con.execute("DELETE FROM cms_download_code WHERE asset_id=1")
must_pass(con, "delete after unlinking", "DELETE FROM cms_asset WHERE id=1")
con.close()

# ------------------------------------------------------------------ error-code registry
print("\nerror codes are one taxonomy (C-19)")
CODES = json.load(open(os.path.join(ROOT, "schema/error-codes.json")))
members = {f"SKW_E_{a}_{n}" for a, names in CODES["areas"].items() for n in names}
rx = re.compile(CODES["pattern"])
bad = [c for c in members if not rx.match(c)]
if bad:
    fails.append(f"codes outside the frozen pattern: {bad}")
print(f"   {'ok' if not bad else '!!'} {len(members)} codes, all match {CODES['pattern']}")
raised = set()
for f in ("schema/site.sql", "schema/r3-amendments.sql", "schema/r2-amendments.sql"):
    text = open(os.path.join(ROOT, f)).read()
    code_only = "\n".join(l.split("--")[0] for l in text.splitlines())
    raised |= set(re.findall(r"SKW_E_[A-Z0-9_]+", code_only))
stale = {c for c in raised if c not in members}
if stale:
    fails.append(f"trigger raises an unregistered code: {stale}")
print(f"   {'ok' if not stale else '!!'} every SKW_E_ code raised by the DDL is registered "
      f"({len(raised)} distinct: {sorted(raised)})")
http = {c for c in CODES["http"] if c not in members}
if http:
    fails.append(f"http map names unregistered codes: {http}")

# ------------------------------------------------------------------ size on disk
for f in ("control.db", "site.db"):
    p = os.path.join(OUT, f)
    con = sqlite3.connect(p)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("VACUUM")
    con.close()
    print(f"{f} empty size after VACUUM: {os.path.getsize(p)} bytes")

print("\nFAILURES:", fails or "none")
sys.exit(1 if fails else 0)
