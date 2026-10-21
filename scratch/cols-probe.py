
import sqlite3, os, tempfile
W = "/Volumes/Backup/Development/skunkworks"
def build(schema):
    db = tempfile.mktemp(suffix=".db"); c = sqlite3.connect(db)
    c.executescript(open(os.path.join(W, schema)).read()); c.commit(); return c
site, ctl = build("schema/site.sql"), build("schema/control.sql")
def cols(c, t): return [r[1] for r in c.execute("PRAGMA table_info(%s)" % t)]
for t in ["cms_audit","cms_download_code","cms_download_event","cms_page","cms_asset","cms_plugin_installed","cms_watermark_render"]:
    print(t, "->", ", ".join(cols(site, t)))
for t in ["session","domain","user_account","tenant","audit_log"]:
    print(t, "->", ", ".join(cols(ctl, t)))
