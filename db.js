'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'database.sqlite');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}
function addColumn(table, column, definition) {
  if (!columnExists(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

db.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK(length(name) <= 140),
  slug TEXT UNIQUE NOT NULL CHECK(length(slug) <= 90),
  city TEXT,
  logo TEXT,
  phone TEXT,
  website_url TEXT,
  vk_url TEXT,
  telegram_url TEXT,
  whatsapp_url TEXT,
  email TEXT,
  contact_label TEXT NOT NULL DEFAULT 'Связаться',
  accent_color TEXT NOT NULL DEFAULT '#B47A3D',
  theme TEXT NOT NULL DEFAULT 'classic' CHECK(theme IN ('classic','soft','contrast')),
  footer_text TEXT,
  legal_name TEXT,
  data_contact TEXT,
  data_email TEXT,
  privacy_url TEXT,
  operator_text TEXT,
  custom_domain TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS managers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  login TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'manager',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS landing_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','hidden','archived')),
  version INTEGER NOT NULL DEFAULT 1,
  seo_title TEXT,
  seo_description TEXT,
  og_image TEXT,
  preloader_title TEXT,
  hero_title TEXT,
  hero_subtitle TEXT,
  hero_primary_label TEXT,
  hero_primary_url TEXT,
  hero_secondary_label TEXT,
  hero_secondary_url TEXT,
  hero_image TEXT,
  nav_json TEXT NOT NULL DEFAULT '[]',
  blocks_json TEXT NOT NULL DEFAULT '{}',
  contacts_json TEXT NOT NULL DEFAULT '[]',
  faq_json TEXT NOT NULL DEFAULT '[]',
  tracking_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS memorials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL CHECK(length(full_name) <= 140),
  slug TEXT NOT NULL CHECK(length(slug) <= 90),
  public_token TEXT NOT NULL,
  birth_date TEXT NOT NULL,
  death_date TEXT NOT NULL,
  quote TEXT NOT NULL DEFAULT 'Главное — держаться вместе.',
  epitaph TEXT NOT NULL CHECK(length(epitaph) <= 700),
  biography TEXT NOT NULL CHECK(length(biography) <= 7000),
  main_photo TEXT NOT NULL,
  album_cover_photo_id INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','hidden','archived')),
  privacy_status TEXT NOT NULL DEFAULT 'unlisted' CHECK(privacy_status IN ('draft','unlisted','public')),
  noindex INTEGER NOT NULL DEFAULT 1 CHECK(noindex IN (0,1)),
  consent_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(consent_confirmed IN (0,1)),
  section_order_json TEXT NOT NULL DEFAULT '["hero","words","story","album","footer"]',
  hidden_sections_json TEXT NOT NULL DEFAULT '[]',
  footer_text TEXT,
  candles_count INTEGER NOT NULL DEFAULT 0 CHECK(candles_count >= 0),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, slug)
);

CREATE TABLE IF NOT EXISTS memorial_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memorial_id INTEGER NOT NULL REFERENCES memorials(id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK(length(text) <= 1600),
  author TEXT,
  relation TEXT,
  is_featured INTEGER NOT NULL DEFAULT 0 CHECK(is_featured IN (0,1)),
  status TEXT NOT NULL DEFAULT 'approved' CHECK(status IN ('new','approved','hidden','deleted')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS memorial_qualities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memorial_id INTEGER NOT NULL REFERENCES memorials(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  icon_key TEXT NOT NULL DEFAULT 'heart',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS memorial_milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memorial_id INTEGER NOT NULL REFERENCES memorials(id) ON DELETE CASCADE,
  year TEXT NOT NULL,
  text TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS memorial_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memorial_id INTEGER NOT NULL REFERENCES memorials(id) ON DELETE CASCADE,
  original_path TEXT,
  preview_path TEXT NOT NULL,
  large_path TEXT NOT NULL,
  thumb_path TEXT NOT NULL,
  title TEXT,
  caption TEXT,
  photo_date TEXT,
  place TEXT,
  focus_x REAL NOT NULL DEFAULT 0.5,
  focus_y REAL NOT NULL DEFAULT 0.5,
  is_visible INTEGER NOT NULL DEFAULT 1 CHECK(is_visible IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS candle_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memorial_id INTEGER NOT NULL REFERENCES memorials(id) ON DELETE CASCADE,
  visitor_key TEXT NOT NULL,
  ip_hash TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(memorial_id, visitor_key)
);

CREATE TABLE IF NOT EXISTS memorial_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','in_work','waiting_materials','ready_review','published','archived')),
  full_name TEXT NOT NULL,
  birth_date TEXT,
  death_date TEXT,
  epitaph TEXT,
  biography TEXT,
  main_photo TEXT,
  photos TEXT NOT NULL DEFAULT '[]',
  memories TEXT NOT NULL DEFAULT '[]',
  contact_name TEXT,
  contact_phone TEXT,
  messenger TEXT,
  city TEXT,
  comment TEXT,
  consent_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(consent_confirmed IN (0,1)),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  memorial_id INTEGER REFERENCES memorials(id) ON DELETE CASCADE,
  landing_id INTEGER REFERENCES landing_pages(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  visitor_key TEXT,
  ip_hash TEXT,
  user_agent_hash TEXT,
  referrer TEXT,
  path TEXT,
  meta TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS page_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_type TEXT NOT NULL CHECK(object_type IN ('landing','memorial')),
  object_id INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_by INTEGER REFERENCES managers(id) ON DELETE SET NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manager_id INTEGER REFERENCES managers(id) ON DELETE SET NULL,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  object_type TEXT,
  object_id INTEGER,
  object_name TEXT,
  meta TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);



CREATE TABLE IF NOT EXISTS notification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  related_type TEXT,
  related_id INTEGER,
  channel TEXT NOT NULL CHECK(channel IN ('email','telegram','system')),
  event_type TEXT NOT NULL,
  recipient TEXT,
  subject TEXT,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed','skipped')),
  error TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at DATETIME
);

CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  manager_id INTEGER REFERENCES managers(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  ip_hash TEXT,
  path TEXT,
  meta TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);


db.exec(`
  CREATE INDEX IF NOT EXISTS idx_security_events_company_date ON security_events(company_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_notification_log_company_date ON notification_log(company_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_log_company_date ON audit_log(company_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_analytics_company_date ON analytics_events(company_id, created_at);
`);

// safe additive migrations for future sessions
addColumn('landing_pages', 'theme_json', "TEXT NOT NULL DEFAULT '{}'");
addColumn('memorials', 'theme_key', "TEXT NOT NULL DEFAULT 'classic'");
addColumn('memorials', 'seo_title', 'TEXT');
addColumn('memorials', 'seo_description', 'TEXT');
addColumn('memorials', 'qr_png_path', 'TEXT');
addColumn('memorials', 'qr_svg_path', 'TEXT');
addColumn('memorials', 'qr_pdf_path', 'TEXT');


addColumn('companies', 'domain_status', "TEXT NOT NULL DEFAULT 'not_connected' CHECK(domain_status IN ('not_connected','pending','connected','error'))");
addColumn('companies', 'domain_notes', 'TEXT');
addColumn('companies', 'robots_policy', "TEXT NOT NULL DEFAULT 'default' CHECK(robots_policy IN ('default','noindex_all','allow_public'))");
addColumn('companies', 'manager_timezone', "TEXT NOT NULL DEFAULT 'Europe/Moscow'");
addColumn('companies', 'white_label_enabled', 'INTEGER NOT NULL DEFAULT 0 CHECK(white_label_enabled IN (0,1))');
addColumn('companies', 'brand_display_name', 'TEXT');
addColumn('companies', 'hide_platform_branding', 'INTEGER NOT NULL DEFAULT 0 CHECK(hide_platform_branding IN (0,1))');
addColumn('companies', 'public_footer_brand', 'TEXT');
addColumn('companies', 'domain_verified_at', 'DATETIME');
addColumn('companies', 'domain_check_token', 'TEXT');
addColumn('landing_pages', 'noindex', 'INTEGER NOT NULL DEFAULT 0 CHECK(noindex IN (0,1))');
addColumn('landing_pages', 'canonical_url', 'TEXT');
addColumn('landing_pages', 'og_title', 'TEXT');
addColumn('landing_pages', 'og_description', 'TEXT');
addColumn('landing_pages', 'custom_path', "TEXT NOT NULL DEFAULT '/' ");
addColumn('memorials', 'og_image', 'TEXT');
addColumn('memorials', 'canonical_url', 'TEXT');
addColumn('memorials', 'search_indexing_hint', "TEXT NOT NULL DEFAULT 'private_link'");

addColumn('memorial_submissions', 'source', "TEXT NOT NULL DEFAULT 'manual'");
addColumn('memorial_submissions', 'admin_note', 'TEXT');
addColumn('memorial_submissions', 'notify_email', 'TEXT');
addColumn('memorial_submissions', 'family_notified_at', 'DATETIME');
addColumn('memorial_submissions', 'converted_memorial_id', 'INTEGER REFERENCES memorials(id)');
addColumn('memorial_submissions', 'priority', "TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent'))");
addColumn('memorial_submissions', 'assigned_manager_id', 'INTEGER REFERENCES managers(id)');
addColumn('memorial_submissions', 'next_contact_at', 'DATETIME');
addColumn('memorial_submissions', 'last_contact_at', 'DATETIME');
addColumn('memorial_submissions', 'client_stage_note', 'TEXT');

addColumn('notification_log', 'priority', "TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent'))");
addColumn('notification_log', 'action_url', 'TEXT');
addColumn('notification_log', 'read_at', 'DATETIME');
addColumn('notification_log', 'actor_manager_id', 'INTEGER REFERENCES managers(id)');

addColumn('companies', 'notifications_enabled', 'INTEGER NOT NULL DEFAULT 1 CHECK(notifications_enabled IN (0,1))');
addColumn('companies', 'notify_on_new_submission', 'INTEGER NOT NULL DEFAULT 1 CHECK(notify_on_new_submission IN (0,1))');
addColumn('companies', 'notify_on_new_memory', 'INTEGER NOT NULL DEFAULT 1 CHECK(notify_on_new_memory IN (0,1))');
addColumn('companies', 'notify_on_publish', 'INTEGER NOT NULL DEFAULT 0 CHECK(notify_on_publish IN (0,1))');
addColumn('companies', 'notify_email_enabled', 'INTEGER NOT NULL DEFAULT 0 CHECK(notify_email_enabled IN (0,1))');
addColumn('companies', 'manager_notification_email', 'TEXT');
addColumn('companies', 'notification_from_email', 'TEXT');
addColumn('companies', 'notification_reply_to', 'TEXT');
addColumn('companies', 'smtp_host', 'TEXT');
addColumn('companies', 'smtp_port', 'INTEGER NOT NULL DEFAULT 587');
addColumn('companies', 'smtp_secure', 'INTEGER NOT NULL DEFAULT 0 CHECK(smtp_secure IN (0,1))');
addColumn('companies', 'smtp_user', 'TEXT');
addColumn('companies', 'smtp_pass', 'TEXT');
addColumn('companies', 'notify_telegram_enabled', 'INTEGER NOT NULL DEFAULT 0 CHECK(notify_telegram_enabled IN (0,1))');
addColumn('companies', 'telegram_bot_token', 'TEXT');
addColumn('companies', 'telegram_chat_id', 'TEXT');
addColumn('companies', 'family_approval_subject', "TEXT NOT NULL DEFAULT 'Ваши материалы одобрены'");
addColumn('companies', 'family_approval_body', "TEXT NOT NULL DEFAULT 'Здравствуйте! Ваши материалы по странице памяти проверены и приняты оператором. Спасибо за доверие.'");




// Session 27: platform multi-account foundation.
db.exec(`
CREATE TABLE IF NOT EXISTS partners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK(length(name) <= 140),
  slug TEXT UNIQUE NOT NULL CHECK(length(slug) <= 90),
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','archived')),
  created_by INTEGER REFERENCES managers(id) ON DELETE SET NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);
addColumn('companies', 'partner_id', 'INTEGER REFERENCES partners(id)');
addColumn('companies', 'plan', "TEXT NOT NULL DEFAULT 'standard'");
addColumn('companies', 'account_status', "TEXT NOT NULL DEFAULT 'active' CHECK(account_status IN ('active','trial','paused','archived'))");
addColumn('companies', 'created_by_manager_id', 'INTEGER REFERENCES managers(id)');
addColumn('companies', 'disabled_at', 'DATETIME');
addColumn('companies', 'last_activity_at', 'DATETIME');
addColumn('managers', 'partner_id', 'INTEGER REFERENCES partners(id)');
addColumn('managers', 'name', 'TEXT');
addColumn('managers', 'email', 'TEXT');
addColumn('managers', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0,1))');
addColumn('managers', 'last_login_at', 'DATETIME');
addColumn('managers', 'password_changed_at', 'DATETIME');
addColumn('analytics_events', 'partner_id', 'INTEGER REFERENCES partners(id)');
addColumn('audit_log', 'partner_id', 'INTEGER REFERENCES partners(id)');
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_companies_partner ON companies(partner_id, account_status);
  CREATE INDEX IF NOT EXISTS idx_managers_partner ON managers(partner_id, role);
  CREATE INDEX IF NOT EXISTS idx_analytics_partner_date ON analytics_events(partner_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_partner_date ON audit_log(partner_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_notification_read ON notification_log(company_id, read_at, created_at);
`);



// Session 52: secure account invitations for partner/business onboarding.
db.exec(`
CREATE TABLE IF NOT EXISTS account_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT UNIQUE NOT NULL,
  manager_id INTEGER NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES managers(id) ON DELETE SET NULL,
  scope TEXT NOT NULL CHECK(scope IN ('partner','business')),
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  partner_id INTEGER REFERENCES partners(id) ON DELETE CASCADE,
  expires_at DATETIME NOT NULL,
  used_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_account_invites_manager ON account_invites(manager_id, used_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_account_invites_company ON account_invites(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_account_invites_partner ON account_invites(partner_id, created_at);
`);

function touch(table, id) {
  db.prepare(`UPDATE ${table} SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
}
function asJson(value, fallback) {
  try { return JSON.parse(value || ''); } catch { return fallback; }
}
function log(managerId, companyId, action, objectType, objectId, objectName, meta = {}) {
  let partnerId = null;
  if (companyId) {
    const row = db.prepare('SELECT partner_id FROM companies WHERE id=?').get(companyId);
    partnerId = row?.partner_id || null;
  } else if (managerId) {
    const row = db.prepare('SELECT partner_id FROM managers WHERE id=?').get(managerId);
    partnerId = row?.partner_id || null;
  }
  db.prepare(`INSERT INTO audit_log (manager_id, company_id, partner_id, action, object_type, object_id, object_name, meta)
    VALUES (@manager_id,@company_id,@partner_id,@action,@object_type,@object_id,@object_name,@meta)`).run({
    manager_id: managerId || null, company_id: companyId || null, partner_id: partnerId, action, object_type: objectType || null,
    object_id: objectId || null, object_name: objectName || null, meta: JSON.stringify(meta)
  });
}


// Session 38: export and backup journal.
db.exec(`
CREATE TABLE IF NOT EXISTS export_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  partner_id INTEGER REFERENCES partners(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES managers(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK(type IN ('crm_export','memorial_export','business_backup')),
  scope TEXT NOT NULL DEFAULT 'business' CHECK(scope IN ('business','partner','platform')),
  format TEXT NOT NULL DEFAULT 'zip',
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','failed')),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_export_jobs_company_date ON export_jobs(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_export_jobs_partner_date ON export_jobs(partner_id, created_at);
`);

module.exports = { db, touch, asJson, log };
