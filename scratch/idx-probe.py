
import sqlite3, os, tempfile
W = "/Volumes/Backup/Development/skunkworks"
TBL = "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
IDX = "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY 1"

def build(schema):
    db = tempfile.mktemp(suffix=".db")
    c = sqlite3.connect(db)
    c.executescript(open(os.path.join(W, schema)).read())
    c.commit()
    return c

site = build("schema/site.sql")
ctl = build("schema/control.sql")
st, si = [r[0] for r in site.execute(TBL)], [r[0] for r in site.execute(IDX)]
ct, ci = [r[0] for r in ctl.execute(TBL)], [r[0] for r in ctl.execute(IDX)]
print("site.db:    %d tables, %d indexes" % (len(st), len(si)))
print("control.db: %d tables, %d indexes" % (len(ct), len(ci)))
print("")
print("site indexes: " + ", ".join(si))
print("")
print("control indexes: " + ", ".join(ci))
print("")

HOT = [
 ("page by path", site, "SELECT * FROM cms_page WHERE path = ?"),
 ("session by token", site, "SELECT * FROM cms_session WHERE token_hash = ?"),
 ("asset by key", site, "SELECT * FROM cms_asset WHERE key = ?"),
 ("code by selector", site, "SELECT * FROM cms_download_code WHERE selector = ?"),
 ("enabled plugins", site, "SELECT * FROM cms_plugin_installed WHERE enabled = 1"),
 ("plugin settings", site, "SELECT * FROM cms_plugin_setting WHERE plugin_id = ?"),
 ("audit newest", site, "SELECT * FROM cms_audit ORDER BY at DESC LIMIT 50"),
 ("events by code", site, "SELECT * FROM cms_download_event WHERE code_id = ?"),
 ("links by asset", site, "SELECT * FROM cms_asset_link WHERE asset_id = ?"),
 ("variants by asset", site, "SELECT * FROM cms_asset_variant WHERE asset_id = ?"),
 ("expired renders", site, "SELECT * FROM cms_watermark_render WHERE expires_at < ?"),
 ("tenant by key", ctl, "SELECT * FROM tenant WHERE key = ?"),
 ("domain by host", ctl, "SELECT * FROM tenant_domain WHERE host = ?"),
 ("admin by email", ctl, "SELECT * FROM admin_user WHERE email = ?"),
]
bad = []
print("%-20s %s" % ("hot query", "plan"))
for name, db, q in HOT:
    try:
        plan = " | ".join(r[-1] for r in db.execute("EXPLAIN QUERY PLAN " + q, (0,) * q.count("?")).fetchall())
    except Exception as e:
        plan = "ERROR " + str(e)[:60]
    if "SCAN" in plan:
        bad.append((name, plan))
    print("%-20s %s" % (name, plan[:100]))
print("")
print("SCANS ON HOT PATHS: %d" % len(bad))
for n, p in bad:
    print("  - %s :: %s" % (n, p[:120]))
