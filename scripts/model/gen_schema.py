#!/usr/bin/env python3
"""Skunkworks data model — single source of truth. SITE VERSION 5, CONTROL VERSION 4.

Emits, from one spec:
  schema/control.sql                        DDL for control.db   (user_version 4)
  schema/site.sql                           DDL for a tenant site.db (user_version 5)
  docs/debate/diagrams/r1-data-model.puml   the debate-round ER (kept, regenerated at v3)
  docs/sds/diagrams/er-data-model.puml      the SDS ER (same spec, same emitter)
and renders both PNGs via the local `plantuml` binary.

Run: python3 scripts/model/gen_schema.py
Every table/column that appears in one artefact appears in all of them by construction, which is
what makes the ER<->DDL parity claim mechanical instead of editorial.

v3 deltas applied from docs/sds/00-adjudication.md (the register is the authority):
  C-6  cms_download_code: code_lookup -> code_selector (4 chars, plaintext, UNIQUE), argon2id
       verifier over the full 16 characters, no pepper column.
  C-7  cms_download_event: the counted unit is the redemption (jti), bytes_declared NOT NULL,
       bytes_sent nullable, partial unique index WHERE kind='first'.
  C-4  cms_component_registry: the `list` component owns the loop contract (exactly one
       [data-repeat] child + a clamp), so repetition is a registered type, not a block table.
  C-5  plugin tables p_<id>_* with cms_plugin_installed.cmanifest as the export-class source,
       cms_trigger_registry classified so the projection union check can pass against the DB.
  C-13 cms_table_registry: table class + prefix agreement + the closed column-type inventory
       the DDL AST emits from.
  C-14/C-16/C-21/C-23/O-34/O-36/O-44: event byte split, watermark render expiry, audit chain
       columns, template slug, code archive, plugin asset guards, write-only plugin settings.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
# E-31 item 5: v4 adds `cms_plugin_installed.activation_seq`, the durable half of the ESM
# cache-buster. The counter has to survive a restart or a new process re-imports the same URL
# and gets the previous module namespace back — the exact failure the counter exists to prevent.
# S8s: v6 adds `cms_css_blob` (every stylesheet the site serves, stored once, named by its own
# sha) and `cms_theme` (an uploaded look, one of which may be active). The blob is why a page's
# CSS can be a file with a name no one has to remember — and why an export can write exactly the
# files its documents point at.
# S9: v8 adds the board's people — `cms_account` and its roles, tokens, sessions and profile, plus
# the mail outbox and suppression list. These are the first tables in this file that hold a
# stranger's data, so every privacy decision that can be a constraint is one (activation requires a
# verified address and a confirmed OTP; visibility is a closed vocabulary; contact has no column).
SCHEMA_VERSION = 8
# E-20 (02-errata §8): the control plane moves to v4 — `audit_seal` is a day segment, not a
# cumulative snapshot — and `schema/control-r4.sql` is the v3 -> v4 delta.
CONTROL_VERSION = 4

PLANT_STORAGE = ("'content/media/' || substr(sha256,1,2) || '/' || sha256 || '.' ||"
                 " CASE mime WHEN 'image/webp' THEN 'webp' WHEN 'image/jpeg' THEN 'jpg'"
                 " WHEN 'image/png' THEN 'png' WHEN 'image/avif' THEN 'avif'"
                 " WHEN 'application/pdf' THEN 'pdf' WHEN 'video/mp4' THEN 'mp4'"
                 " WHEN 'audio/mpeg' THEN 'mp3' WHEN 'application/zip' THEN 'zip'"
                 " ELSE 'bin' END")

# Path canonicalisation, emitted from one Python string so page and redirect cannot drift.
PATH_OK = ("{c} = '/' OR ({c} GLOB '/*' AND {c} NOT GLOB '*..*' AND {c} NOT GLOB '*/'"
           " AND {c} NOT GLOB '*//*')")
PATH_INTERNAL = ("{c} = '/' OR ({c} GLOB '/*' AND {c} NOT GLOB '//*' AND {c} NOT GLOB '*..*'"
                 " AND {c} NOT GLOB '*/' AND {c} NOT GLOB '*//*')")

# The I8 ban, in the subset a CHECK can express: no inline script, no style element, no HTML
# comment, no javascript: URL, no srcdoc. Event handlers (on<name>=) are the write validator's
# job — SQLite has no regex, and a LIKE list of 70 handler names is not a control.
# The same five bans apply to whatever body a page stores, so the column name is a parameter:
# the published body and the draft body must be equally unable to carry script.
BODY_BAN = ("{c} NOT LIKE '%<script%' AND {c} NOT LIKE '%<style%'"
            " AND {c} NOT LIKE '%<!--%' AND {c} NOT LIKE '%javascript:%'"
            " AND {c} NOT LIKE '%srcdoc%'")

# ---------------------------------------------------------------- spec: control.db
CONTROL = {
"tenant": dict(note="One row per hosted site. The only place a site.db path may be derived from.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("key","TEXT","NOT NULL UNIQUE COLLATE NOCASE CHECK(key GLOB '[a-z0-9]*' AND key NOT GLOB '*[^a-z0-9-]*' AND length(key) BETWEEN 2 AND 40)"),
 ("mode","TEXT","NOT NULL CHECK(mode IN ('production','demo','internal'))"),
 ("status","TEXT","NOT NULL DEFAULT 'provisioning' CHECK(status IN ('provisioning','active','suspended','archived'))"),
 ("display_name","TEXT","NOT NULL CHECK(length(display_name) BETWEEN 1 AND 120)"),
 # E-31 item 5: the site schema a new tenant is created at — v4 adds the durable
 # `cms_plugin_installed.activation_seq`. A tenant row below this is migrated lazily (§2.3 step 4).
 ("db_version","INTEGER","NOT NULL DEFAULT 4 CHECK(db_version >= 1)"),
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
], checks=[], indexes=[
 # The tenant's domain list (`app/cli/export.ts:117`, and the admin's host list): before this
 # index the only index on `domain` was `ux_domain_primary`, partial on `is_primary = 1`, so a
 # listing scanned the whole table and then sorted it. The column order is the listing's own
 # `ORDER BY is_primary DESC, host`, so the seek and the order are one index read.
 ("ix_domain_tenant","tenant_id, is_primary DESC, host",False),
], partials=[
 ("ux_domain_primary","tenant_id","is_primary = 1","one primary host per tenant; partial unique is legal here because no FK points at domain"),
]),
"user_account": dict(note="tenant_id IS NULL = fleet operator. Never exported. SKW_FLEET_MODE=0 refuses to create or authenticate the fleet_admin role (O-33).", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("tenant_id","INTEGER","REFERENCES tenant(id) ON DELETE CASCADE"),
 ("email","TEXT","NOT NULL COLLATE NOCASE CHECK(email LIKE '%_@_%.__%')"),
 ("password_hash","TEXT","NOT NULL"),
 ("role","TEXT","NOT NULL DEFAULT 'editor' CHECK(role IN ('fleet_admin','owner','editor','viewer'))"),
 ("totp_secret","TEXT",None),
 ("must_change","INTEGER","NOT NULL DEFAULT 0 CHECK(must_change IN (0,1))"),
 ("reset_token_hash","TEXT",None),
 ("reset_expires_at","TEXT",None),
 ("failed_logins","INTEGER","NOT NULL DEFAULT 0 CHECK(failed_logins >= 0)"),
 ("locked_until","TEXT",None),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
 ("last_login_at","TEXT",None),
], checks=["CHECK((tenant_id IS NULL) = (role = 'fleet_admin'))"], uniques=[
 ("ux_user_tenant_email","tenant_id, email"),
], indexes=[
 # THE LOGIN PATH (`app/admin/auth.ts:267`, `WHERE email = ?`). Non-unique **on purpose**:
 # `Auth.authenticate()` treats two rows with one email as ambiguous and answers the same 401
 # as a wrong password, so the response is not an oracle. A UNIQUE index would move that
 # decision into SQLite and turn the second tenant's INSERT into a constraint error — the code
 # would keep a branch it can never reach. The index exists to make the lookup a seek; it must
 # not assert a rule the app owns.
 ("ix_user_email","email",False),
], partials=[
 ("ux_user_email_global","email","tenant_id IS NULL","fleet operators have no tenant, so UNIQUE(tenant_id,email) would not constrain them"),
]),
"session": dict(note="Rotated on privilege change. id is a 32-byte random hex, not a JWT. tenant_id is the ONLY source of admin tenant scope (C-11).", cols=[
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
"audit_log": dict(note="Control-plane actions only. No FK to user_account: audit outlives actors. The tenant plane is chained in cms_audit and anchored by audit_seal.", cols=[
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
"audit_seal": dict(note="C-21 anchor as a DAY SEGMENT (02-errata E-20): one row per tenant per UTC day, covering that day's own id range [first_id, last_id]. first_id/last_id/rows_in_day/head describe the segment; anchor is the hash of the row immediately before it ('' when the segment starts the chain). The verifier walks that range only, so a later day's traffic cannot falsify an earlier day's seal. The seal is the only copy the tenant's own writable file cannot rewrite. No FK: a seal outlives an archived tenant.", cols=[
 ("tenant_key","TEXT","NOT NULL CHECK(length(tenant_key) BETWEEN 2 AND 40)"),
 ("day","TEXT","NOT NULL CHECK(day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(day) IS NOT NULL)"),
 ("first_id","INTEGER","NOT NULL CHECK(first_id >= 1)"),
 ("last_id","INTEGER","NOT NULL CHECK(last_id >= first_id)"),
 ("rows_in_day","INTEGER","NOT NULL CHECK(rows_in_day >= 1)"),
 ("anchor","TEXT","NOT NULL CHECK(length(anchor) IN (0, 64))"),
 ("head","TEXT","NOT NULL CHECK(length(head) = 64)"),
 ("sealed_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
 ("late","INTEGER","NOT NULL DEFAULT 0 CHECK(late IN (0, 1))"),
], checks=[
 # date() returns NULL for an impossible day and a CHECK comparing to NULL PASSES, so the
 # day-shape CHECK above carries `date(day) IS NOT NULL` and this one repeats it: a single
 # comparison would admit '2026-13-01'.
 "CHECK(date(day) IS NOT NULL)",
 # an on-time seal is written on the day AFTER the day it covers; anything else is late.
 "CHECK(late = 1 OR substr(sealed_at, 1, 10) = date(day, '+1 day'))",
], pk="PRIMARY KEY(tenant_key, day)", indexes=[("ix_seal_day","day",False),("ix_seal_late","tenant_key, late",False)]),
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
"control_revision": dict(note="E-3 (02-errata): the control-plane revision counter. Six triggers move it, AFTER INSERT/UPDATE/DELETE on tenant and on domain, in the same transaction as the write that fired them. TenantMap.stamp() is rev || ':' || PRAGMA user_version.", cols=[
 ("id","INTEGER","PRIMARY KEY CHECK(id = 1)"),
 ("rev","INTEGER","NOT NULL CHECK(rev >= 1)"),
 ("changed_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
]),
}

# ---------------------------------------------------------------- spec: site.db
SITE = {
"cms_settings": dict(note="The only site-level EAV table. Keys are registry-declared; unknown keys are rejected by the app. Plugin settings do NOT live here (cms_plugin_setting).", cols=[
 ("key","TEXT","PRIMARY KEY CHECK(key GLOB '[a-z0-9._]*')"),
 ("value_json","TEXT","NOT NULL"),
 ("type","TEXT","NOT NULL CHECK(type IN ('int','bool','string','json','asset_key'))"),
 ("updated_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
 ("updated_by","INTEGER",None),
], checks=[], indexes=[]),
"cms_component_registry": dict(note="C-4/C-23: the editor registry IS the loop contract. A `list` row must name exactly one [data-repeat] child and a clamp; a `shell` row is what cms_page.template resolves against; an `island` row owns the prop schema that is validated at save.", cols=[
 ("name","TEXT","PRIMARY KEY CHECK(name GLOB '[a-z][a-z0-9-]*' AND length(name) BETWEEN 2 AND 40)"),
 ("kind","TEXT","NOT NULL CHECK(kind IN ('block','shell','island','list'))"),
 ("renderer","TEXT","NOT NULL CHECK(renderer GLOB 'components/*' OR renderer GLOB 'islands/*')"),
 ("repeat_child","TEXT",None),
 ("bindings_json","TEXT","NOT NULL DEFAULT '[]' CHECK(json_valid(bindings_json) AND json_type(bindings_json) = 'array')"),
 ("props_schema_json","TEXT","NOT NULL DEFAULT '{}' CHECK(json_valid(props_schema_json) AND json_type(props_schema_json) = 'object')"),
 ("limit_max","INTEGER",None),
 ("version","TEXT","NOT NULL"),
], checks=[
 "CHECK(kind <> 'list' OR (repeat_child IS '[data-repeat]' AND limit_max IS NOT NULL))",
 "CHECK(kind = 'list' OR repeat_child IS NULL)",
 "CHECK(limit_max IS NULL OR limit_max BETWEEN 1 AND 200)",
], indexes=[("ix_comp_kind","kind",False)]),
"cms_page": dict(note="One document per page: the GrapesJS model is the source of truth, not a block tree. template is a slug resolved against cms_component_registry kind='shell' at publish (no FK: a partial index cannot be an FK parent, make test check 4).", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("path","TEXT","NOT NULL UNIQUE COLLATE NOCASE CHECK(" + PATH_OK.format(c="path") + ")"),
 ("slug","TEXT","NOT NULL CHECK(slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*')"),
 ("title","TEXT","NOT NULL CHECK(length(title) BETWEEN 1 AND 200)"),
 ("status","TEXT","NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','hidden'))"),
 ("template","TEXT","NOT NULL DEFAULT 'page' CHECK(template GLOB '[a-z][a-z0-9-]*')"),
 ("body_html","TEXT","NOT NULL DEFAULT '' CHECK(" + BODY_BAN.format(c="body_html") + ")"),
 ("body_css","TEXT","NOT NULL DEFAULT ''"),
 ("rev","INTEGER","NOT NULL DEFAULT 0 CHECK(rev >= 0)"),
 ("body_sha","TEXT","NOT NULL DEFAULT '' CHECK(length(body_sha) IN (0,64))"),
 # S8b (E-35): `body_*` above is the PUBLISHED body — the renderer reads it and only publish
 # writes it. `draft_*` is the work in progress: the editor writes it, and the page list
 # compares `draft_sha` with `body_sha` to answer "is there something to publish?". Kept as
 # columns on the same row because a second table would need its own lifecycle, its own orphan
 # sweep and its own answer to "what happens when the page is deleted".
 ("draft_html","TEXT","NOT NULL DEFAULT '' CHECK(" + BODY_BAN.format(c="draft_html") + ")"),
 ("draft_css","TEXT","NOT NULL DEFAULT ''"),
 ("draft_sha","TEXT","NOT NULL DEFAULT '' CHECK(length(draft_sha) IN (0,64))"),
 ("draft_updated_at","TEXT",None),
 ("managed_by","TEXT","NOT NULL DEFAULT 'editor' CHECK(managed_by IN ('editor','hand'))"),
 ("seo_json","TEXT",None),
 ("published_at","TEXT",None),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
 ("updated_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
 ("updated_by","INTEGER",None),
], checks=[], indexes=[("ix_page_status","status, published_at",False)]),
"cms_page_revision": dict(note="Append-only. Covers the designer who hand-edits HTML and breaks it.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("page_id","INTEGER","NOT NULL REFERENCES cms_page(id) ON DELETE CASCADE"),
 ("rev","INTEGER","NOT NULL DEFAULT 0 CHECK(rev >= 0)"),
 ("body_html","TEXT","NOT NULL"),
 ("body_css","TEXT","NOT NULL"),
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
"cms_asset": dict(note="Identity is key. sha256 is the physical address and is never referenced by content. storage_path is GENERATED so no form, no driver and no CLI can write it (C-17).", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("key","TEXT","NOT NULL UNIQUE COLLATE NOCASE CHECK(key = lower(key) AND length(key) BETWEEN 1 AND 96 AND key NOT GLOB '*[^a-z0-9/_.-]*' AND key NOT GLOB '/?*' AND key NOT GLOB '*/' AND key NOT GLOB '*..*' AND key NOT GLOB '.?*')"),
 ("filename","TEXT","NOT NULL"),
 ("mime","TEXT","NOT NULL"),
 ("bytes","INTEGER","NOT NULL CHECK(bytes > 0)"),
 ("sha256","TEXT","NOT NULL CHECK(length(sha256) = 64)"),
 ("kind","TEXT","NOT NULL CHECK(kind IN ('image','video','audio','document','archive'))"),
 ("access_class","TEXT","NOT NULL DEFAULT 'public' CHECK(access_class IN ('public','linked-private','gated'))"),
 ("storage_path","TEXT","GENERATED ALWAYS AS (" + PLANT_STORAGE + ") STORED"),
 ("width","INTEGER",None),
 ("height","INTEGER",None),
 ("alt_text","TEXT",None),
 ("caption","TEXT",None),
 ("encrypted","INTEGER","NOT NULL DEFAULT 0 CHECK(encrypted IN (0,1))"),
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
"cms_asset_alias": dict(note="Old keys 301 to the live key. Never an FK target. Records unreferenced renames and URL-level renames for keys frozen inside body_html (C-3).", cols=[
 ("key","TEXT","PRIMARY KEY COLLATE NOCASE"),
 ("asset_id","INTEGER","NOT NULL REFERENCES cms_asset(id) ON DELETE CASCADE"),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], indexes=[]),
"cms_asset_variant": dict(note="Derived bytes. Not content: no page or user table may reference a variant. storage_path stays stored: it is the only record of which variant files exist on disk.", cols=[
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
"cms_asset_bundle_item": dict(note="Position is unique per bundle so a receipt licence can be ordered.", cols=[
 ("bundle_id","INTEGER","NOT NULL REFERENCES cms_asset_bundle(id) ON DELETE CASCADE"),
 ("asset_id","INTEGER","NOT NULL REFERENCES cms_asset(id) ON DELETE RESTRICT"),
 ("position","INTEGER","NOT NULL DEFAULT 0"),
], checks=[], uniques=[("ux_bundle_item_pos","bundle_id, position")], pk="PRIMARY KEY(bundle_id, asset_id)",
   indexes=[("ix_bundleitem_asset","asset_id",False)]),
"cms_download_code": dict(note="C-6: a 16-char code is <selector:4><secret:12>. code_selector is plaintext and UNIQUE (the 20-bit index seek); code_hash is argon2id(m=19456,t=2,p=1) over the full 16 characters. There is no pepper and no column holding the secret in recoverable form.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("code_selector","TEXT","NOT NULL UNIQUE CHECK(length(code_selector) = 4)"),
 ("code_hash","TEXT","NOT NULL CHECK(code_hash GLOB '$argon2id$*')"),
 ("asset_id","INTEGER","REFERENCES cms_asset(id) ON DELETE RESTRICT"),
 ("bundle_id","INTEGER","REFERENCES cms_asset_bundle(id) ON DELETE RESTRICT"),
 ("max_uses","INTEGER","CHECK(max_uses IS NULL OR max_uses BETWEEN 1 AND 100)"),
 ("uses","INTEGER","NOT NULL DEFAULT 0 CHECK(uses >= 0)"),
 ("expires_at","TEXT",None),
 ("issued_to_email","TEXT",None),
 ("order_ref","TEXT",None),
 ("revoked_at","TEXT",None),
 ("last_used_at","TEXT",None),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=["CHECK((asset_id IS NULL) <> (bundle_id IS NULL))"], indexes=[
 ("ix_code_asset","asset_id, created_at",False)]),
"cms_download_code_archive": dict(note="O-34: `uses` snapshotted before events are pruned, so the E1 reconciliation still counts a pruned range. v1 never prunes, so this table is empty in every bundle.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("code_id","INTEGER","NOT NULL REFERENCES cms_download_code(id) ON DELETE CASCADE"),
 ("pruned_through","TEXT","NOT NULL"),
 ("uses","INTEGER","NOT NULL CHECK(uses >= 0)"),
 ("first_events","INTEGER","NOT NULL CHECK(first_events >= 0)"),
 ("range_events","INTEGER","NOT NULL DEFAULT 0 CHECK(range_events >= 0)"),
 ("archived_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], indexes=[("ix_archive_code","code_id, pruned_through",False)]),
"cms_download_event": dict(note="C-7/C-14: the counted unit is the redemption (jti), not the request. bytes_declared is what the app authorised; bytes_sent is filled only from the nginx access log and is NULL in v1. A NOT NULL 0 here would be a fabrication.", cols=[
 ("id","INTEGER","PRIMARY KEY"),
 ("code_id","INTEGER","REFERENCES cms_download_code(id) ON DELETE SET NULL"),
 ("asset_id","INTEGER","REFERENCES cms_asset(id) ON DELETE SET NULL"),
 ("jti","TEXT",None),
 ("kind","TEXT","NOT NULL CHECK(kind IN ('first','range','denied'))"),
 ("bytes_declared","INTEGER","NOT NULL CHECK(bytes_declared >= 0)"),
 ("bytes_sent","INTEGER","CHECK(bytes_sent IS NULL OR bytes_sent >= 0)"),
 ("ip_hash","TEXT",None),
 ("ua_hash","TEXT",None),
 ("outcome","TEXT","NOT NULL CHECK(outcome IN ('ok','denied_quota','denied_expired','denied_revoked','denied_token','denied_watermark'))"),
 ("ts","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], indexes=[("ix_ev_code_ts","code_id, ts",False),("ix_ev_ts","ts",False)], partials=[
 ("ux_ev_jti_first","jti","kind = 'first'","the dedupe gate: one 'first' row per token, many NULLs (a denial against an unknown code has no jti yet)"),
]),
"cms_watermark_render": dict(note="C-16: a bounded transient, not a store. expires_at is token expiry + download.continuation_grace_s; the sweep deletes the file and the row. Class pii in every bundle.", cols=[
 ("id","INTEGER","PRIMARY KEY"),
 ("asset_id","INTEGER","NOT NULL REFERENCES cms_asset(id) ON DELETE CASCADE"),
 ("spec_sha","TEXT","NOT NULL"),
 ("source_sha","TEXT","NOT NULL"),
 ("bytes","INTEGER","NOT NULL"),
 ("path","TEXT","NOT NULL"),
 ("expires_at","TEXT","NOT NULL"),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], uniques=[("ux_wm","spec_sha, source_sha")], indexes=[("ix_wm_expiry","expires_at",False)]),
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
"cms_form_submission": dict(note="Core intake uses the plugin endpoint contract verbatim (O-30): 16 KiB cap, 5/10 min per IP, intent token, honeypot.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("form_id","INTEGER","NOT NULL REFERENCES cms_form(id) ON DELETE CASCADE"),
 ("payload_json","TEXT","NOT NULL"),
 ("ip_hash","TEXT",None),
 ("spam_score","REAL","NOT NULL DEFAULT 0"),
 ("state","TEXT","NOT NULL DEFAULT 'new' CHECK(state IN ('new','read','spam','forwarded','suppressed'))"),
 ("ts","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], indexes=[("ix_sub_form_ts","form_id, ts",False)]),
"cms_datasource": dict(note="C-18: kind is view|query only — a `function` source is arbitrary code with a cross-tenant read primitive and is not representable. Aggregates are grammar (aggregate_json + group_by_json), not code. cost_ms_max is the gate (O-14): p95 of 20 is not an estimator.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("key","TEXT","NOT NULL UNIQUE COLLATE NOCASE CHECK(key = lower(key) AND key NOT GLOB '*[^a-z0-9-]*')"),
 ("kind","TEXT","NOT NULL CHECK(kind IN ('view','query'))"),
 ("spec_json","TEXT","NOT NULL CHECK(json_valid(spec_json))"),
 ("aggregate_json","TEXT","CHECK(aggregate_json IS NULL OR (json_valid(aggregate_json) AND json_type(aggregate_json) = 'object'))"),
 ("group_by_json","TEXT","CHECK(group_by_json IS NULL OR (json_valid(group_by_json) AND json_type(group_by_json) = 'array'))"),
 ("params_json","TEXT","NOT NULL DEFAULT '[]' CHECK(json_valid(params_json) AND json_type(params_json) = 'array')"),
 ("is_public","INTEGER","NOT NULL DEFAULT 0 CHECK(is_public IN (0,1))"),
 ("ttl_s","INTEGER","NOT NULL DEFAULT 60 CHECK(ttl_s BETWEEN 0 AND 86400)"),
 ("cost_ms_p95","REAL","CHECK(cost_ms_p95 IS NULL OR cost_ms_p95 >= 0)"),
 ("cost_ms_max","REAL","CHECK(cost_ms_max IS NULL OR cost_ms_max >= 0)"),
 ("cost_rows","INTEGER",None),
 ("cost_measured_at","TEXT",None),
 ("cost_plan","TEXT",None),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
 ("published_at","TEXT",None),
 ("published_by","INTEGER",None),
], checks=[], indexes=[("ix_ds_public","is_public",False)]),
"cms_view_registry": dict(note="Views are migration-owned. A view not in this registry fails the DDL runner's postcondition.", cols=[
 ("name","TEXT","PRIMARY KEY CHECK(name GLOB 'cms_v_*')"),
 ("checksum","TEXT","NOT NULL"),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], indexes=[]),
"cms_table_registry": dict(note="C-13: one row per runtime table, with the class/prefix agreement the DDL AST postcondition asserts and the closed-type column inventory Kysely types are regenerated from.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("table_name","TEXT","NOT NULL UNIQUE CHECK(table_name GLOB 'u_?*' OR table_name GLOB 'p_?*')"),
 ("table_class","TEXT","NOT NULL CHECK(table_class IN ('user','plugin'))"),
 ("plugin_id","TEXT","CHECK(plugin_id IS NULL OR (plugin_id GLOB '[a-z][a-z0-9]*' AND length(plugin_id) BETWEEN 2 AND 20))"),
 ("ddl_version","INTEGER","NOT NULL DEFAULT 1 CHECK(ddl_version >= 1)"),
 ("column_count","INTEGER","NOT NULL CHECK(column_count BETWEEN 1 AND 40)"),
 ("index_count","INTEGER","NOT NULL DEFAULT 0 CHECK(index_count BETWEEN 0 AND 8)"),
 ("columns_json","TEXT","NOT NULL CHECK(json_valid(columns_json) AND json_type(columns_json) = 'array')"),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
 ("created_by","INTEGER",None),
 ("notes","TEXT",None),
], checks=[
 "CHECK((table_class = 'user' AND table_name GLOB 'u_?*' AND plugin_id IS NULL)"
 " OR (table_class = 'plugin' AND table_name GLOB 'p_?*' AND plugin_id IS NOT NULL))",
], indexes=[("ix_tbl_class","table_class, plugin_id",False)]),
"cms_trigger_registry": dict(note="Every trigger in the database is registered here; the DDL postcondition is 'every trigger is in this registry', not 'there are zero triggers'.", cols=[
 ("name","TEXT","PRIMARY KEY"),
 ("table_name","TEXT","NOT NULL"),
 ("purpose","TEXT","NOT NULL CHECK(purpose IN ('asset_delete_guard','immutable_column','other'))"),
 ("checksum","TEXT","NOT NULL"),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], indexes=[("ix_trg_table","table_name",False)]),
"cms_audit": dict(note="C-21: tenant-plane audit, hash-chained inside the tenant's own file. rows are append-only by trigger. prev_hash/hash cover the canonical row; the daily audit_seal in control.db is the anchor that makes deletion visible.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("actor_user_id","INTEGER",None),
 ("actor_label","TEXT","NOT NULL"),
 ("action","TEXT","NOT NULL"),
 ("target_kind","TEXT",None),
 ("target_id","TEXT",None),
 ("before_json","TEXT",None),
 ("after_json","TEXT",None),
 ("prev_hash","TEXT","NOT NULL DEFAULT '' CHECK(length(prev_hash) IN (0,64))"),
 ("hash","TEXT","NOT NULL DEFAULT '' CHECK(length(hash) IN (0,64))"),
 ("ts","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], indexes=[("ix_ca_ts","ts",False),("ix_ca_action","action, ts",False)]),
"cms_redirect": dict(note="Nobody specified this; every slug rename is a 404 without it. to_path is internal-only: an off-site link is cms_nav.href_kind='url'.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("from_path","TEXT","NOT NULL UNIQUE COLLATE NOCASE CHECK(" + PATH_INTERNAL.format(c="from_path") + ")"),
 ("to_path","TEXT","NOT NULL CHECK(" + PATH_INTERNAL.format(c="to_path") + ")"),
 ("status","INTEGER","NOT NULL DEFAULT 301 CHECK(status IN (301,302,308))"),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
 ("hits","INTEGER","NOT NULL DEFAULT 0"),
], checks=[], indexes=[]),
"cms_css_blob": dict(note="S8s: a stylesheet is a file the browser can cache forever, so it needs a name that is its own bytes. One row per distinct sheet; a row is immutable, because the sha IS the name.", cols=[
 ("sha256","TEXT","PRIMARY KEY CHECK(length(sha256) = 64)"),
 ("css","TEXT","NOT NULL CHECK(length(css) BETWEEN 1 AND 1048576)"),
 ("bytes","INTEGER","NOT NULL CHECK(bytes > 0)"),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], indexes=[("ix_ccb_created","created_at",False)]),
"cms_theme": dict(note="S8s: an uploaded look. The CSS lives in cms_css_blob so two identical uploads are one row; `site.theme_key` (cms_settings) names the active one, which is what makes 'only one active at a time' a property of the model rather than a rule someone has to remember.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("theme_key","TEXT","NOT NULL UNIQUE CHECK(theme_key GLOB '[a-z0-9][a-z0-9-]*' AND length(theme_key) BETWEEN 2 AND 64)"),
 ("name","TEXT","NOT NULL CHECK(length(name) BETWEEN 1 AND 120)"),
 ("css_sha256","TEXT","NOT NULL REFERENCES cms_css_blob(sha256)"),
 ("source_name","TEXT",None),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
 ("created_by","INTEGER",None),
], checks=[], indexes=[("ix_ct_created","created_at",False)]),
"cms_theme_asset": dict(note="S8x: a theme is a package, not a stylesheet. The bytes live on disk beside the tenant (`tenants/<key>/theme-assets/<theme_key>/<path>`) and this row is the link the renderer follows: path -> sha, so the URL can be immutable and an export can copy exactly the files a document names. Deleting the theme deletes the rows and the directory.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("theme_id","INTEGER","NOT NULL REFERENCES cms_theme(id)"),
 ("path","TEXT","NOT NULL CHECK(length(path) BETWEEN 1 AND 200 AND substr(path,1,1) <> '/' AND path NOT GLOB '*..*')"),
 ("sha256","TEXT","NOT NULL CHECK(length(sha256) = 64)"),
 ("bytes","INTEGER","NOT NULL CHECK(bytes > 0)"),
 ("content_type","TEXT","NOT NULL CHECK(length(content_type) BETWEEN 3 AND 100)"),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], uniques=[("uq_cta_path","theme_id, path")], indexes=[("ix_cta_theme","theme_id",False)]),
"cms_plugin_installed": dict(note="C-5/C-9: the installed manifest is the ONLY source of a p_* table's export class and of the capability list shown at install. signature_state first_party = our key in the image; imported = the tenant owner imported a publisher key; no CA exists.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("plugin_id","TEXT","NOT NULL UNIQUE CHECK(plugin_id GLOB '[a-z][a-z0-9]*' AND length(plugin_id) BETWEEN 2 AND 20)"),
 ("version","TEXT","NOT NULL"),
 ("manifest_json","TEXT","NOT NULL CHECK(json_valid(manifest_json))"),
 ("root_hash","TEXT","NOT NULL CHECK(length(root_hash) = 64)"),
 ("publisher","TEXT","NOT NULL"),
 ("publisher_key_fingerprint","TEXT",None),
 ("signature_state","TEXT","NOT NULL CHECK(signature_state IN ('first_party','imported','unsigned'))"),
 ("enabled","INTEGER","NOT NULL DEFAULT 0 CHECK(enabled IN (0,1))"),
 ("test_report_sha","TEXT",None),
 ("runner_image_digest","TEXT",None),
 ("installed_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
 ("enabled_at","TEXT",None),
 # E-31 item 5: the counter the ESM cache-buster reads, durable across a restart. Monotonic
 # per package; written by the enable transaction, never reset by a disable (a disable→enable
 # cycle must produce a *new* module instance, §13.3.2).
 ("activation_seq","INTEGER","NOT NULL DEFAULT 0 CHECK(activation_seq >= 0)"),
], checks=[
 "CHECK(publisher_key_fingerprint IS NULL OR length(publisher_key_fingerprint) BETWEEN 16 AND 128)",
 "CHECK(enabled = 0 OR test_report_sha IS NOT NULL)",
], indexes=[("ix_plugin_enabled","enabled",False)]),
"cms_plugin_migration": dict(note="The migration ledger the host executor writes. Forward-only, one row per applied (plugin, version, seq).", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("plugin_id","TEXT","NOT NULL CHECK(plugin_id GLOB '[a-z][a-z0-9]*')"),
 ("version","TEXT","NOT NULL"),
 ("seq","INTEGER","NOT NULL CHECK(seq >= 1)"),
 ("checksum","TEXT","NOT NULL"),
 ("duration_ms","INTEGER",None),
 ("applied_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], uniques=[("ux_plugin_mig","plugin_id, version, seq")]),
"cms_plugin_setting": dict(note="O-44: plugin settings live in core, not in plugin tables, so a secret can be made write-only in one place. secret=1 is excluded from every bundle by the projection filter and never returned by settings.get.", cols=[
 ("plugin_id","TEXT","NOT NULL REFERENCES cms_plugin_installed(plugin_id) ON DELETE CASCADE"),
 ("key","TEXT","NOT NULL CHECK(key GLOB '[a-z][a-z0-9._-]*')"),
 ("value_json","TEXT","NOT NULL"),
 ("type","TEXT","NOT NULL CHECK(type IN ('string','int','bool','json','secret'))"),
 ("secret","INTEGER","NOT NULL DEFAULT 0 CHECK(secret IN (0,1))"),
 ("updated_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
 ("updated_by","INTEGER",None),
], checks=["CHECK((type = 'secret') = (secret = 1))"], pk="PRIMARY KEY(plugin_id, key)", indexes=[]),
"cms_plugin_revoked": dict(note="C-9: revocation is local to the install. A package root listed here cannot be installed or enabled, whatever its signature says.", cols=[
 ("root_hash","TEXT","PRIMARY KEY CHECK(length(root_hash) = 64)"),
 ("plugin_id","TEXT","NOT NULL"),
 ("reason","TEXT",None),
 ("revoked_by","INTEGER",None),
 ("revoked_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], indexes=[]),
"cms_account": dict(note="S9: one row per person who is not an operator. Identity lives in the TENANT's file, never in control.db, so a public registration path can never share a table with the fleet's operator accounts — different cookie, different path, different database. Argon2id at the same cost as an operator password; TOTP is NOT NULL because OTP is mandatory here, not an option; `status` starts at pending and the two CHECKs below make 'active' unrepresentable without a verified address and a confirmed second factor.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("email","TEXT","NOT NULL COLLATE NOCASE CHECK(email LIKE '%_@_%.__%')"),
 ("status","TEXT","NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','suspended','closed'))"),
 ("password_hash","TEXT","NOT NULL CHECK(length(password_hash) BETWEEN 20 AND 400)"),
 ("totp_secret","TEXT","NOT NULL CHECK(length(totp_secret) BETWEEN 16 AND 128)"),
 ("totp_confirmed_at","TEXT",None),
 ("email_verified","INTEGER","NOT NULL DEFAULT 0 CHECK(email_verified IN (0,1))"),
 ("failed_logins","INTEGER","NOT NULL DEFAULT 0 CHECK(failed_logins >= 0)"),
 ("locked_until","TEXT",None),
 ("last_login_at","TEXT",None),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
 ("updated_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[
 "CHECK(status <> 'active' OR email_verified = 1)",
 "CHECK(status <> 'active' OR totp_confirmed_at IS NOT NULL)",
], uniques=[("ux_account_email","email")], indexes=[("ix_account_status","status",False)]),
"cms_account_role": dict(note="S9: roles are additive grants, never inferred from each other. A person may be an applicant and an advertiser; the PK refuses a duplicate grant, and the closed vocabulary refuses a role the product does not implement.", cols=[
 ("account_id","INTEGER","NOT NULL REFERENCES cms_account(id) ON DELETE CASCADE"),
 ("role","TEXT","NOT NULL CHECK(role IN ('applicant','advertiser'))"),
 ("granted_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], pk="PRIMARY KEY(account_id, role)", indexes=[("ix_role_role","role",False)]),
"cms_account_token": dict(note="S9: email verification and password reset. Only the sha256 is stored — a database copy cannot be replayed to activate an account. Single use is enforced by the conditional UPDATE that sets consumed_at, not by a check-then-write in a handler.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("account_id","INTEGER","NOT NULL REFERENCES cms_account(id) ON DELETE CASCADE"),
 ("purpose","TEXT","NOT NULL CHECK(purpose IN ('verify_email','reset_password'))"),
 ("token_hash","TEXT","NOT NULL CHECK(length(token_hash) = 64)"),
 ("expires_at","TEXT","NOT NULL"),
 ("consumed_at","TEXT",None),
 ("ip_hash","TEXT","NOT NULL CHECK(length(ip_hash) = 64)"),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=["CHECK(consumed_at IS NULL OR consumed_at >= created_at)"], uniques=[("ux_account_token_hash","token_hash")], indexes=[("ix_token_account","account_id, purpose",False),("ix_account_token_expiry","expires_at",False)]),
"cms_account_session": dict(note="S9: a portal session. The id is 32 random hex bytes, not a token with claims; csrf_secret binds the anti-forgery token to THIS session; ip_hash/ua_hash record the shape it was minted for; rotation is a new row naming the old one in rotated_from, so a stolen id that is rotated away is visible in the table rather than merely absent.", cols=[
 ("id","TEXT","PRIMARY KEY CHECK(length(id) = 64)"),
 ("account_id","INTEGER","NOT NULL REFERENCES cms_account(id) ON DELETE CASCADE"),
 ("csrf_secret","TEXT","NOT NULL CHECK(length(csrf_secret) BETWEEN 32 AND 128)"),
 ("ip_hash","TEXT","NOT NULL CHECK(length(ip_hash) = 64)"),
 ("ua_hash","TEXT","NOT NULL CHECK(length(ua_hash) = 64)"),
 ("created_at","TEXT","NOT NULL"),
 ("last_seen_at","TEXT","NOT NULL"),
 ("expires_at","TEXT","NOT NULL"),
 ("rotated_from","TEXT",None),
 ("revoked_at","TEXT",None),
], checks=[], indexes=[("ix_account_session_account","account_id",False),("ix_account_session_expiry","expires_at",False)]),
"cms_profile": dict(note="S9: the applicant's own facts — the most sensitive rows this product holds, which is why contact has NO column here. What an advertiser may see is decided by app/accounts/policy.ts, and that function can only return fields of this table, so the projection type has no place to put an address. `visibility` governs discovery and mail only; an application is a separate, deliberate grant. `notify_new_jobs` defaults OFF: visible is necessary and not sufficient for mail.", cols=[
 ("account_id","INTEGER","PRIMARY KEY REFERENCES cms_account(id) ON DELETE CASCADE"),
 ("display_name","TEXT","NOT NULL CHECK(length(display_name) BETWEEN 1 AND 120)"),
 ("headline","TEXT",None),
 ("summary","TEXT",None),
 ("skills_json","TEXT","NOT NULL DEFAULT '[]' CHECK(json_valid(skills_json))"),
 ("day_rate_cents","INTEGER","CHECK(day_rate_cents IS NULL OR day_rate_cents > 0)"),
 ("currency","TEXT","NOT NULL DEFAULT 'AUD' CHECK(length(currency) = 3)"),
 ("availability_days_per_week","INTEGER","CHECK(availability_days_per_week IS NULL OR availability_days_per_week BETWEEN 1 AND 7)"),
 ("location","TEXT",None),
 ("timezone","TEXT",None),
 ("remote_ok","INTEGER","NOT NULL DEFAULT 0 CHECK(remote_ok IN (0,1))"),
 ("links_json","TEXT","NOT NULL DEFAULT '[]' CHECK(json_valid(links_json))"),
 ("visibility","TEXT","NOT NULL DEFAULT 'hidden' CHECK(visibility IN ('hidden','discoverable'))"),
 ("notify_new_jobs","INTEGER","NOT NULL DEFAULT 0 CHECK(notify_new_jobs IN (0,1))"),
 ("updated_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], indexes=[("ix_profile_discovery","visibility, notify_new_jobs",False)]),
"cms_mail": dict(note="S9: the outbox. `idempotency_key` is UNIQUE so a retried enqueue cannot send twice; one row is one recipient, so a fan-out never needs a Bcc and a reply cannot disclose the list. `status` is the delivery state a worker owns; a suppressed address is recorded once in cms_mail_suppression and never retried.", cols=[
 ("id","INTEGER","PRIMARY KEY AUTOINCREMENT"),
 ("to_email","TEXT","NOT NULL CHECK(to_email LIKE '%_@_%.__%')"),
 ("template","TEXT","NOT NULL CHECK(length(template) BETWEEN 1 AND 64)"),
 ("subject","TEXT","NOT NULL CHECK(length(subject) BETWEEN 1 AND 200)"),
 ("vars_json","TEXT","NOT NULL CHECK(json_valid(vars_json))"),
 ("status","TEXT","NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','failed','suppressed'))"),
 ("attempts","INTEGER","NOT NULL DEFAULT 0 CHECK(attempts >= 0)"),
 ("next_attempt_at","TEXT",None),
 ("last_error","TEXT",None),
 ("provider_id","TEXT",None),
 ("idempotency_key","TEXT","NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 200)"),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
 ("sent_at","TEXT",None),
], checks=[], uniques=[("ux_mail_idempotency","idempotency_key")], indexes=[("ix_mail_queue","status, next_attempt_at",False),("ix_mail_created","created_at",False)]),
"cms_mail_suppression": dict(note="S9: addresses the box must never write to again — a hard bounce, a complaint, or the person's own unsubscribe. Checked immediately before the transport call, not only at enqueue, so an opt-out that arrives while a message is queued still holds.", cols=[
 ("email","TEXT","PRIMARY KEY COLLATE NOCASE CHECK(email LIKE '%_@_%.__%')"),
 ("reason","TEXT","NOT NULL CHECK(reason IN ('bounce','complaint','unsubscribe','manual'))"),
 ("created_at","TEXT","NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
], checks=[], indexes=[]),
}



# ---------------------------------------------------------------- triggers
# Emitted into site.sql AND recreated by the amendment chain, so a fresh install and an upgraded
# tenant end up with the same set. Every trigger is registered in cms_trigger_registry; the DDL
# postcondition is "every trigger is in the registry", not "there are zero triggers".
# RAISE messages are error codes from the frozen taxonomy (C-19): SKW_E_<AREA>_<NAME>.
TRG_ASSET_GUARD = """CREATE TRIGGER trg_cms_asset_delete_guard BEFORE DELETE ON cms_asset
WHEN EXISTS (SELECT 1 FROM cms_asset_link        WHERE asset_id = OLD.id)
  OR EXISTS (SELECT 1 FROM cms_asset_bundle_item WHERE asset_id = OLD.id)
  OR EXISTS (SELECT 1 FROM cms_download_code     WHERE asset_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'SKW_E_DM_ASSET_IN_USE');
END"""

TRG_ASSET_SHA = """CREATE TRIGGER trg_cms_asset_sha_immutable BEFORE UPDATE OF sha256 ON cms_asset
WHEN NEW.sha256 IS NOT OLD.sha256
BEGIN
  SELECT RAISE(ABORT, 'SKW_E_DM_COLUMN_IMMUTABLE');
END"""

TRG_CODE_IMMUTABLE = """CREATE TRIGGER trg_cms_download_code_hash_immutable BEFORE UPDATE OF code_hash, code_selector ON cms_download_code
WHEN NEW.code_hash IS NOT OLD.code_hash OR NEW.code_selector IS NOT OLD.code_selector
BEGIN
  SELECT RAISE(ABORT, 'SKW_E_DM_COLUMN_IMMUTABLE');
END"""

TRG_AUDIT_UPDATE = """CREATE TRIGGER trg_cms_audit_append_only BEFORE UPDATE ON cms_audit
BEGIN
  SELECT RAISE(ABORT, 'SKW_E_DM_COLUMN_IMMUTABLE');
END"""

TRG_AUDIT_DELETE = """CREATE TRIGGER trg_cms_audit_no_delete BEFORE DELETE ON cms_audit
BEGIN
  SELECT RAISE(ABORT, 'SKW_E_DM_COLUMN_IMMUTABLE');
END"""

SITE_TRIGGERS = [
    ("trg_cms_asset_delete_guard", "cms_asset", "asset_delete_guard", TRG_ASSET_GUARD),
    ("trg_cms_asset_sha_immutable", "cms_asset", "immutable_column", TRG_ASSET_SHA),
    ("trg_cms_download_code_hash_immutable", "cms_download_code", "immutable_column", TRG_CODE_IMMUTABLE),
    ("trg_cms_audit_append_only", "cms_audit", "immutable_column", TRG_AUDIT_UPDATE),
    ("trg_cms_audit_no_delete", "cms_audit", "immutable_column", TRG_AUDIT_DELETE),
]
TRIGGER_CHECKSUM = "v3"

# ---------------------------------------------------------------- control triggers (E-3)
# Six triggers move `control_revision.rev`, so a status flip, a mode flip, a
# db_version raise, a domain insert and a domain delete are all visible to the
# app on the next request. Triggers and not the application, because the write
# that suspends a tenant may come from sqlite3, from `migrate`, or from the next
# image's admin tool.
_REV_BUMP = ("UPDATE control_revision SET rev = rev + 1, "
             "changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1;")
CONTROL_TRIGGERS = [
    (f"trg_tenant_rev_{op}", f"AFTER {op.upper()} ON tenant") for op in ("insert", "update", "delete")
] + [
    (f"trg_domain_rev_{op}", f"AFTER {op.upper()} ON domain") for op in ("insert", "update", "delete")
]


def control_extras():
    """The seed row, the six revision triggers and E-20's immutability trigger."""
    parts = ["", "-- E-3: one revision row. Six triggers move it (see below).",
             "INSERT INTO control_revision(id, rev) VALUES (1, 1);", ""]
    for name, when in CONTROL_TRIGGERS:
        parts += [f"CREATE TRIGGER {name} {when}", "BEGIN", f"  {_REV_BUMP}", "END;", ""]
    # E-20: the anchor is immutable. A re-seal is a refusal in the app (reason='already_sealed')
    # and an ABORT here, because the app is not the only thing that can write this file.
    parts += ["-- E-20: a sealed day is sealed. UPDATE is an ABORT, not a convention.",
              "CREATE TRIGGER trg_audit_seal_immutable BEFORE UPDATE ON audit_seal", "BEGIN",
              "  SELECT RAISE(ABORT, 'SKW_E_SEC_AUDIT_SEAL');", "END;", ""]
    return "\n".join(parts)


# ---------------------------------------------------------------- emitters
def ddl_for(name, spec):
    cols = ",\n  ".join(f"{c} {t}" + (f" {x}" if x else "") for c, t, x in spec["cols"])
    body = [cols]
    if spec.get("pk"):
        body.append(spec["pk"])
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


def emit_sql(tables, header, extra="", triggers=()):
    parts = [header, "PRAGMA foreign_keys = ON;", ""]
    for n, s in tables.items():
        parts.append(ddl_for(n, s))
        parts.append("")
    if triggers:
        parts.append("-- Triggers. In-database integrity: they fire for any driver, with foreign_keys OFF,\n"
                     "-- and from the sqlite3 CLI. Every one is registered below.")
        for name, table, purpose, sql in triggers:
            parts.append(sql + ";")
            parts.append(f"INSERT INTO cms_trigger_registry(name, table_name, purpose, checksum)\n"
                         f"  VALUES ('{name}', '{table}', '{purpose}', '{TRIGGER_CHECKSUM}');")
            parts.append("")
    return "\n".join(parts) + extra


def emit_puml(control, site):
    out = [PUML_HEAD, f"title Skunkworks schema v{SCHEMA_VERSION}  (generated from one spec)", ""]
    for pkg_label, group, stereo in (
            (f'control.db  (global, never exported, user_version {CONTROL_VERSION})', control, "control"),
            (f'tenants/<key>/site.db  (one file per tenant, user_version {SCHEMA_VERSION})', site, "site")):
        out.append(f'package "{pkg_label}" {{')
        for n, s in group.items():
            out.append(f'  entity {n} as "{n}" <<{stereo}>> {{')
            for c, t, x in s["cols"]:
                x = x or ""
                tag = (" <<PK>>" if "PRIMARY KEY" in x else
                       " <<FK>>" if "REFERENCES" in x else
                       " <<UQ>>" if "UNIQUE" in x else
                       " <<GEN>>" if "GENERATED" in x else
                       " <<NN>>" if "NOT NULL" in x else "")
                out.append(f"    {c} : {t}{tag}")
            out.append("  }")
        out.append("}")
        out.append("")
    rels = set()
    for group in (control, site):
        for n, s in group.items():
            for c, t, x in s["cols"]:
                if x and "REFERENCES" in x:
                    target = x.split("REFERENCES")[1].strip().split("(")[0].strip()
                    rels.add(f'{target} ||--o{{ {n} : "{c}"')
    rels.add('tenant ||..o{ audit_seal : "daily anchor, no FK"')
    rels.add('tenant ||..o{ cms_audit : "topology: rows carry tenant via file"')
    for r in sorted(rels):
        out.append(r)
    out.append("")
    out.append("legend bottom")
    out.append("  |= Class |= Pattern |= Owner |= DDL authority |")
    out.append("  | core | cms_* | the image | image migrations only; the runner refuses |")
    out.append("  | plugin-system | cms_plugin_* | the image | image migrations only |")
    out.append("  | user | u_* | the tenant's admin | the DDL runner: typed AST, <=8 statements |")
    out.append("  | plugin | p_<id>_* | the plugin's declarations | the host migration executor only |")
    out.append("  |||||")
    out.append("  | **Loop contract** | cms_component_registry kind='list' carries exactly one [data-repeat] child and a clamp (C-4). kind='shell' is what cms_page.template resolves against (C-23). |")
    out.append("  | **Export class** | a p_<id>_* table's class comes from cms_plugin_installed.manifest_json.tables[].export; there is no fourth class (C-5). |")
    out.append("end legend")
    out.append("@enduml")
    return "\n".join(out)


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


def main():
    sql_dir = os.path.join(ROOT, "schema")
    os.makedirs(sql_dir, exist_ok=True)
    dg = [os.path.join(ROOT, "docs", "debate", "diagrams"),
          os.path.join(ROOT, "docs", "sds", "diagrams")]
    for d in dg:
        os.makedirs(d, exist_ok=True)

    ctrl = emit_sql(CONTROL,
        f"-- control.db — generated by scripts/model/gen_schema.py (schema v{CONTROL_VERSION})\n"
        "-- application_id 0x534B5700 distinguishes it from a site.db (0x534B5701).\n"
        f"PRAGMA application_id = 0x534B5700;\nPRAGMA user_version = {CONTROL_VERSION};\nPRAGMA journal_mode = WAL;",
        extra=control_extras())
    site = emit_sql(SITE,
        f"-- site.db — generated by scripts/model/gen_schema.py (schema v{SCHEMA_VERSION})\n"
        "-- application_id 0x534B5701 lets install.sh refuse to open the wrong file.\n"
        f"PRAGMA application_id = 0x534B5701;\nPRAGMA user_version = {SCHEMA_VERSION};\nPRAGMA journal_mode = WAL;",
        extra="\n-- u_* tables are created at runtime by the DDL runner and p_<id>_* by the plugin\n"
              "-- migration executor; neither class is declared here.\n",
        triggers=SITE_TRIGGERS)

    open(os.path.join(sql_dir, "control.sql"), "w").write(ctrl + "\n")
    open(os.path.join(sql_dir, "site.sql"), "w").write(site + "\n")

    puml = emit_puml(CONTROL, SITE)
    for d, name in ((dg[0], "r1-data-model"), (dg[1], "er-data-model")):
        p = os.path.join(d, name + ".puml")
        open(p, "w").write(puml + "\n")

    print(f"control.sql: v{CONTROL_VERSION}, {len(CONTROL)} tables, "
          f"{sum(len(s['cols']) for s in CONTROL.values())} columns")
    print(f"site.sql:    v{SCHEMA_VERSION}, {len(SITE)} tables, "
          f"{sum(len(s['cols']) for s in SITE.values())} columns")
    for d, name in ((dg[0], "r1-data-model"), (dg[1], "er-data-model")):
        p = os.path.join(d, name + ".puml")
        try:
            subprocess.run(["plantuml", "-tpng", "-charset", "UTF-8", p], check=True)
            png = p[:-5] + ".png"
            print(f"png:         {os.path.relpath(png, ROOT)} ({os.path.getsize(png)} bytes)")
        except Exception as e:
            print(f"plantuml render FAILED for {p}: {e}", file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    main()
