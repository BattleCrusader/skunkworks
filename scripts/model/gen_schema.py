#!/usr/bin/env python3
"""Skunkworks data model — single source of truth.

Emits, from one spec:
  schema/control.sql   DDL for control.db
  schema/site.sql      DDL for a tenant site.db
  docs/debate/diagrams/r1-data-model.puml
and renders docs/debate/diagrams/r1-data-model.png via plantuml.

Run: python3 scripts/model/gen_schema.py
Every table/column that appears in one artefact appears in all three by construction.
"""
import os, subprocess, sys, textwrap

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

# ---------------------------------------------------------------- spec
# (name, sqltype, constraints)
CONTROL = {
"tenant": dict(note="One row per hosted site. The only place a site.db path may be derived from.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("key","TEXT","NOT NULL UNIQUE COLLATE NOCASE CHECK(key GLOB '[a-z0-9]*' AND key NOT GLOB '*[^a-z0-9-]*' AND length(key) BETWEEN 2 AND 40)"),
 ("mode","TEXT","NOT NULL CHECK(mode IN ('production','demo','internal'))"),
 ("status","TEXT","NOT NULL DEFAULT 'provisioning' CHECK(status IN ('provisioning','active','suspended','archived'))"),
 ("display_name","TEXT","NOT NULL CHECK(length(display_name) BETWEEN 1 AND 120)"),
 ("db_version","INTEGER","NOT NULL DEFAULT 1 CHECK(db_version >= 1)"),
 ("storage_quota_bytes","INTEGER","NOT NULL DEFAULT 1073741824 CHECK(storage_quota_bytes > 0)"),
 ("request_budget_per_min","INTEGER","NOT NULL DEFAULT 600 CHECK(request_budget_per_min > 0)"),
 ("demo_expires_at","TEXT",None),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
 ("archived_at","TEXT",None),
], checks=["CHECK(mode <> 'demo' OR demo_expires_at IS NOT NULL)"], indexes=[
 ("ix_tenant_status","status",False),
]),
"domain": dict(note="Host -> tenant. UNIQUE(host) is the routing authority; the app must never parse a Host header twice.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("host","TEXT","NOT NULL UNIQUE COLLATE NOCASE CHECK(host = lower(host) AND host NOT GLOB '*[^a-z0-9.-]*' AND host LIKE '%.%')"),
 ("tenant_id","INTEGER","NOT NULL REFERENCES tenant(id) ON DELETE CASCADE ON UPDATE CASCADE"),
 ("kind","TEXT","NOT NULL DEFAULT 'primary' CHECK(kind IN ('primary','alias','demo-path'))"),
 ("is_primary","INTEGER","NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1))"),
 ("cert_state","TEXT","NOT NULL DEFAULT 'none' CHECK(cert_state IN ('none','requested','issued','failed'))"),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], partials=[
 ("ux_domain_primary","tenant_id","is_primary = 1","one primary host per tenant; partial unique is legal here because no FK points at domain"),
]),
"user_account": dict(note="tenant_id IS NULL = fleet operator. Never exported.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("tenant_id","INTEGER","REFERENCES tenant(id) ON DELETE CASCADE"),
 ("email","TEXT","NOT NULL COLLATE NOCASE CHECK(email LIKE '%_@_%.__%')"),
 ("password_hash","TEXT","NOT NULL"),
 ("role","TEXT","NOT NULL DEFAULT 'editor' CHECK(role IN ('fleet_admin','owner','editor','viewer'))"),
 ("totp_secret","TEXT",None),
 ("reset_token_hash","TEXT",None),
 ("reset_expires_at","TEXT",None),
 ("failed_logins","INTEGER","NOT NULL DEFAULT 0 CHECK(failed_logins >= 0)"),
 ("locked_until","TEXT",None),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
 ("last_login_at","TEXT",None),
], checks=["CHECK((tenant_id IS NULL) = (role = 'fleet_admin'))"], uniques=[
 ("ux_user_tenant_email","tenant_id, email"),
], partials=[
 ("ux_user_email_global","email","tenant_id IS NULL","fleet operators have no tenant, so UNIQUE(tenant_id,email) would not constrain them"),
]),
"session": dict(note="Rotated on privilege change. id is a 32-byte random hex, not a JWT.", cols=[
 ("id","TEXT","PRIMARY KEY"),
 ("user_id","INTEGER","NOT NULL REFERENCES user_account(id) ON DELETE CASCADE"),
 ("tenant_id","INTEGER","REFERENCES tenant(id) ON DELETE CASCADE"),
 ("csrf_secret","TEXT","NOT NULL"),
 ("ip_hash","TEXT","NOT NULL"),
 ("ua_hash","TEXT","NOT NULL"),
 ("created_at","TEXT","NOT NULL"),
 ("expires_at","TEXT","NOT NULL"),
 ("rotated_from","TEXT",None),
 ("revoked_at","TEXT",None),
], checks=[], indexes=[("ix_session_user","user_id",False),("ix_session_expiry","expires_at",False)]),
"audit_log": dict(note="Control-plane actions only. No FK to user_account: audit outlives actors.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("tenant_id","INTEGER",None),
 ("actor_user_id","INTEGER",None),
 ("actor_label","TEXT","NOT NULL"),
 ("action","TEXT","NOT NULL"),
 ("target_kind","TEXT",None),
 ("target_id","TEXT",None),
 ("before_json","TEXT",None),
 ("after_json","TEXT",None),
 ("ip_hash","TEXT",None),
 ("ts","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], indexes=[("ix_audit_tenant_ts","tenant_id, ts",False),("ix_audit_action_ts","action, ts",False)]),
"deploy_token": dict(note="256-bit random token, SHA-256 hash suffices; argon2id would cost 121 ms for zero added safety.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("tenant_id","INTEGER","NOT NULL REFERENCES tenant(id) ON DELETE CASCADE"),
 ("token_hash","TEXT","NOT NULL UNIQUE"),
 ("label","TEXT","NOT NULL"),
 ("expires_at","TEXT","NOT NULL"),
 ("revoked_at","TEXT",None),
 ("last_used_at","TEXT",None),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], indexes=[]),
"control_migration": dict(note="Drizzle journal, advisory. tenant.db_version is authoritative for site.db.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("tag","TEXT","NOT NULL UNIQUE"),
 ("checksum","TEXT","NOT NULL"),
 ("applied_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], indexes=[]),
}

SITE = {
"cms_settings": dict(note="The only EAV-shaped table. Keys are registry-declared; unknown keys are rejected by the app.", cols=[
 ("key","TEXT","PRIMARY KEY CHECK(key GLOB '[a-z0-9._]*')"),
 ("value_json","TEXT","NOT NULL"),
 ("type","TEXT","NOT NULL CHECK(type IN ('int','bool','string','json','asset_key'))"),
 ("updated_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
 ("updated_by","INTEGER",None),
], checks=[], indexes=[]),
"cms_page": dict(note="One document per page: the GrapesJS model is the source of truth, not a block tree.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("path","TEXT","NOT NULL UNIQUE COLLATE NOCASE CHECK(path GLOB '/*' AND path NOT GLOB '*..*' AND path NOT GLOB '*/')"),
 ("slug","TEXT","NOT NULL CHECK(slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*')"),
 ("title","TEXT","NOT NULL CHECK(length(title) BETWEEN 1 AND 200)"),
 ("status","TEXT","NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','hidden'))"),
 ("template","TEXT","NOT NULL DEFAULT 'page' CHECK(template IN ('page','landing','post','index'))"),
 ("body_html","TEXT","NOT NULL DEFAULT ''"),
 ("css","TEXT","NOT NULL DEFAULT ''"),
 ("seo_json","TEXT",None),
 ("etag","TEXT","NOT NULL"),
 ("published_at","TEXT",None),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
 ("updated_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
 ("updated_by","INTEGER",None),
], checks=[], indexes=[("ix_page_status","status, published_at",False)]),
"cms_page_revision": dict(note="Append-only. Covers the designer who hand-edits HTML and breaks it.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("page_id","INTEGER","NOT NULL REFERENCES cms_page(id) ON DELETE CASCADE"),
 ("body_html","TEXT","NOT NULL"),
 ("css","TEXT","NOT NULL"),
 ("note","TEXT",None),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
 ("created_by","INTEGER",None),
], checks=[], indexes=[("ix_rev_page_ts","page_id, created_at",False)]),
"cms_nav": dict(note="Adjacency list. Position uniqueness uses ifnull() because SQLite treats NULLs as distinct in UNIQUE.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("location","TEXT","NOT NULL CHECK(location IN ('header','footer','sidebar'))"),
 ("parent_id","INTEGER","REFERENCES cms_nav(id) ON DELETE CASCADE"),
 ("label","TEXT","NOT NULL CHECK(length(label) BETWEEN 1 AND 80)"),
 ("href_kind","TEXT","NOT NULL DEFAULT 'page' CHECK(href_kind IN ('page','asset','url'))"),
 ("href_target","TEXT","NOT NULL"),
 ("position","INTEGER","NOT NULL DEFAULT 0 CHECK(position >= 0)"),
 ("visible","INTEGER","NOT NULL DEFAULT 1 CHECK(visible IN (0,1))"),
], checks=[], indexes=[("ux_nav_pos","location, ifnull(parent_id,0), position",True)]),
"cms_asset": dict(note="Identity is key. sha256 is the physical address and is never referenced by content.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("key","TEXT","NOT NULL UNIQUE COLLATE NOCASE CHECK(key = lower(key) AND length(key) BETWEEN 1 AND 96 AND key NOT GLOB '*[^a-z0-9/_.-]*' AND key NOT GLOB '/?*' AND key NOT GLOB '*/' AND key NOT GLOB '*..*' AND key NOT GLOB '.?*')"),
 ("filename","TEXT","NOT NULL"),
 ("mime","TEXT","NOT NULL"),
 ("bytes","INTEGER","NOT NULL CHECK(bytes > 0)"),
 ("sha256","TEXT","NOT NULL CHECK(length(sha256) = 64)"),
 ("kind","TEXT","NOT NULL CHECK(kind IN ('image','video','audio','document','archive'))"),
 ("access_class","TEXT","NOT NULL DEFAULT 'public' CHECK(access_class IN ('public','linked-private','gated'))"),
 ("storage_path","TEXT","NOT NULL"),
 ("width","INTEGER",None),
 ("height","INTEGER",None),
 ("alt_text","TEXT",None),
 ("caption","TEXT",None),
 ("watermark_asset_id","INTEGER","REFERENCES cms_asset(id) ON DELETE SET NULL"),
 ("watermark_spec_json","TEXT",None),
 ("frozen_at","TEXT",None),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
 ("created_by","INTEGER",None),
], checks=[
 "CHECK(kind <> 'image' OR (width IS NOT NULL AND height IS NOT NULL))",
 "CHECK(watermark_asset_id IS NULL OR watermark_asset_id <> id)",
 "CHECK(access_class <> 'public' OR watermark_asset_id IS NULL)",
], indexes=[("ix_asset_sha","sha256",False),("ix_asset_kind","kind, created_at",False)]),
"cms_asset_alias": dict(note="Old keys 301 to the live key. Never an FK target.", cols=[
 ("key","TEXT","PRIMARY KEY COLLATE NOCASE"),
 ("asset_id","INTEGER","NOT NULL REFERENCES cms_asset(id) ON DELETE CASCADE"),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], indexes=[]),
"cms_asset_variant": dict(note="Derived bytes. Not content: no page or user table may reference a variant.", cols=[
 ("id","INTEGER","PRIMARY KEY"),
 ("asset_id","INTEGER","NOT NULL REFERENCES cms_asset(id) ON DELETE CASCADE"),
 ("label","TEXT","NOT NULL CHECK(label IN ('thumb','md','lg','og'))"),
 ("format","TEXT","NOT NULL CHECK(format IN ('webp','avif','jpeg','png'))"),
 ("width","INTEGER","NOT NULL"),
 ("height","INTEGER","NOT NULL"),
 ("bytes","INTEGER","NOT NULL"),
 ("sha256","TEXT","NOT NULL"),
 ("storage_path","TEXT","NOT NULL"),
], checks=[], uniques=[("ux_variant","asset_id, label, format")]),
"cms_asset_link": dict(note="The usage graph. Deletion is refused while a link exists; orphan sweep is an explicit report.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("asset_id","INTEGER","NOT NULL REFERENCES cms_asset(id) ON DELETE RESTRICT ON UPDATE RESTRICT"),
 ("owner_kind","TEXT","NOT NULL CHECK(owner_kind IN ('page','settings','bundle','datasource'))"),
 ("owner_id","INTEGER","NOT NULL"),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], uniques=[("ux_link","asset_id, owner_kind, owner_id")], indexes=[
 ("ix_link_owner","owner_kind, owner_id",False)]),
"cms_asset_bundle": dict(note="Sellable set. A code points at an asset or a bundle, never both.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("key","TEXT","NOT NULL UNIQUE COLLATE NOCASE CHECK(key = lower(key) AND key NOT GLOB '*[^a-z0-9-]*')"),
 ("title","TEXT","NOT NULL"),
 ("note","TEXT",None),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], indexes=[]),
"cms_asset_bundle_item": dict(note="", cols=[
 ("bundle_id","INTEGER","NOT NULL REFERENCES cms_asset_bundle(id) ON DELETE CASCADE"),
 ("asset_id","INTEGER","NOT NULL REFERENCES cms_asset(id) ON DELETE RESTRICT"),
 ("position","INTEGER","NOT NULL DEFAULT 0"),
], checks=[], uniques=[("ux_bundle_item_pos","bundle_id, position")], pk="PRIMARY KEY(bundle_id, asset_id)"),
"cms_download_code": dict(note="code_lookup is an HMAC for O(1) seek; code_hash is argon2id and is NEVER queried by equality.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("code_lookup","TEXT","NOT NULL UNIQUE CHECK(length(code_lookup) = 64)"),
 ("code_hash","TEXT","NOT NULL"),
 ("asset_id","INTEGER","REFERENCES cms_asset(id) ON DELETE RESTRICT"),
 ("bundle_id","INTEGER","REFERENCES cms_asset_bundle(id) ON DELETE RESTRICT"),
 ("max_uses","INTEGER","CHECK(max_uses IS NULL OR max_uses BETWEEN 1 AND 100)"),
 ("uses","INTEGER","NOT NULL DEFAULT 0 CHECK(uses >= 0)"),
 ("expires_at","TEXT",None),
 ("issued_to_email","TEXT",None),
 ("order_ref","TEXT",None),
 ("revoked_at","TEXT",None),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
 ("last_used_at","TEXT",None),
], checks=[
 "CHECK((asset_id IS NULL) <> (bundle_id IS NULL))",
], indexes=[("ix_code_asset","asset_id, created_at",False)]),
"cms_download_event": dict(note="Append-only redemption log. Never updated.", cols=[
 ("id","INTEGER","PRIMARY KEY"),
 ("code_id","INTEGER","REFERENCES cms_download_code(id) ON DELETE SET NULL"),
 ("asset_id","INTEGER","REFERENCES cms_asset(id) ON DELETE SET NULL"),
 ("ip_hash","TEXT",None),
 ("ua_hash","TEXT",None),
 ("bytes_sent","INTEGER","NOT NULL DEFAULT 0 CHECK(bytes_sent >= 0)"),
 ("ranged","INTEGER","NOT NULL DEFAULT 0 CHECK(ranged IN (0,1))"),
 ("outcome","TEXT","NOT NULL CHECK(outcome IN ('ok','denied_quota','denied_expired','denied_revoked','denied_token','denied_watermark'))"),
 ("ts","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], indexes=[("ix_ev_code_ts","code_id, ts",False),("ix_ev_ts","ts",False)]),
"cms_watermark_render": dict(note="Render cache. Key includes the rendered spec because bytes differ per purchaser.", cols=[
 ("id","INTEGER","PRIMARY KEY"),
 ("asset_id","INTEGER","NOT NULL REFERENCES cms_asset(id) ON DELETE CASCADE"),
 ("spec_sha","TEXT","NOT NULL"),
 ("source_sha","TEXT","NOT NULL"),
 ("bytes","INTEGER","NOT NULL"),
 ("path","TEXT","NOT NULL"),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], uniques=[("ux_wm","spec_sha, source_sha")]),
"cms_form": dict(note="mode='forward' means the export never emits a dead form.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("key","TEXT","NOT NULL UNIQUE COLLATE NOCASE CHECK(key = lower(key) AND key NOT GLOB '*[^a-z0-9-]*')"),
 ("title","TEXT","NOT NULL"),
 ("fields_json","TEXT","NOT NULL"),
 ("mode","TEXT","NOT NULL DEFAULT 'store' CHECK(mode IN ('store','forward','disabled'))"),
 ("action_url","TEXT",None),
 ("notify_email","TEXT",None),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=["CHECK(mode <> 'forward' OR action_url IS NOT NULL)"], indexes=[]),
"cms_form_submission": dict(note="", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("form_id","INTEGER","NOT NULL REFERENCES cms_form(id) ON DELETE CASCADE"),
 ("payload_json","TEXT","NOT NULL"),
 ("ip_hash","TEXT",None),
 ("spam_score","REAL","NOT NULL DEFAULT 0"),
 ("state","TEXT","NOT NULL DEFAULT 'new' CHECK(state IN ('new','read','spam','forwarded'))"),
 ("ts","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], indexes=[("ix_sub_form_ts","form_id, ts",False)]),
"cms_datasource": dict(note="kind='function' removed from v1: JS source is a code-execution path and a read-only handle can ATTACH another tenant.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("key","TEXT","NOT NULL UNIQUE COLLATE NOCASE CHECK(key = lower(key) AND key NOT GLOB '*[^a-z0-9-]*')"),
 ("kind","TEXT","NOT NULL CHECK(kind IN ('view','query'))"),
 ("spec_json","TEXT","NOT NULL CHECK(json_valid(spec_json))"),
 ("is_public","INTEGER","NOT NULL DEFAULT 0 CHECK(is_public IN (0,1))"),
 ("ttl_s","INTEGER","NOT NULL DEFAULT 60 CHECK(ttl_s BETWEEN 0 AND 86400)"),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
 ("published_at","TEXT",None),
 ("published_by","INTEGER",None),
], checks=[], indexes=[("ix_ds_public","is_public",False)]),
"cms_view_registry": dict(note="Views are migration-owned. A view not in this registry fails the DDL runner's postcondition.", cols=[
 ("name","TEXT","PRIMARY KEY CHECK(name GLOB 'cms_v_*')"),
 ("checksum","TEXT","NOT NULL"),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], indexes=[]),
"cms_table_registry": dict(note="One row per u_* table. Written in the same transaction as the DDL.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("table_name","TEXT","NOT NULL UNIQUE CHECK(table_name GLOB 'u_*')"),
 ("ddl_version","INTEGER","NOT NULL DEFAULT 1"),
 ("column_count","INTEGER","NOT NULL"),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
 ("created_by","INTEGER",None),
 ("notes","TEXT",None),
], checks=[], indexes=[]),
"cms_audit": dict(note="Tenant-plane audit. Travels with the export. No single action is written here and to control.db.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("actor_user_id","INTEGER",None),
 ("actor_label","TEXT","NOT NULL"),
 ("action","TEXT","NOT NULL"),
 ("target_kind","TEXT",None),
 ("target_id","TEXT",None),
 ("before_json","TEXT",None),
 ("after_json","TEXT",None),
 ("ts","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], indexes=[("ix_ca_ts","ts",False),("ix_ca_action","action, ts",False)]),
"cms_redirect": dict(note="Nobody specified this; every slug rename is a 404 without it.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("from_path","TEXT","NOT NULL UNIQUE COLLATE NOCASE CHECK(from_path GLOB '/*')"),
 ("to_path","TEXT","NOT NULL CHECK(to_path GLOB '/*')"),
 ("status","INTEGER","NOT NULL DEFAULT 301 CHECK(status IN (301,302,308))"),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
 ("hits","INTEGER","NOT NULL DEFAULT 0"),
], checks=[], indexes=[]),
}

# ---------------------------------------------------------------- emitters
def ddl_for(name, spec, table_prefix_ok):
    cols = ",\n  ".join(f"{c} {t}" + (f" {x}" if x else "") for c,t,x in spec["cols"])
    pk = spec.get("pk")
    body = [cols]
    if pk: body.append(pk)
    for u_name, u_cols in spec.get("uniques", []):
        body.append(f"CONSTRAINT {u_name} UNIQUE({u_cols})")
    body += spec.get("checks", [])
    out = [f"-- {spec['note']}" if spec["note"] else "",
           f"CREATE TABLE {name} (\n  " + ",\n  ".join(body) + "\n);"]
    for ix_name, ix_cols, uniq in spec.get("indexes", []):
        out.append(f"CREATE {'UNIQUE ' if uniq else ''}INDEX {ix_name} ON {name}({ix_cols});")
    for p_name, p_cols, p_where, why in spec.get("partials", []):
        out.append(f"-- {why}")
        out.append(f"CREATE UNIQUE INDEX {p_name} ON {name}({p_cols}) WHERE {p_where};")
    return "\n".join(x for x in out if x)

def emit_sql(tables, header, extra=""):
    parts = [header, "PRAGMA foreign_keys = ON;", ""]
    for n, s in tables.items():
        parts.append(ddl_for(n, s, True)); parts.append("")
    return "\n".join(parts) + extra

PUML_HEAD = """@startuml
/' Generated by scripts/model/gen_schema.py — do not edit by hand.
   Every table and column here is emitted from the same spec as schema/control.sql
   and schema/site.sql. ER<->DDL parity is therefore mechanical, not editorial. '/
hide circle
skinparam linetype ortho
skinparam classAttributeIconSize 0
skinparam shadowing false
skinparam class {
  BackgroundColor #FDFDFD
  BorderColor #444444
  ArrowColor #444444
}
"""
PK_HINTS = {"cms_asset", "cms_page"}

def emit_puml(control, site):
    out = [PUML_HEAD]
    out.append("package \"control.db  (global, never exported)\" {")
    for n, s in control.items():
        out.append(f"  entity {n} as \"{n}\" <<control>> {{")
        for c,t,x in s["cols"]:
            tag = " <<PK>>" if "PRIMARY KEY" in (x or "") else (" <<FK>>" if "REFERENCES" in (x or "") else (" <<UQ>>" if "UNIQUE" in (x or "") else ""))
            out.append(f"    {c} : {t}{tag}")
        out.append("  }")
    out.append("}")
    out.append("")
    out.append("package \"tenants/<key>/site.db  (one file per tenant)\" {")
    for n, s in site.items():
        out.append(f"  entity {n} as \"{n}\" <<site>> {{")
        for c,t,x in s["cols"]:
            tag = " <<PK>>" if "PRIMARY KEY" in (x or "") else (" <<FK>>" if "REFERENCES" in (x or "") else (" <<UQ>>" if "UNIQUE" in (x or "") else ""))
            out.append(f"    {c} : {t}{tag}")
        out.append("  }")
    out.append("}")
    out.append("")
    # relationships derived from REFERENCES clauses
    rels = set()
    for group, pkg in ((control,"control"),(site,"site")):
        for n, s in group.items():
            for c,t,x in s["cols"]:
                if x and "REFERENCES" in x:
                    target = x.split("REFERENCES")[1].strip().split("(")[0].strip()
                    rels.add(f"{target} ||--o{{ {n} : \"{c}\"")
    # control.db -> site.db (the topology, not an FK)
    rels.add("tenant ||..o{ cms_audit : \"rows carry tenant via file, not FK\"")
    for r in sorted(rels):
        out.append(r)
    out.append("")
    out.append("note bottom of tenant\n  FK arrows are real SQLite foreign keys.\n  The dotted line is topology, not a constraint:\n  control.tenant and site.cms_* never share a connection.\nend note")
    out.append("@enduml")
    return "\n".join(out)

def main():
    sql_dir = os.path.join(ROOT, "schema"); os.makedirs(sql_dir, exist_ok=True)
    dg_dir = os.path.join(ROOT, "docs", "debate", "diagrams"); os.makedirs(dg_dir, exist_ok=True)

    ctrl = emit_sql(CONTROL,
      "-- control.db — generated by scripts/model/gen_schema.py\n"
      "-- application_id 0x534B5700 distinguishes it from a site.db (0x534B5701).\n"
      "PRAGMA application_id = 0x534B5700;\nPRAGMA user_version = 1;\nPRAGMA journal_mode = WAL;")
    site = emit_sql(SITE,
      "-- site.db — generated by scripts/model/gen_schema.py\n"
      "-- application_id 0x534B5701 lets install.sh refuse to open the wrong file.\n"
      "PRAGMA application_id = 0x534B5701;\nPRAGMA user_version = 1;\nPRAGMA journal_mode = WAL;",
      extra="\n-- u_* tables are created at runtime by the DDL runner; they are NOT declared here.\n")

    open(os.path.join(sql_dir,"control.sql"),"w").write(ctrl+"\n")
    open(os.path.join(sql_dir,"site.sql"),"w").write(site+"\n")
    puml = emit_puml(CONTROL, SITE)
    puml_path = os.path.join(dg_dir,"r1-data-model.puml")
    open(puml_path,"w").write(puml+"\n")

    print(f"control.sql: {len(CONTROL)} tables, {sum(len(s['cols']) for s in CONTROL.values())} columns")
    print(f"site.sql:    {len(SITE)} tables, {sum(len(s['cols']) for s in SITE.values())} columns")
    print(f"puml:        {len(CONTROL)+len(SITE)} entities written to {puml_path}")
    try:
        subprocess.run(["plantuml","-tpng","-charset","UTF-8",puml_path], check=True)
        png = puml_path[:-5]+".png"
        print(f"png:         {png} ({os.path.getsize(png)} bytes)")
    except Exception as e:
        print("plantuml render failed:", e, file=sys.stderr)

if __name__ == "__main__":
    main()
