
import sqlite3, os, tempfile
W = "/Volumes/Backup/Development/skunkworks"
def build(schema):
    db = tempfile.mktemp(suffix=".db"); c = sqlite3.connect(db)
    c.executescript(open(os.path.join(W, schema)).read()); c.commit(); return c
site, ctl = build("schema/site.sql"), build("schema/control.sql")
HOT = [
 # the queries the product actually runs, named by call site
 ("page by path",                site, "SELECT * FROM cms_page WHERE path = ?"),
 ("page published list",         site, "SELECT * FROM cms_page WHERE status = ?"),
 ("revision history",            site, "SELECT * FROM cms_page_revision WHERE page_id = ? ORDER BY ts DESC"),
 ("asset by key",                site, "SELECT * FROM cms_asset WHERE key = ?"),
 ("asset by sha (dedupe)",       site, "SELECT * FROM cms_asset WHERE sha256 = ?"),
 ("asset by kind (library)",     site, "SELECT * FROM cms_asset WHERE kind = ?"),
 ("asset alias lookup",          site, "SELECT * FROM cms_asset_alias WHERE old_key = ?"),
 ("variant by asset",            site, "SELECT * FROM cms_asset_variant WHERE asset_id = ?"),
 ("links by asset",              site, "SELECT * FROM cms_asset_link WHERE asset_id = ?"),
 ("links by owner",              site, "SELECT * FROM cms_asset_link WHERE owner_kind = ?"),
 ("download code by selector",   site, "SELECT * FROM cms_download_code WHERE code_selector = ?"),
 ("codes by asset",              site, "SELECT * FROM cms_download_code WHERE asset_id = ?"),
 ("events by code",              site, "SELECT * FROM cms_download_event WHERE code_id = ?"),
 ("one-use witness (jti)",       site, "SELECT * FROM cms_download_event WHERE jti = ? AND kind = 'first'"),
 ("expired renders",             site, "SELECT * FROM cms_watermark_render WHERE expires_at < ?"),
 ("audit newest 50",             site, "SELECT * FROM cms_audit ORDER BY ts DESC LIMIT 50"),
 ("audit by action",             site, "SELECT * FROM cms_audit WHERE action = ?"),
 ("enabled plugins",             site, "SELECT * FROM cms_plugin_installed WHERE enabled = 1"),
 ("plugin row by id",            site, "SELECT * FROM cms_plugin_installed WHERE plugin_id = ?"),
 ("revoked plugin",              site, "SELECT * FROM cms_plugin_revoked WHERE plugin_id = ?"),
 ("nav by position",             site, "SELECT * FROM cms_nav ORDER BY position"),
 ("redirect by from_path",       site, "SELECT * FROM cms_redirect WHERE from_path = ?"),
 ("form by key",                 site, "SELECT * FROM cms_form WHERE key = ?"),
 ("submissions by form",         site, "SELECT * FROM cms_form_submission WHERE form_id = ? ORDER BY ts DESC"),
 ("datasource public",           site, "SELECT * FROM cms_datasource WHERE is_public = 1"),
 ("session by id",               ctl,  "SELECT * FROM session WHERE id = ?"),
 ("sessions by user",            ctl,  "SELECT * FROM session WHERE user_id = ?"),
 ("expired sessions",            ctl,  "SELECT * FROM session WHERE expires_at < ?"),
 ("domain by host",              ctl,  "SELECT * FROM domain WHERE host = ?"),
 ("domains by tenant",           ctl,  "SELECT * FROM domain WHERE tenant_id = ?"),
 ("user by email",               ctl,  "SELECT * FROM user_account WHERE email = ?"),
 ("tenant by key",               ctl,  "SELECT * FROM tenant WHERE key = ?"),
 ("tenants by status",           ctl,  "SELECT * FROM tenant WHERE status = ?"),
 ("audit_log by tenant",         ctl,  "SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY ts DESC"),
 ("audit_log by action",         ctl,  "SELECT * FROM audit_log WHERE action = ?"),
]
bad = []
print("%-26s %s" % ("query", "plan"))
for name, db, q in HOT:
    try:
        plan = " | ".join(r[-1] for r in db.execute("EXPLAIN QUERY PLAN " + q, (0,) * q.count("?")).fetchall())
    except Exception as e:
        plan = "ERROR " + str(e)[:70]
    if "SCAN" in plan: bad.append((name, plan))
    print("%-26s %s" % (name, plan[:105]))
print("")
print("TOTAL: %d queries, SCAN on %d" % (len(HOT), len(bad)))
for n, p in bad:
    print("  SCAN -> %s :: %s" % (n, p[:120]))
