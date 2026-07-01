'use strict';

require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const multer = require('multer');
const sharp = require('sharp');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const archiver = require('archiver');
const zlib = require('zlib');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const slugify = require('slugify');
const { db, asJson, log } = require('./db');

const app = express();
const PORT = Number(process.env.PORT || 3001);
const BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const ROOT = __dirname;
const UPLOAD_ROOT = path.join(ROOT, 'uploads');
for (const dir of ['uploads','uploads/tmp','uploads/logos','uploads/landing','uploads/memorial','uploads/qr','sessions','logs']) fs.mkdirSync(path.join(ROOT, dir), { recursive: true });

const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const CSRF_EXEMPT_PATHS = new Set(['/track']);
const RATE_BUCKETS = new Map();
const FAILED_LOGINS = new Map();

function securityLog(req, eventType, meta={}){
  try{
    db.prepare(`INSERT INTO security_events (company_id, manager_id, event_type, ip_hash, path, meta)
      VALUES (@company_id,@manager_id,@event_type,@ip_hash,@path,@meta)`).run({
        company_id: req.session?.manager?.company_id || null,
        manager_id: req.session?.manager?.id || null,
        event_type: String(eventType).slice(0, 80),
        ip_hash: sha(req.ip || req.socket?.remoteAddress || ''),
        path: String(req.originalUrl || req.url || '').slice(0, 500),
        meta: JSON.stringify(meta || {})
      });
  }catch(e){}
}
function rateLimit(name, limit, windowMs){
  return (req,res,next)=>{
    // In local development and Playwright QA we disable rate limits so repeated
    // automated logins do not hide real product errors behind 429 responses.
    // Production remains protected unless DISABLE_RATE_LIMITS=1 is set manually.
    if((!IS_PROD && process.env.DISABLE_RATE_LIMITS !== '0') || process.env.DISABLE_RATE_LIMITS === '1') return next();
    const key = `${name}:${req.ip}:${req.session?.manager?.id || 'anon'}`;
    const now = Date.now();
    const bucket = RATE_BUCKETS.get(key) || { count:0, reset: now + windowMs };
    if(now > bucket.reset){ bucket.count = 0; bucket.reset = now + windowMs; }
    bucket.count += 1;
    RATE_BUCKETS.set(key, bucket);
    if(bucket.count > limit){
      securityLog(req, 'rate_limit', { name, limit, windowMs });
      return res.status(429).send('Слишком много запросов. Попробуйте позже.');
    }
    next();
  };
}
function sameOrigin(req){
  const origin = req.get('origin');
  if(!origin) return true;
  try { return new URL(origin).host === req.get('host'); } catch { return false; }
}
function isMultipart(req){ return String(req.headers['content-type'] || '').toLowerCase().startsWith('multipart/form-data'); }
function csrfToken(req){
  if(!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.csrfToken;
}
function csrfField(req){ return `<input type="hidden" name="_csrf" value="${h(csrfToken(req))}">`; }
function injectCsrf(req, html){
  if(typeof html !== 'string' || !html.includes('<form')) return html;
  const token = csrfField(req);
  return html.replace(/<form\b([^>]*)method=["']?post["']?([^>]*)>/gi, (m)=> m + token);
}
function validateCsrf(req,res,next){
  if(!['POST','PUT','PATCH','DELETE'].includes(req.method)) return next();
  if(CSRF_EXEMPT_PATHS.has(req.path) || /^\/m\/[^/]+\/[^/]+\/memory$/.test(req.path)) return next();
  if(!sameOrigin(req)){
    securityLog(req, 'bad_origin', { origin:req.get('origin') || '', referer:req.get('referer') || '' });
    return res.status(403).send('Запрос заблокирован: неверный источник.');
  }
  if(isMultipart(req)) return next();
  const sent = req.body?._csrf || req.get('x-csrf-token');
  if(!sent || sent !== req.session.csrfToken){
    securityLog(req, 'csrf_failed', { method:req.method });
    return res.status(403).send('Сессия формы устарела. Обновите страницу и повторите действие.');
  }
  next();
}

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','SAMEORIGIN');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy','same-site');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' https://fonts.gstatic.com data:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "script-src 'self' 'unsafe-inline'",
    "connect-src 'self'"
  ].join('; '));
  if(IS_PROD && req.secure) res.setHeader('Strict-Transport-Security','max-age=15552000; includeSubDomains');
  next();
});
app.use(express.urlencoded({ extended: true, limit: '12mb' }));
app.use(express.json({ limit: '2mb' }));
app.use('/static', express.static(path.join(ROOT, 'public'), { maxAge: '1h', setHeaders(res){ res.setHeader('X-Content-Type-Options','nosniff'); } }));
app.use('/uploads', express.static(UPLOAD_ROOT, { maxAge: '1h', dotfiles:'deny', setHeaders(res){ res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Content-Disposition','inline'); } }));

function exampleFile(...parts){ return path.join(ROOT, 'public', 'examples', ...parts); }
app.get('/demo', (req,res)=>res.redirect('/demo/b2b'));
app.get('/demo/b2b', (req,res)=>res.sendFile(exampleFile('b2b','index.html')));
app.get('/demo/families', (req,res)=>res.sendFile(exampleFile('b2c','index.html')));
app.get('/demo/memory', (req,res)=>res.sendFile(exampleFile('memory','index.html')));
app.get('/primer-b2b', (req,res)=>res.redirect('/demo/b2b'));
app.get('/primer-dlya-semei', (req,res)=>res.redirect('/demo/families'));
app.get('/primer-stranicy-pamyati', (req,res)=>res.redirect('/demo/memory'));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: path.join(ROOT, 'sessions') }),
  secret: SESSION_SECRET,
  name: 'pamyatqr.sid',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: 1000*60*60*12 }
}));
app.use((req,res,next)=>{
  const originalSend = res.send.bind(res);
  res.send = (body)=>{
    if(typeof body === 'string' && String(body).includes('<html')) body = injectCsrf(req, body);
    return originalSend(body);
  };
  next();
});
app.use(validateCsrf);

const upload = multer({
  dest: path.join(UPLOAD_ROOT, 'tmp'),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 30) * 1024 * 1024, files: 50 },
  fileFilter(req, file, cb) {
    const ok = ['image/jpeg','image/png','image/webp','image/heic','image/heif'].includes(file.mimetype);
    const safeName = !/[\0<>:"|?*]/.test(file.originalname || '');
    cb(ok && safeName ? null : new Error('Разрешены только безопасные изображения JPG, PNG, WebP, HEIC'), ok && safeName);
  }
});

const backupUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.MAX_BACKUP_MB || 25) * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    const name = String(file.originalname || '').toLowerCase();
    const ok = name.endsWith('.zip') || file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed';
    cb(ok ? null : new Error('Разрешён только ZIP-архив резервной копии'), ok);
  }
});

function h(s='') { return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function parseList(v) { return String(v||'').split('\n').map(s=>s.trim()).filter(Boolean); }
function safeSlug(input) { return slugify(String(input||'memory'), { lower:true, strict:true, locale:'ru' }).slice(0,80) || 'memory'; }
function shortToken(){ return crypto.randomBytes(5).toString('hex'); }
function inviteToken(){ return crypto.randomBytes(24).toString('base64url'); }
function inviteHash(token){ return crypto.createHash('sha256').update(String(token||'')).digest('hex'); }
function strongTempPassword(){ return crypto.randomBytes(18).toString('base64url'); }
function inviteExpires(hours=24){ const d=new Date(Date.now()+Number(hours||24)*3600000); return d.toISOString(); }
function createAccountInvite(req, managerId, scope, companyId=null, partnerId=null){
  const token = inviteToken();
  db.prepare(`INSERT INTO account_invites (token_hash, manager_id, created_by, scope, company_id, partner_id, expires_at)
    VALUES (@token_hash,@manager_id,@created_by,@scope,@company_id,@partner_id,@expires_at)`).run({
      token_hash: inviteHash(token), manager_id: managerId, created_by: req.session?.manager?.id || null, scope, company_id: companyId || null, partner_id: partnerId || null, expires_at: inviteExpires(24)
    });
  audit(req,'create_invite', scope === 'partner' ? 'partner_invite' : 'business_invite', managerId, scope, { company_id:companyId||null, partner_id:partnerId||null });
  return token;
}
function latestInviteForManager(managerId){
  return db.prepare(`SELECT * FROM account_invites WHERE manager_id=? AND used_at IS NULL AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1`).get(managerId);
}
function inviteLifeLabel(invite){
  if(!invite) return '';
  const ms = new Date(invite.expires_at).getTime() - Date.now();
  if(ms <= 0) return 'срок истёк';
  const hLeft = Math.max(1, Math.ceil(ms / 3600000));
  return `действует ещё ${hLeft} ч.`;
}
function inviteUrl(req, token){
  const proto = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
  const host = req.get('host') || new URL(BASE_URL).host;
  return `${proto}://${host}/admin/invite/${encodeURIComponent(token)}`;
}
function publicInviteCopy(url){ return `<div class="invite-box"><b>Ссылка подключения</b><code>${h(url)}</code><button class="btn muted copy-btn" type="button" data-copy="${h(url)}">Копировать</button><p class="muted-text">Ссылка одноразовая и действует 24 часа. Клиент сам задаёт пароль; пароль не передаётся в открытом виде.</p></div>`; }

function nowStamp(){ return new Date().toISOString().replace(/[:.]/g,'-'); }
function rel(p){ return p ? p.replace(ROOT, '').replace(/^\//,'/') : ''; }
function publicPath(p){
  const value = String(p || '').trim();
  if(!value) return '';
  if(/^https?:\/\//i.test(value) || value.startsWith('data:') || value.startsWith('blob:')) return value;
  return value.startsWith('/') ? value : '/' + value.replace(/^\.\//,'');
}
function cssUrl(p){ return `url('${String(publicPath(p)).replace(/'/g, '%27')}')`; }
function toIsoDate(value){
  const v = String(value || '').trim();
  if(!v) return '';
  if(/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = v.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$/);
  if(m){
    const d = m[1].padStart(2,'0');
    const mo = m[2].padStart(2,'0');
    return `${m[3]}-${mo}-${d}`;
  }
  return v;
}
function displayDate(value){
  const v = String(value || '').trim();
  if(!v) return '';
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(m) return `${m[3]}.${m[2]}.${m[1]}`;
  return v;
}
function formatDate(value){
  const v = String(value || '').trim();
  if(!v) return '';
  const d = new Date(v);
  if(Number.isNaN(d.getTime())) return displayDate(v);
  return d.toLocaleString('ru-RU', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}
function rewriteAssetFolder(html, folder){
  return String(html)
    .replace(/url\(['"]?assets\//g, `url('/static/assets/${folder}/`)
    .replace(/(src|href)=(["'])assets\//g, `$1=$2/static/assets/${folder}/`);
}
function replaceAssetUrl(html, absolutePath, fileName){
  const safe = h(publicPath(absolutePath));
  const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  html = html.replace(new RegExp(`/static/assets/(landing|memory)/${escaped}`, 'g'), safe);
  html = html.replace(new RegExp(`url\(['"]?${safe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\)`, 'g'), cssUrl(safe));
  return html;
}
function contactHref(c){
  const type = String(c?.type || 'link').toLowerCase();
  const label = String(c?.label || '').trim();
  const raw = String(c?.url || '').trim();
  if(raw) return raw;
  if(type === 'phone') return 'tel:' + label.replace(/[^+\d]/g,'');
  if(type === 'email') return 'mailto:' + label;
  return '#';
}
function visibleItems(list){ return (Array.isArray(list) ? list : []).filter(x => x && x.visible !== false && x.label !== ''); }
function requireAuth(req,res,next){ if(req.session.manager) return next(); res.redirect('/admin/login'); }
function hasRole(req, roles){ return req.session?.manager && roles.includes(req.session.manager.role); }
function requireRoles(...roles){ return (req,res,next)=> hasRole(req, roles) ? next() : res.status(403).send('Недостаточно прав доступа.'); }
function currentCompany(req){
  const cid = req.session?.manager?.company_id;
  if(!cid) return null;
  return db.prepare("SELECT * FROM companies WHERE id=? AND is_active=1 AND account_status != 'archived'").get(cid) || null;
}
function currentPartner(req){
  const pid = req.session?.manager?.partner_id;
  if(!pid) return null;
  return db.prepare('SELECT * FROM partners WHERE id=?').get(pid) || null;
}
function isSuper(req){ return req.session?.manager?.role === 'super_admin'; }
function isPartner(req){ return req.session?.manager?.role === 'partner_admin'; }
function scopedCompanyIdsForPartner(partnerId){ return db.prepare('SELECT id FROM companies WHERE partner_id=? ORDER BY id').all(partnerId).map(x=>x.id); }
function canAccessCompany(req, companyId){
  const company = db.prepare('SELECT id, partner_id, is_active, account_status FROM companies WHERE id=?').get(companyId);
  if(!company || !company.is_active || company.account_status === 'archived') return false;
  if(isSuper(req)) return true;
  if(isPartner(req)){
    const partnerId = req.session.manager.partner_id;
    if(partnerId === null || partnerId === undefined || company.partner_id === null || company.partner_id === undefined) return false;
    return Number(company.partner_id) === Number(partnerId);
  }
  return Number(req.session.manager.company_id) === Number(companyId);
}
function requireCompanyContext(req, res, next){
  const company = currentCompany(req);
  if(company && canAccessCompany(req, company.id)){
    req.company = company;
    return next();
  }
  if(isSuper(req)) return res.redirect('/admin/platform');
  if(isPartner(req)) return res.redirect('/admin/partner');
  return res.status(403).send('Нет доступа к бизнесу.');
}


// Session 42: commercial plans and operational limits.
const PLAN_LIMITS = {
  trial: { label:'Trial', max_memorials:3, max_album_photos:30, white_label:0, custom_domain:0, exports:1, backups:0, operators:1 },
  standard: { label:'Standard', max_memorials:50, max_album_photos:300, white_label:1, custom_domain:1, exports:1, backups:1, operators:3 },
  pro: { label:'Pro', max_memorials:300, max_album_photos:1500, white_label:1, custom_domain:1, exports:1, backups:1, operators:10 },
  enterprise: { label:'Enterprise', max_memorials:999999, max_album_photos:999999, white_label:1, custom_domain:1, exports:1, backups:1, operators:999 }
};
function planFor(company){ return PLAN_LIMITS[String(company?.plan || 'standard')] || PLAN_LIMITS.standard; }
function limitLabel(value){ return Number(value) >= 999999 ? 'без лимита' : String(value); }
function companyUsage(companyId){
  const memorials = db.prepare('SELECT COUNT(*) AS n FROM memorials WHERE company_id=? AND status != \'archived\'').get(companyId).n;
  const photos = db.prepare('SELECT COUNT(*) AS n FROM memorial_photos p JOIN memorials m ON m.id=p.memorial_id WHERE m.company_id=? AND m.status != \'archived\'').get(companyId).n;
  const operators = db.prepare('SELECT COUNT(*) AS n FROM managers WHERE company_id=? AND is_active=1').get(companyId).n;
  return { memorials, photos, operators };
}
function usageBar(current, max){
  const unlimited = Number(max) >= 999999;
  const pct = unlimited ? 0 : Math.min(100, Math.round((Number(current)||0) / Math.max(1, Number(max)||1) * 100));
  return `<div class="limit-bar"><span style="width:${pct}%"></span></div><small>${h(String(current))} / ${h(limitLabel(max))}</small>`;
}
function canCreateMemorialFor(company){
  const plan = planFor(company);
  const usage = companyUsage(company.id);
  return { ok: usage.memorials < plan.max_memorials, usage, plan };
}
function planCardsHtml(company){
  const usage = companyUsage(company.id);
  const plan = planFor(company);
  return `<section class="panel"><h2>Текущий тариф: ${h(plan.label)}</h2><div class="grid3">
    <div class="stat"><b>${h(limitLabel(plan.max_memorials))}</b><span>Лимит страниц памяти</span></div>
    <div class="stat"><b>${plan.white_label?'да':'нет'}</b><span>White-label</span></div>
    <div class="stat"><b>${plan.custom_domain?'да':'нет'}</b><span>Свой домен</span></div>
  </div><div class="grid3"><div>${usageBar(usage.memorials, plan.max_memorials)}<p>Страницы памяти</p></div><div>${usageBar(usage.photos, plan.max_album_photos)}<p>Фото альбома</p></div><div>${usageBar(usage.operators, plan.operators)}<p>Пользователи</p></div></div></section>`;
}
function platformPlansHtml(req){
  const rows = Object.entries(PLAN_LIMITS).map(([key, p])=>{
    const businesses = db.prepare('SELECT COUNT(*) AS n FROM companies WHERE plan=? AND account_status != \'archived\'').get(key).n;
    return `<tr><td><b>${h(p.label)}</b><br><small>${h(key)}</small></td><td>${businesses}</td><td>${h(limitLabel(p.max_memorials))}</td><td>${h(limitLabel(p.max_album_photos))}</td><td>${p.white_label?'да':'нет'}</td><td>${p.custom_domain?'да':'нет'}</td><td>${p.backups?'да':'нет'}</td></tr>`;
  }).join('');
  const companies = db.prepare('SELECT id,name,plan,account_status FROM companies ORDER BY updated_at DESC LIMIT 20').all();
  return layout(req,'Тарифы и лимиты',`<div class="top"><h1>Тарифы и лимиты</h1><a class="btn muted" href="/admin/platform/health">Health</a></div>
    <section class="panel"><h2>Матрица тарифов</h2><table><tr><th>Тариф</th><th>Бизнесов</th><th>Страниц</th><th>Фото</th><th>White-label</th><th>Домен</th><th>Backup</th></tr>${rows}</table></section>
    <section class="panel"><h2>Последние бизнесы</h2><table><tr><th>Компания</th><th>Тариф</th><th>Статус</th><th>Использование</th></tr>${companies.map(c=>{const u=companyUsage(c.id); const p=planFor(c); return `<tr><td>${h(c.name)}</td><td>${h(c.plan||'standard')}</td><td>${h(c.account_status||'active')}</td><td>${u.memorials}/${h(limitLabel(p.max_memorials))} страниц</td></tr>`}).join('')}</table></section>`);
}

function startBusinessImpersonation(req, companyId){
  const m = req.session.manager;
  if(!m.impersonator_id){
    m.impersonator_id = m.id;
    m.impersonator_role = m.role;
    m.impersonator_partner_id = m.partner_id || null;
  }
  m.company_id = Number(companyId);
  m.acting_business_id = Number(companyId);
}
function stopBusinessImpersonation(req){
  const m = req.session.manager;
  if(!m || !m.impersonator_id) return;
  m.company_id = null;
  m.acting_business_id = null;
  delete m.impersonator_id;
  delete m.impersonator_role;
  delete m.impersonator_partner_id;
}
function publicMemorialUrl(company, memorial){ return `${publicBaseUrl(company)}/m/${company.slug}/${memorial.slug}-${memorial.public_token}`; }
function publicBaseUrl(company){
  const d = String(company?.custom_domain || '').trim().replace(/^https?:\/\//,'').replace(/\/$/,'');
  return d ? `https://${d}` : BASE_URL;
}
function currentHost(req){ return String(req.get('host') || '').split(':')[0].toLowerCase(); }
function companyByHost(req){
  const host = currentHost(req);
  return db.prepare('SELECT * FROM companies WHERE lower(custom_domain)=? AND is_active=1').get(host) || null;
}
function landingUrl(company){ return company?.custom_domain ? `${publicBaseUrl(company)}/` : `${BASE_URL}/l/${company.slug}`; }
function canonicalForLanding(company, landing){ return landing?.canonical_url || landingUrl(company); }
function canonicalForMemorial(company, memorial){ return memorial?.canonical_url || publicMemorialUrl(company, memorial); }
function whiteLabelEnabled(company){ return Number(company?.white_label_enabled || 0) === 1; }
function publicBrandNameFor(company, fallback=''){
  if(!company) return fallback || 'Память QR';
  if(whiteLabelEnabled(company)) return String(company.brand_display_name || company.name || fallback || 'Память QR').trim();
  return String(fallback || company.name || 'Память QR').trim();
}
function publicFooterTextFor(company){
  if(!company) return 'Работает на платформе Память QR';
  if(whiteLabelEnabled(company) && Number(company.hide_platform_branding || 0) === 1){
    return String(company.public_footer_brand || company.brand_display_name || company.name || '').trim();
  }
  return 'Работает на платформе Память QR';
}
function normalizeDomain(value){
  return String(value||'').trim().toLowerCase().replace(/^https?:\/\//,'').replace(/\/.*$/,'').replace(/:\d+$/,'');
}


function uniqueCompanySlug(base){
  let slug = safeSlug(base || 'business'); let n = 2; let out = slug;
  while(db.prepare('SELECT id FROM companies WHERE slug=?').get(out)){ out = `${slug}-${n++}`; }
  return out;
}
function uniquePartnerSlug(base){
  let slug = safeSlug(base || 'partner'); let n = 2; let out = slug;
  while(db.prepare('SELECT id FROM partners WHERE slug=?').get(out)){ out = `${slug}-${n++}`; }
  return out;
}
function ensureDefaultLandingForCompany(company){
  if(db.prepare('SELECT id FROM landing_pages WHERE company_id=?').get(company.id)) return;
  db.prepare(`INSERT INTO landing_pages (company_id,status,seo_title,seo_description,preloader_title,hero_title,hero_subtitle,hero_primary_label,hero_primary_url,hero_secondary_label,hero_secondary_url,hero_image,nav_json,contacts_json,faq_json,blocks_json)
    VALUES (@company_id,'published',@seo_title,@seo_description,@preloader_title,@hero_title,@hero_subtitle,@hero_primary_label,@hero_primary_url,@hero_secondary_label,@hero_secondary_url,@hero_image,@nav_json,@contacts_json,@faq_json,@blocks_json)`).run({
      company_id: company.id,
      seo_title: `${company.name} — страницы памяти по QR-коду`,
      seo_description: 'Цифровые страницы памяти: фото, история жизни, слова близких и QR-код.',
      preloader_title: company.name,
      hero_title:'Страница памяти, которую можно открыть по QR-коду',
      hero_subtitle:'Семья сохраняет фотографии, слова и историю близкого человека на красивой личной странице.',
      hero_primary_label:'Спросить, как начать', hero_primary_url:'#contact', hero_secondary_label:'Посмотреть пример', hero_secondary_url:'#example',
      hero_image:'/static/assets/landing/hero-b2c.webp',
      nav_json: JSON.stringify([{label:'Как работает',url:'#how',visible:true},{label:'Что внутри',url:'#features',visible:true},{label:'QR-код',url:'#qr',visible:true},{label:'Вопросы',url:'#faq',visible:true}]),
      contacts_json: JSON.stringify([{type:'phone',label:company.phone||'+7 000 000-00-00',url:company.phone ? 'tel:' + String(company.phone).replace(/[^+\d]/g,'') : 'tel:+70000000000',visible:true}]),
      faq_json: JSON.stringify([{q:'Можно ли менять страницу после публикации?',a:'Да. Менеджер может редактировать тексты, фото, контакты и статус публикации в админке.',visible:true}]),
      blocks_json: JSON.stringify({featuresVisible:true,qrVisible:true,faqVisible:true,contactsVisible:true})
    });
}
function businessStats(companyId){
  return {
    pages: db.prepare('SELECT COUNT(*) c FROM memorials WHERE company_id=?').get(companyId).c,
    published: db.prepare("SELECT COUNT(*) c FROM memorials WHERE company_id=? AND status='published'").get(companyId).c,
    views: db.prepare('SELECT COUNT(*) c FROM analytics_events WHERE company_id=?').get(companyId).c,
    qr: db.prepare("SELECT COUNT(*) c FROM analytics_events WHERE company_id=? AND event_type LIKE 'qr%'").get(companyId).c
  };
}
function audit(req, action, objectType, objectId, objectName, meta={}){
  const m=req.session.manager;
  const scopedMeta = { ...(meta || {}) };
  if(m?.impersonator_id){
    scopedMeta.impersonation = {
      real_user_id: m.impersonator_id,
      real_role: m.impersonator_role,
      acting_business_id: m.acting_business_id || m.company_id || null
    };
  }
  log(m?.id, m?.company_id, action, objectType, objectId, objectName, scopedMeta);
}


function notificationLog(companyId, relatedType, relatedId, channel, eventType, recipient, subject, body, status='pending', error='', options={}){
  try{
    const info = db.prepare(`INSERT INTO notification_log (company_id,related_type,related_id,channel,event_type,recipient,subject,body,status,error,sent_at,priority,action_url,actor_manager_id)
      VALUES (@company_id,@related_type,@related_id,@channel,@event_type,@recipient,@subject,@body,@status,@error,@sent_at,@priority,@action_url,@actor_manager_id)`).run({
      company_id: companyId || null,
      related_type: relatedType || null,
      related_id: relatedId || null,
      channel, event_type:eventType, recipient:recipient || '', subject:subject || '', body:body || '', status, error:error || '', sent_at: status === 'sent' ? new Date().toISOString() : null,
      priority: options.priority || 'normal',
      action_url: options.actionUrl || options.action_url || '',
      actor_manager_id: options.actorManagerId || options.actor_manager_id || null
    });
    return info.lastInsertRowid;
  }catch(e){ return null; }
}
function systemEvent(companyId, eventType, subject, body='', options={}){
  return notificationLog(companyId, options.relatedType || null, options.relatedId || null, 'system', eventType, options.recipient || '', subject, body, 'sent', '', {
    priority: options.priority || 'normal',
    actionUrl: options.actionUrl || '',
    actorManagerId: options.actorManagerId || null
  });
}
function eventTypeLabel(type){
  return ({
    new_submission:'Новая заявка семьи',
    submission_status_changed:'Статус CRM изменён',
    submission_assigned:'Назначен ответственный',
    family_contact_logged:'Контакт с семьёй',
    new_memory:'Новое воспоминание',
    memorial_published:'Страница опубликована',
    memorial_created:'Страница памяти создана',
    landing_version_restored:'Версия лендинга восстановлена',
    memorial_version_restored:'Версия страницы восстановлена',
    backup_restore_preview:'Предпросмотр восстановления',
    backup_restored:'Backup восстановлен',
    backup_restore_failed:'Ошибка восстановления',
    test:'Тест уведомлений'
  })[type] || type;
}
function eventPriorityLabel(priority){ return ({low:'Низкий',normal:'Обычный',high:'Высокий',urgent:'Срочно'})[priority||'normal'] || 'Обычный'; }
function eventRowHtml(e, includeCompany=false){
  const read = e.read_at ? 'read' : 'unread';
  const company = includeCompany ? `<td>${h(e.company_name || '')}</td>` : '';
  const action = e.action_url ? `<a href="${h(e.action_url)}">Открыть</a>` : '—';
  return `<tr class="event-row ${read}"><td>${h(formatDate(e.created_at))}</td>${company}<td><span class="priority-badge ${h(e.priority||'normal')}">${h(eventPriorityLabel(e.priority))}</span></td><td><b>${h(eventTypeLabel(e.event_type))}</b><br><small>${h(e.subject||'')}</small></td><td>${h(e.body||'')}</td><td>${h(e.status)}</td><td>${action}</td></tr>`;
}
async function sendTelegram(company, subject, body){
  const token = company.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = company.telegram_chat_id || process.env.TELEGRAM_CHAT_ID;
  if(!company.notify_telegram_enabled || !token || !chatId) return { skipped:true, reason:'Telegram не настроен' };
  const text = `<b>${escapeTelegram(subject)}</b>\n\n${escapeTelegram(body)}`;
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ chat_id: chatId, text, parse_mode:'HTML', disable_web_page_preview:true })
  });
  if(!response.ok) throw new Error(`Telegram HTTP ${response.status}: ${await response.text()}`);
  return { sent:true };
}
function escapeTelegram(s=''){
  return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
}
async function sendEmail(company, to, subject, body){
  if(!company.notify_email_enabled || !to) return { skipped:true, reason:'Email не настроен' };
  const smtpHost = company.smtp_host || process.env.SMTP_HOST;
  if(!smtpHost) return { skipped:true, reason:'SMTP_HOST не задан' };
  let nodemailer;
  try { nodemailer = require('nodemailer'); } catch(e) { throw new Error('Не установлен nodemailer. Выполните npm install.'); }
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: Number(company.smtp_port || process.env.SMTP_PORT || 587),
    secure: Boolean(Number(company.smtp_secure || process.env.SMTP_SECURE || 0)),
    auth: (company.smtp_user || process.env.SMTP_USER) ? { user: company.smtp_user || process.env.SMTP_USER, pass: company.smtp_pass || process.env.SMTP_PASS } : undefined
  });
  const from = company.notification_from_email || process.env.SMTP_FROM || company.email || process.env.SMTP_USER;
  if(!from) return { skipped:true, reason:'Адрес отправителя не задан' };
  await transporter.sendMail({
    from: `${process.env.NOTIFICATIONS_FROM_NAME || company.name || 'Память QR'} <${from}>`,
    to, subject, text: body,
    replyTo: company.notification_reply_to || company.email || undefined
  });
  return { sent:true };
}
async function notifyCompany(companyId, eventType, subject, body, options={}){
  const company = typeof companyId === 'object' ? companyId : db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
  if(!company || !company.notifications_enabled) return;
  const relatedType = options.relatedType || null;
  const relatedId = options.relatedId || null;
  const managerEmail = options.toManager || company.manager_notification_email || company.email;
  if(options.email !== false){
    const rowId = notificationLog(company.id, relatedType, relatedId, 'email', eventType, managerEmail, subject, body, 'pending', '', options);
    try{
      const result = await sendEmail(company, managerEmail, subject, body);
      db.prepare('UPDATE notification_log SET status=?, error=?, sent_at=? WHERE id=?').run(result.skipped?'skipped':'sent', result.reason||'', result.skipped?null:new Date().toISOString(), rowId);
    }catch(e){ db.prepare('UPDATE notification_log SET status=?, error=? WHERE id=?').run('failed', e.message, rowId); }
  }
  if(options.telegram !== false){
    const rowId = notificationLog(company.id, relatedType, relatedId, 'telegram', eventType, company.telegram_chat_id || process.env.TELEGRAM_CHAT_ID, subject, body, 'pending', '', options);
    try{
      const result = await sendTelegram(company, subject, body);
      db.prepare('UPDATE notification_log SET status=?, error=?, sent_at=? WHERE id=?').run(result.skipped?'skipped':'sent', result.reason||'', result.skipped?null:new Date().toISOString(), rowId);
    }catch(e){ db.prepare('UPDATE notification_log SET status=?, error=? WHERE id=?').run('failed', e.message, rowId); }
  }
}
async function notifyFamily(companyId, email, subject, body, relatedType, relatedId){
  const company = db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
  if(!company || !email) return;
  const rowId = notificationLog(company.id, relatedType, relatedId, 'email', 'family_approved', email, subject, body, 'pending', '', { priority:'normal', actionUrl: relatedType === 'submission' ? `/admin/submissions/${relatedId}` : '' });
  try{
    const result = await sendEmail(company, email, subject, body);
    db.prepare('UPDATE notification_log SET status=?, error=?, sent_at=? WHERE id=?').run(result.skipped?'skipped':'sent', result.reason||'', result.skipped?null:new Date().toISOString(), rowId);
  }catch(e){ db.prepare('UPDATE notification_log SET status=?, error=? WHERE id=?').run('failed', e.message, rowId); }
}
function notifySubmissionCreated(company, submissionId, fullName, contact){
  if(!company.notify_on_new_submission) return;
  notifyCompany(company, 'new_submission', `Новая заявка семьи: ${fullName}`, `В админку поступили материалы для страницы памяти.\n\nФИО: ${fullName}\nКонтакт: ${contact || 'не указан'}\nОткрыть: ${BASE_URL}/admin/submissions/${submissionId}`, { relatedType:'submission', relatedId:submissionId }).catch(()=>{});
}
function notifyNewMemory(company, memorial, memoryId, author, text){
  if(!company.notify_on_new_memory) return;
  notifyCompany(company, 'new_memory', `Новое воспоминание: ${memorial.full_name}`, `На странице памяти оставили новые слова.\n\nАвтор: ${author || 'не указан'}\nТекст: ${String(text||'').slice(0,500)}\n\nОткройте страницу в админке, чтобы проверить и одобрить.`, { relatedType:'memory', relatedId:memoryId }).catch(()=>{});
}
function notifyPublished(company, memorial){
  if(!company.notify_on_publish) return;
  notifyCompany(company, 'memorial_published', `Страница опубликована: ${memorial.full_name}`, `Страница памяти опубликована.\n\nСсылка: ${publicMemorialUrl(company, memorial)}`, { relatedType:'memorial', relatedId:memorial.id }).catch(()=>{});
}


function landingSnapshot(id){
  return db.prepare('SELECT * FROM landing_pages WHERE id=?').get(id);
}
function memorialSnapshot(id){
  const memorial = db.prepare('SELECT * FROM memorials WHERE id=?').get(id);
  if(!memorial) return null;
  return {
    memorial,
    memories: db.prepare('SELECT * FROM memorial_memories WHERE memorial_id=? ORDER BY sort_order,id').all(id),
    qualities: db.prepare('SELECT * FROM memorial_qualities WHERE memorial_id=? ORDER BY sort_order,id').all(id),
    milestones: db.prepare('SELECT * FROM memorial_milestones WHERE memorial_id=? ORDER BY sort_order,id').all(id),
    photos: db.prepare('SELECT * FROM memorial_photos WHERE memorial_id=? ORDER BY sort_order,id').all(id)
  };
}
function savePageVersion(req, objectType, objectId, snapshot, reason='manual_save'){
  if(!snapshot) return;
  db.prepare('INSERT INTO page_versions (object_type,object_id,snapshot_json,created_by) VALUES (?,?,?,?)')
    .run(objectType, objectId, JSON.stringify({ reason, snapshot }), req.session.manager?.id || null);
}
function versionLabel(v){
  const parsed = asJson(v.snapshot_json, null);
  const reason = parsed?.reason || 'manual_save';
  const labels = { manual_save:'сохранение', publish:'публикация', hide:'скрытие', archive:'архивирование', restore:'восстановление' };
  return labels[reason] || reason;
}
function versionSnapshot(v){
  const parsed = asJson(v.snapshot_json, null);
  if(parsed && parsed.snapshot) return parsed.snapshot;
  return parsed || {};
}
function requireCompanyLanding(req, id){
  const company = currentCompany(req);
  const landing = db.prepare('SELECT * FROM landing_pages WHERE id=? AND company_id=?').get(id, company.id);
  return { company, landing };
}
function requireCompanyMemorial(req, id){
  const company = currentCompany(req);
  const memorial = db.prepare('SELECT * FROM memorials WHERE id=? AND company_id=?').get(id, company.id);
  return { company, memorial };
}
function restoreLandingFromSnapshot(landingId, snapshot){
  const l = snapshot?.company_id ? snapshot : snapshot?.landing;
  if(!l) throw new Error('В этой версии нет данных лендинга');
  db.prepare(`UPDATE landing_pages SET status=@status, seo_title=@seo_title, seo_description=@seo_description, og_image=@og_image,
    preloader_title=@preloader_title, hero_title=@hero_title, hero_subtitle=@hero_subtitle,
    hero_primary_label=@hero_primary_label, hero_primary_url=@hero_primary_url,
    hero_secondary_label=@hero_secondary_label, hero_secondary_url=@hero_secondary_url, hero_image=@hero_image,
    nav_json=@nav_json, blocks_json=@blocks_json, contacts_json=@contacts_json, faq_json=@faq_json,
    tracking_json=@tracking_json, theme_json=@theme_json, version=version+1, updated_at=CURRENT_TIMESTAMP
    WHERE id=@id`).run({
      id: landingId,
      status: l.status || 'draft',
      seo_title: l.seo_title || '', seo_description: l.seo_description || '', og_image: l.og_image || null,
      preloader_title: l.preloader_title || '', hero_title: l.hero_title || '', hero_subtitle: l.hero_subtitle || '',
      hero_primary_label: l.hero_primary_label || '', hero_primary_url: l.hero_primary_url || '',
      hero_secondary_label: l.hero_secondary_label || '', hero_secondary_url: l.hero_secondary_url || '',
      hero_image: l.hero_image || null,
      nav_json: l.nav_json || '[]', blocks_json: l.blocks_json || '{}', contacts_json: l.contacts_json || '[]', faq_json: l.faq_json || '[]',
      tracking_json: l.tracking_json || '{}', theme_json: l.theme_json || '{}'
    });
}
function restoreMemorialFromSnapshot(memorialId, snapshot){
  const m = snapshot?.memorial || snapshot;
  if(!m || !m.full_name) throw new Error('В этой версии нет данных страницы памяти');
  db.prepare(`UPDATE memorials SET full_name=@full_name, slug=@slug, birth_date=@birth_date, death_date=@death_date,
    quote=@quote, epitaph=@epitaph, biography=@biography, main_photo=@main_photo, album_cover_photo_id=@album_cover_photo_id,
    status=@status, privacy_status=@privacy_status, noindex=@noindex, consent_confirmed=@consent_confirmed,
    section_order_json=@section_order_json, hidden_sections_json=@hidden_sections_json, footer_text=@footer_text,
    theme_key=@theme_key, seo_title=@seo_title, seo_description=@seo_description, updated_at=CURRENT_TIMESTAMP
    WHERE id=@id`).run({
      id: memorialId,
      full_name: m.full_name || '', slug: m.slug || 'memory', birth_date: m.birth_date || '', death_date: m.death_date || '',
      quote: m.quote || 'Главное — держаться вместе.', epitaph: m.epitaph || '', biography: m.biography || '', main_photo: m.main_photo || '',
      album_cover_photo_id: m.album_cover_photo_id || null, status: m.status || 'draft', privacy_status: m.privacy_status || 'unlisted',
      noindex: Number(m.noindex ?? 1), consent_confirmed: Number(m.consent_confirmed ?? 0),
      section_order_json: m.section_order_json || '["hero","words","story","album","footer"]', hidden_sections_json: m.hidden_sections_json || '[]',
      footer_text: m.footer_text || '', theme_key: m.theme_key || 'classic', seo_title: m.seo_title || '', seo_description: m.seo_description || ''
    });
  if(Array.isArray(snapshot?.memories)){
    db.prepare('DELETE FROM memorial_memories WHERE memorial_id=?').run(memorialId);
    for(const x of snapshot.memories) db.prepare('INSERT INTO memorial_memories (memorial_id,text,author,relation,is_featured,status,sort_order) VALUES (?,?,?,?,?,?,?)').run(memorialId,x.text||'',x.author||'',x.relation||'',Number(x.is_featured||0),x.status||'approved',Number(x.sort_order||0));
  }
  if(Array.isArray(snapshot?.qualities)){
    db.prepare('DELETE FROM memorial_qualities WHERE memorial_id=?').run(memorialId);
    for(const x of snapshot.qualities) db.prepare('INSERT INTO memorial_qualities (memorial_id,title,description,icon_key,sort_order) VALUES (?,?,?,?,?)').run(memorialId,x.title||'',x.description||'',x.icon_key||'heart',Number(x.sort_order||0));
  }
  if(Array.isArray(snapshot?.milestones)){
    db.prepare('DELETE FROM memorial_milestones WHERE memorial_id=?').run(memorialId);
    for(const x of snapshot.milestones) db.prepare('INSERT INTO memorial_milestones (memorial_id,year,text,sort_order) VALUES (?,?,?,?)').run(memorialId,x.year||'',x.text||'',Number(x.sort_order||0));
  }
  if(Array.isArray(snapshot?.photos)){
    db.prepare('DELETE FROM memorial_photos WHERE memorial_id=?').run(memorialId);
    for(const x of snapshot.photos) db.prepare('INSERT INTO memorial_photos (memorial_id,original_path,preview_path,large_path,thumb_path,title,caption,photo_date,place,focus_x,focus_y,is_visible,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(memorialId,x.original_path||null,x.preview_path||'',x.large_path||'',x.thumb_path||'',x.title||'',x.caption||'',x.photo_date||'',x.place||'',Number(x.focus_x ?? .5),Number(x.focus_y ?? .5),Number(x.is_visible ?? 1),Number(x.sort_order||0));
  }
}
function diffRows(current, previous, fields){
  return fields.map(([key,label])=>{
    const a = current?.[key] ?? '';
    const b = previous?.[key] ?? '';
    const changed = String(a) !== String(b);
    return `<tr class="${changed?'changed':''}"><td>${h(label)}</td><td>${h(String(b).slice(0,600))}</td><td>${h(String(a).slice(0,600))}</td></tr>`;
  }).join('');
}
function versionReasonClass(v){
  const parsed = asJson(v.snapshot_json, null);
  const reason = parsed?.reason || 'manual_save';
  return String(reason).replace(/[^a-z0-9_-]/gi,'_');
}
function versionSnapshotEntity(v){
  const snap = versionSnapshot(v);
  if(v.object_type === 'landing') return snap.company_id ? snap : snap.landing;
  return snap.memorial || snap;
}
function versionSummaryText(v){
  const entity = versionSnapshotEntity(v) || {};
  if(v.object_type === 'landing') return [entity.hero_title, entity.hero_primary_label, entity.status].filter(Boolean).join(' · ') || 'снимок лендинга';
  return [entity.full_name, entity.status, entity.privacy_status].filter(Boolean).join(' · ') || 'снимок страницы памяти';
}
function versionStatsHtml(v){
  const snap = versionSnapshot(v);
  if(v.object_type === 'memorial' && Array.isArray(snap.memories)){
    return `<div class="version-pills"><span>${snap.memories.length} воспоминаний</span><span>${snap.qualities.length} качеств</span><span>${snap.milestones.length} моментов</span><span>${snap.photos.length} фото</span></div>`;
  }
  const entity = versionSnapshotEntity(v) || {};
  if(v.object_type === 'landing'){
    const nav = asJson(entity.nav_json, []), contacts = asJson(entity.contacts_json, []), faq = asJson(entity.faq_json, []);
    return `<div class="version-pills"><span>${nav.length} пунктов меню</span><span>${contacts.length} контактов</span><span>${faq.length} FAQ</span><span>${h(entity.status||'draft')}</span></div>`;
  }
  return '';
}
function versionRow(v, label, url){
  return `<tr><td>${h(v.created_at)}</td><td><span class="version-reason ${h(versionReasonClass(v))}">${h(versionLabel(v))}</span></td><td><b>${h(label)}</b><br><small>${h(versionSummaryText(v)).slice(0,180)}</small>${versionStatsHtml(v)}</td><td><a href="${h(url)}">сравнить / восстановить</a></td></tr>`;
}
function versionPreviewCard(title, fields){
  return `<section class="panel version-preview-card"><h2>${h(title)}</h2><div class="version-preview-grid">${fields.map(([label,value])=>`<div><small>${h(label)}</small><b>${h(String(value||'').slice(0,260)) || '—'}</b></div>`).join('')}</div></section>`;
}

function sha(value){ return crypto.createHash('sha256').update(String(value || '') + (process.env.ANALYTICS_SALT || 'pamyatqr-analytics')).digest('hex').slice(0, 32); }
function cookieValue(req, name){
  const raw = req.headers.cookie || '';
  const found = raw.split(';').map(s=>s.trim()).find(s=>s.startsWith(name + '='));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : '';
}
function publicVisitorKey(req, res){
  let key = cookieValue(req, 'pamyatqr_vid');
  if(!/^[a-f0-9]{24,64}$/i.test(key || '')){
    key = crypto.randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie', `pamyatqr_vid=${key}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
  }
  return key;
}
function writeAnalytics(req, res, data){
  const visitorKey = data.visitor_key || publicVisitorKey(req, res);
  const partnerRow = data.company_id ? db.prepare('SELECT partner_id FROM companies WHERE id=?').get(data.company_id) : null;
  db.prepare(`INSERT INTO analytics_events (company_id, partner_id, memorial_id, landing_id, event_type, visitor_key, ip_hash, user_agent_hash, referrer, path, meta)
    VALUES (@company_id,@partner_id,@memorial_id,@landing_id,@event_type,@visitor_key,@ip_hash,@user_agent_hash,@referrer,@path,@meta)`).run({
      company_id: data.company_id || null,
      partner_id: data.partner_id || partnerRow?.partner_id || null,
      memorial_id: data.memorial_id || null,
      landing_id: data.landing_id || null,
      event_type: String(data.event_type || 'event').slice(0, 80),
      visitor_key: visitorKey,
      ip_hash: sha(req.ip || req.socket?.remoteAddress || ''),
      user_agent_hash: sha(req.get('user-agent') || ''),
      referrer: String(data.referrer || req.get('referer') || '').slice(0, 500),
      path: String(data.path || req.path || '').slice(0, 500),
      meta: JSON.stringify(data.meta || {})
    });
}


function ensureDemoContent(){
  let company = db.prepare('SELECT * FROM companies ORDER BY id LIMIT 1').get();
  if(!company){
    const pass = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'change-me', 10);
    const info = db.prepare(`INSERT INTO companies (name,slug,city,phone,email,telegram_url,whatsapp_url,contact_label,footer_text,legal_name,data_contact,data_email,privacy_url,accent_color)
      VALUES ('Память QR','pamyat-qr','Москва','+7 000 000-00-00','hello@example.ru','https://t.me/pamyat_qr','https://wa.me/70000000000','Связаться','Страница создана при поддержке Память QR','ООО Память QR','Администратор','privacy@example.ru','', '#B47A3D')`).run();
    db.prepare('INSERT INTO managers (company_id,login,password_hash) VALUES (?,?,?)').run(info.lastInsertRowid, process.env.ADMIN_LOGIN || 'manager', pass);
    company = db.prepare('SELECT * FROM companies WHERE id=?').get(info.lastInsertRowid);
  }

  const manager = db.prepare('SELECT * FROM managers WHERE company_id=? LIMIT 1').get(company.id);
  if(!manager){
    const pass = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'change-me', 10);
    db.prepare('INSERT INTO managers (company_id,login,password_hash) VALUES (?,?,?)').run(company.id, process.env.ADMIN_LOGIN || 'manager', pass);
  }

  let landing = db.prepare('SELECT * FROM landing_pages WHERE company_id=?').get(company.id);
  const landingPayload = {
    company_id: company.id,
    seo_title:'Память QR — страница памяти для семьи',
    seo_description:'Бережная цифровая страница памяти с QR-кодом, фото, словами близких и историей жизни.',
    preloader_title: company.name || 'Память QR',
    hero_title:'Страница памяти, которую можно открыть по QR-коду',
    hero_subtitle:'Семья сохраняет фотографии, слова и историю близкого человека на красивой личной странице.',
    hero_primary_label:'Спросить, как начать',
    hero_primary_url:'#contact',
    hero_secondary_label:'Посмотреть пример',
    hero_secondary_url:'#example',
    hero_image:'/static/assets/landing/hero-b2c.webp',
    nav_json: JSON.stringify([{label:'Как работает',url:'#how',visible:true},{label:'Что внутри',url:'#features',visible:true},{label:'QR-код',url:'#qr',visible:true},{label:'Вопросы',url:'#faq',visible:true}]),
    contacts_json: JSON.stringify([{type:'phone',label:'+7 000 000-00-00',url:'tel:+70000000000',visible:true},{type:'telegram',label:'Telegram',url:'https://t.me/pamyat_qr',visible:true},{type:'whatsapp',label:'WhatsApp',url:'https://wa.me/70000000000',visible:true}]),
    faq_json: JSON.stringify([{q:'Можно ли менять страницу после публикации?',a:'Да. Менеджер может редактировать тексты, фото, контакты и статус публикации в админке.',visible:true},{q:'Страница доступна в поиске?',a:'По умолчанию страница открывается только по личной ссылке и QR-коду. Индексацию можно включить отдельно.',visible:true},{q:'Можно ли добавить фотографии позже?',a:'Да. Альбом можно пополнять, менять порядок фото, подписи и обложку.',visible:true}]),
    blocks_json: JSON.stringify({featuresVisible:true,qrVisible:true,faqVisible:true,contactsVisible:true})
  };
  if(!landing){
    db.prepare(`INSERT INTO landing_pages (company_id,status,seo_title,seo_description,preloader_title,hero_title,hero_subtitle,hero_primary_label,hero_primary_url,hero_secondary_label,hero_secondary_url,hero_image,nav_json,contacts_json,faq_json,blocks_json)
      VALUES (@company_id,'published',@seo_title,@seo_description,@preloader_title,@hero_title,@hero_subtitle,@hero_primary_label,@hero_primary_url,@hero_secondary_label,@hero_secondary_url,@hero_image,@nav_json,@contacts_json,@faq_json,@blocks_json)`).run(landingPayload);
  }

  let memorial = db.prepare('SELECT * FROM memorials WHERE company_id=? AND slug=?').get(company.id, 'aleksey-orlov');
  if(!memorial){
    const public_token = shortToken();
    const info = db.prepare(`INSERT INTO memorials (uuid,company_id,full_name,slug,public_token,birth_date,death_date,quote,epitaph,biography,main_photo,status,privacy_status,noindex,consent_confirmed,footer_text,section_order_json,hidden_sections_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        uuidv4(), company.id, 'Алексей Николаевич Орлов', 'aleksey-orlov', public_token,
        '1951-03-14', '2023-08-22', 'Главное — держаться вместе.',
        'Любящий муж, отец и человек, который всегда держал слово.',
        'Алексей Николаевич родился в семье, где с детства ценили труд, честность и уважение к людям. Он умел работать руками, не боялся сложных дел и всегда доводил начатое до конца.\n\nДля родных он был человеком спокойной силы: рядом с ним было надёжно, понятно и тепло. Он любил семейные вечера, разговоры за столом, поездки на природу и особенно гордился детьми.\n\nЕго помнят как человека, который не любил громких слов, но всегда помогал делом. Его забота, чувство юмора и умение поддержать останутся в памяти семьи, друзей и всех, кто был рядом.',
        '/static/assets/memory/hero-portrait-bg.webp', 'published', 'unlisted', 1, 1,
        'Пусть тёплые слова и фотографии остаются здесь рядом.',
        JSON.stringify(['hero','words','story','album','footer']), JSON.stringify([])
      );
    const mid = info.lastInsertRowid;
    const memories = [
      ['approved',1,'От супруги','Он всегда говорил: «Главное — держаться вместе». Для нашей семьи эти слова остались правилом.'],
      ['approved',1,'От дочери','Папа умел успокоить одним взглядом. Рядом с ним всегда казалось, что всё будет хорошо.'],
      ['approved',0,'От сына','Он научил меня не обещать лишнего и отвечать за свои слова. Это останется со мной на всю жизнь.'],
      ['approved',0,'От друзей','Алексей был человеком, на которого можно было положиться. Если он сказал, что поможет, значит поможет.']
    ];
    memories.forEach((m,i)=>db.prepare('INSERT INTO memorial_memories (memorial_id,status,is_featured,author,text,sort_order) VALUES (?,?,?,?,?,?)').run(mid,m[0],m[1],m[2],m[3],i));
    [['Надёжный','Всегда держал слово и помогал делом.'],['Семейный','Больше всего ценил близких и домашнее тепло.'],['Спокойный','Умел поддержать без лишних слов.'],['Добрый','Помнил о людях и замечал, когда нужна помощь.']].forEach((q,i)=>db.prepare('INSERT INTO memorial_qualities (memorial_id,title,description,sort_order) VALUES (?,?,?,?)').run(mid,q[0],q[1],i));
    [['1951','Родился и вырос в семье, где ценили труд и честность.'],['1974','Создал семью и построил дом, куда всегда хотелось возвращаться.'],['1988','Семейные поездки и фотографии, которые теперь стали частью архива.'],['2023','Тёплая память о нём осталась с близкими.']].forEach((x,i)=>db.prepare('INSERT INTO memorial_milestones (memorial_id,year,text,sort_order) VALUES (?,?,?,?)').run(mid,x[0],x[1],i));
    const photoStmt = db.prepare('INSERT INTO memorial_photos (memorial_id,original_path,preview_path,large_path,thumb_path,title,caption,photo_date,place,focus_x,focus_y,is_visible,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    [1,2,3,4,5,6].forEach((n,i)=>{
      const p = `/static/assets/memory/album-${n}.jpg`;
      const titles = ['Семейное фото','Студенческие годы','На отдыхе с сыном','С друзьями','Прогулка в парке','Старые фотографии'];
      const dates = ['1988','1970-е','1995','1980-е','1992',''];
      photoStmt.run(mid,p,p,p,p,titles[i],titles[i],dates[i],'Семейный архив',0.5,0.5,1,i*10);
    });
    const cover = db.prepare('SELECT id FROM memorial_photos WHERE memorial_id=? ORDER BY sort_order LIMIT 1').get(mid);
    if(cover) db.prepare('UPDATE memorials SET album_cover_photo_id=? WHERE id=?').run(cover.id, mid);
  }
  // Нормализация старых demo-дат из формата dd.mm.yyyy в формат input[type=date].
  db.prepare("UPDATE memorials SET birth_date='1951-03-14' WHERE company_id=? AND slug='aleksey-orlov' AND birth_date='14.03.1951'").run(company.id);
  db.prepare("UPDATE memorials SET death_date='2023-08-22' WHERE company_id=? AND slug='aleksey-orlov' AND death_date='22.08.2023'").run(company.id);
}

function ensureSeed(){
  ensureDemoContent();
}
ensureSeed();

async function saveImage(file, bucket, options={}){
  if(!file) return null;
  const head = fs.readFileSync(file.path).subarray(0, 16);
  const isJpeg = head[0] === 0xff && head[1] === 0xd8;
  const isPng = head[0] === 0x89 && head.toString('ascii',1,4) === 'PNG';
  const isWebp = head.toString('ascii',0,4) === 'RIFF' && head.toString('ascii',8,12) === 'WEBP';
  const isHeic = head.toString('ascii',4,8) === 'ftyp';
  if(!(isJpeg || isPng || isWebp || isHeic)){
    try{ fs.unlinkSync(file.path); }catch{}
    throw new Error('Файл не похож на безопасное изображение.');
  }
  const ext = '.webp';
  const id = crypto.randomBytes(10).toString('hex');
  const dir = path.join(UPLOAD_ROOT, bucket);
  fs.mkdirSync(dir, {recursive:true});
  const base = path.join(dir, id);
  const image = sharp(file.path, { failOn: 'none', limitInputPixels: 80_000_000 }).rotate();
  const meta = await image.metadata();
  if(!meta.width || !meta.height) throw new Error('Не удалось прочитать изображение.');
  if(meta.width * meta.height > 80_000_000) throw new Error('Изображение слишком большое.');
  const warning = meta.width < (options.minWidth||700) || meta.height < (options.minHeight||500);
  const large = `${base}-large${ext}`;
  const preview = `${base}-preview${ext}`;
  const thumb = `${base}-thumb${ext}`;
  await sharp(file.path).rotate().resize({ width: 1800, height: 1800, fit:'inside', withoutEnlargement:true }).webp({quality:86}).toFile(large);
  await sharp(file.path).rotate().resize({ width: 980, height: 980, fit:'inside', withoutEnlargement:true }).webp({quality:84}).toFile(preview);
  await sharp(file.path).rotate().resize({ width: 360, height: 360, fit:'cover', position:'attention' }).webp({quality:80}).toFile(thumb);
  fs.unlinkSync(file.path);
  return { large: rel(large), preview: rel(preview), thumb: rel(thumb), width: meta.width, height: meta.height, warning };
}


function deleteUploadedFiles(...pathsToDelete){
  for(const publicPath of pathsToDelete.flat().filter(Boolean)){
    if(!String(publicPath).startsWith('/uploads/')) continue;
    const full = path.join(ROOT, String(publicPath).replace(/^\//,''));
    try{ if(full.startsWith(UPLOAD_ROOT) && fs.existsSync(full)) fs.unlinkSync(full); }catch{}
  }
}

function albumManagerHtml(memorial, photos){
  if(!memorial?.id) return '<div class="manager-tip"><b>Альбом появится после первого сохранения страницы.</b>Сначала сохраните страницу, затем можно будет менять порядок, подписи, видимость и обложку уже загруженных фотографий.</div>';
  if(!photos.length) return '<div class="manager-tip"><b>В альбоме пока нет загруженных фото.</b>Загрузите новые фотографии ниже. После сохранения здесь появится управление порядком, подписями, видимостью и обложкой альбома.</div>';
  return `<section class="album-manager" data-photo-manager>
    <div class="album-manager-head"><div><b>Загруженные фото альбома</b><span>Перетаскивайте карточки, редактируйте подписи, скрывайте фото и выбирайте обложку альбома.</span></div><small>${photos.length} фото</small></div>
    <div class="album-photo-list">
      ${photos.map((p,i)=>`<article class="album-photo-card" draggable="true" data-photo-card data-photo-id="${p.id}">
        <input type="hidden" name="existing_photo_id" value="${p.id}">
        <input type="hidden" name="photo_sort_${p.id}" value="${Number(p.sort_order ?? i)}" data-photo-sort>
        <div class="album-photo-thumb"><img src="${h(p.thumb_path)}" alt=""></div>
        <div class="album-photo-fields">
          ${input(`photo_title_${p.id}`,'Название фото',p.title||'')}
          ${input(`photo_date_${p.id}`,'Год / дата',p.photo_date||'')}
          ${input(`photo_place_${p.id}`,'Место / источник',p.place||'')}
          ${textarea(`photo_caption_${p.id}`,'Подпись',p.caption||'',3)}
          <label class="field"><span>Фокус X</span><input type="range" min="0" max="1" step="0.01" name="photo_focus_x_${p.id}" value="${Number(p.focus_x ?? .5)}"></label>
          <label class="field"><span>Фокус Y</span><input type="range" min="0" max="1" step="0.01" name="photo_focus_y_${p.id}" value="${Number(p.focus_y ?? .5)}"></label>
        </div>
        <div class="album-photo-actions">
          <label class="check"><input type="radio" name="album_cover_photo_id" value="${p.id}" ${Number(memorial.album_cover_photo_id)===Number(p.id)?'checked':''}><span>Обложка альбома</span></label>
          <label class="check"><input type="checkbox" name="photo_visible_${p.id}" value="1" ${p.is_visible?'checked':''}><span>Показывать</span></label>
          <button type="button" class="btn muted" data-photo-up>Выше</button>
          <button type="button" class="btn muted" data-photo-down>Ниже</button>
          <label class="check danger-check"><input type="checkbox" name="photo_delete_${p.id}" value="1"><span>Удалить</span></label>
        </div>
      </article>`).join('')}
    </div>
  </section>`;
}

function layout(req, title, body){
  const user = req.session.manager;
  const company = user ? currentCompany(req) : null;
  const roleLabel = user?.role === 'super_admin' ? 'главная админка' : user?.role === 'partner_admin' ? 'админка партнёра' : user?.role === 'business_owner' ? 'админка бизнеса' : 'админка менеджера';
  const platformNav = user?.role === 'super_admin' ? '<a href="/admin/platform">Платформа</a><a href="/admin/platform/partners">Партнёры</a><a href="/admin/platform/businesses">Бизнесы</a><a href="/admin/platform/analytics">Аналитика платформы</a><a href="/admin/platform/audit">Audit log</a><a href="/admin/platform/health">Health</a><a href="/admin/platform/release">Релиз</a><a href="/admin/platform/plans">Тарифы</a>' : '';
  const partnerNav = user?.role === 'partner_admin' ? '<a href="/admin/partner">Партнёр</a><a href="/admin/partner/businesses">Мои бизнесы</a><a href="/admin/partner/analytics">Аналитика партнёра</a><a href="/admin/partner/events">События</a><a href="/admin/partner/audit">Audit log</a>' : '';
  const businessProgress = company ? onboardingProgress(company) : {complete:true};
  const startNav = company && !businessProgress.complete ? '<a href="/admin/start">Быстрый запуск</a>' : '';
  const businessNav = company ? '<span class="nav-group-label">Работа каждый день</span><a href="/admin">Главная</a>'+startNav+'<a href="/admin/memorials">Страницы памяти</a><a href="/admin/crm">CRM-доска</a><a href="/admin/submissions">Заявки семьи</a><span class="nav-group-label">Настройка для семей</span><a href="/admin/landing">Лендинг для семей</a><a href="/admin/company">Компания</a><a href="/admin/deploy">Адрес сайта</a><a href="/admin/materials">Материалы</a><a href="/admin/help">Справка</a><span class="nav-group-label">Контроль и безопасность</span><a href="/admin/notifications">Уведомления</a><a href="/admin/versions">Версии</a><a href="/admin/analytics">Аналитика</a><a href="/admin/security">Безопасность</a><a href="/admin/backups">Экспорт и резервные копии</a><a href="/admin/plan">Тариф</a>' : '';
  const brand = company?.name || (user?.role === 'partner_admin' ? currentPartner(req)?.name : 'Память QR');
  const impersonationBanner = user?.impersonator_id ? `<div class="impersonation-banner"><strong>Режим помощи:</strong> вы работаете внутри бизнеса <b>${h(company?.name||'')}</b> как ${h(roleName(user.impersonator_role||user.role))}. Все действия логируются. <form method="post" action="/admin/impersonation/exit"><button class="btn muted">Выйти из бизнеса</button></form></div>` : '';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)}</title><meta name="csrf-token" content="${h(csrfToken(req))}"><link rel="stylesheet" href="/static/admin/admin.css"><script src="/static/admin/admin-editor.js" defer></script></head><body>
  <aside class="sidebar"><div class="brand"><b>${h(brand||'Память QR')}</b><span>${h(roleLabel)}</span></div><nav>
  ${platformNav}${partnerNav}${businessNav}</nav>
  <form method="post" action="/admin/logout"><button class="ghost">Выйти</button></form></aside><main class="main">${impersonationBanner}${body}</main></body></html>`;
}
function input(name,label,value='',type='text',hint=''){ const v = type === 'date' ? toIsoDate(value) : (value || ''); return `<label class="field"><span>${h(label)}</span><input type="${type}" name="${h(name)}" value="${h(v)}">${hint?`<em>${h(hint)}</em>`:''}</label>`; }
function textarea(name,label,value='',rows=5,hint=''){ return `<label class="field"><span>${h(label)}</span><textarea name="${h(name)}" rows="${rows}">${h(value||'')}</textarea>${hint?`<em>${h(hint)}</em>`:''}</label>`; }
function checkbox(name,label,checked){ return `<label class="check"><input type="checkbox" name="${h(name)}" value="1" ${checked?'checked':''}><span>${h(label)}</span></label>`; }
function select(name,label,value,opts){ return `<label class="field"><span>${h(label)}</span><select name="${h(name)}">${opts.map(o=>`<option value="${h(o[0])}" ${o[0]===value?'selected':''}>${h(o[1])}</option>`).join('')}</select></label>`; }

function safeScriptJson(data){
  return JSON.stringify(data)
    .replace(/</g,'\\u003c')
    .replace(/>/g,'\\u003e')
    .replace(/&/g,'\\u0026')
    .replace(/\u2028/g,'\\u2028')
    .replace(/\u2029/g,'\\u2029');
}
function onboardingChecklistHtml(c, stats={}){
  const progress = onboardingProgress(c, stats);
  if(progress.complete) return '';
  const steps = progress.steps.map((st)=>({
    ...st,
    hint: st.label === 'Данные компании' ? 'Название, город и телефон для семей.'
      : st.label === 'Первая страница памяти' ? 'ФИО, даты, фото и несколько слов о человеке.'
      : st.label === 'Публикация страницы' ? 'После публикации страницу можно открыть по ссылке.'
      : st.label === 'QR-комплект' ? 'QR-код для таблички, печати или макета.'
      : 'Ссылка, которую можно отправлять семьям.'
  }));
  const done = progress.done;
  return `<section class="panel onboarding-panel" data-hide-when-complete="1"><div class="onboarding-head"><div><h2>Начало работы</h2><p>Эти подсказки исчезнут, когда запуск будет завершён.</p></div><b>${done} из ${steps.length}</b></div><div class="onboarding-progress"><span style="width:${Math.round(done/steps.length*100)}%"></span></div><div class="onboarding-steps">${steps.map((st,i)=>`<a class="onboarding-step ${st.done?'done':''}" href="${h(st.href)}"><strong>${st.done?'✓':'□'} ${i+1}. ${h(st.label)}</strong><span>${h(st.hint)}</span></a>`).join('')}</div></section>`;
}


function onboardingProgress(c, stats={}){
  if(!c?.id) return {done:0,total:5,complete:false,steps:[]};
  const hasCompany = !!(String(c?.name||'').trim() && String(c?.phone||c?.email||'').trim());
  const hasMemorial = Number(stats.memorials ?? db.prepare('SELECT COUNT(*) c FROM memorials WHERE company_id=?').get(c.id).c) > 0;
  const hasPublished = Number(stats.published ?? db.prepare("SELECT COUNT(*) c FROM memorials WHERE company_id=? AND status='published'").get(c.id).c) > 0;
  const hasQr = hasPublished; // QR-комплект создаётся/скачивается из опубликованной страницы, не держим обучающие плашки после публикации.
  const hasAddress = !!String(c?.slug||'').trim();
  const steps = [
    {done:hasCompany, label:'Данные компании', href:'/admin/company'},
    {done:hasMemorial, label:'Первая страница памяти', href:'/admin/memorials/new'},
    {done:hasPublished, label:'Публикация страницы', href:'/admin/memorials'},
    {done:hasQr, label:'QR-комплект', href:'/admin/memorials'},
    {done:hasAddress, label:'Адрес для семей', href:'/admin/deploy'}
  ];
  const done = steps.filter(x=>x.done).length;
  return {done,total:steps.length,complete:done===steps.length,steps};
}


function managerCommandCenterHtml(c, stats={}){
  const published = Number(stats.published||0);
  const memorials = Number(stats.memorials||0);
  const newSubmissions = Number(stats.new_submissions||0);
  const address = easyAddress(c);
  const next = !String(c?.phone||c?.email||'').trim()
    ? ['Заполнить данные компании','/admin/company','Сначала укажите телефон, город и название.']
    : !memorials
      ? ['Создать первую страницу памяти','/admin/memorials/new','Добавьте ФИО, фото и историю жизни.']
      : !published
        ? ['Опубликовать страницу','/admin/memorials','Откройте список страниц и нажмите публикацию у нужной страницы.']
        : ['Работа готова','/admin/materials','Можно создавать новые страницы и передавать семье ссылку или QR.'];
  return `<section class="panel manager-command-center"><div class="manager-command-main"><span class="guided-step-kicker">Рабочий стол менеджера</span><h2>Что сделать сейчас</h2><p>${h(next[2])}</p><div class="actions"><a class="btn" href="${h(next[1])}">${h(next[0])}</a>${onboardingProgress(c, stats).complete ? '' : '<a class="btn muted" href="/admin/start">Открыть быстрый запуск</a>'}</div></div><div class="manager-quick-actions"><a href="/admin/memorials/new"><b>Создать страницу памяти</b><span>ФИО, фото, история, публикация</span></a><a href="/admin/landing"><b>Лендинг для семей</b><span>Проверить первый экран и контакты</span></a><a href="/admin/memorials"><b>QR-комплект</b><span>Открыть публикацию страницы</span></a><a href="/admin/crm"><b>Заявки семьи</b><span>${newSubmissions ? h(String(newSubmissions))+' новых' : 'Открыть CRM-доску'}</span></a></div><p class="manager-command-address">Адрес для семей: <a href="${h(landingUrl(c))}" target="_blank">${h(address)}</a></p></section>`;
}

function managerPlainHelpHtml(req){
  return layout(req,'Справка для менеджера',`<div class="top"><h1>Справка для менеджера</h1></div>
    <section class="panel manager-help"><h2>Как получить готовую страницу и QR</h2><ol><li><b>Компания</b><span>Проверьте название, город, телефон и логотип.</span><a href="/admin/company">Открыть компанию</a></li><li><b>Лендинг для семей</b><span>Это общая страница услуги. Семья видит её до заказа.</span><a href="/admin/landing">Открыть лендинг</a></li><li><b>Страница памяти</b><span>Создайте страницу конкретного человека: фото, даты, история.</span><a href="/admin/memorials/new">Создать страницу</a></li><li><b>Публикация и QR</b><span>После проверки нажмите публикацию и скачайте QR-комплект.</span><a href="/admin/memorials">Открыть список</a></li><li><b>Адрес сайта</b><span>Адрес для семей уже работает. Можно выбрать понятную короткую ссылку после слэша.</span><a href="/admin/deploy">Проверить адрес</a></li></ol></section>
    <section class="panel"><h2>Что можно не трогать каждый день</h2><div class="manager-simple-grid"><div><b>Версии</b><span>Нужны, если надо вернуть старый вариант лендинга.</span></div><div><b>Безопасность</b><span>Для проверки входов и действий пользователей.</span></div><div><b>Экспорт и резервные копии</b><span>Для выгрузки CRM, страниц памяти и backup.</span></div><div><b>Поисковые системы</b><span>Обычно можно оставить как есть.</span></div></div></section>
    <section class="panel"><h2>Примеры для показа</h2><div class="materials-links"><a href="/demo/families" target="_blank"><b>Пример страницы для семьи</b><span>Как семья увидит услугу до заказа</span></a><a href="/demo/memory" target="_blank"><b>Пример страницы памяти</b><span>Фото, история, свеча и QR-сценарий</span></a><a href="/demo/b2b" target="_blank"><b>Пример B2B-страницы</b><span>Общая презентация сервиса для партнёров</span></a></div></section>`);
}


function clientMaterialsHtml(req){
  const c = currentCompany(req) || {};
  const publicName = publicBrandNameFor(c, c.name || 'Память QR');
  const address = easyAddress(c);
  const landing = landingUrl(c);
  const phone = c.phone || 'телефон компании';
  const email = c.email || 'email компании';
  const managerChecklist = [
    ['2. Проверьте «Лендинг для семей»', 'Это общая страница услуги. Здесь семья понимает, что такое страница памяти.'],
    ['3. Создайте «Страницу памяти»', 'Добавьте ФИО, даты, фотографию и короткую историю жизни.'],
    ['4. Нажмите «Опубликовать»', 'После публикации страница откроется по ссылке и QR-коду.'],
    ['5. Скачайте QR-комплект', 'Файл можно отправить дизайнеру, распечатать или использовать для таблички.']
  ];
  const familyText = `Здравствуйте. Мы можем создать страницу памяти для вашего близкого человека. На странице можно сохранить фотографии, историю жизни, важные даты и тёплые слова семьи. Страница открывается по QR-коду без установки приложения.`;
  const qrText = `Наведите камеру телефона на QR-код. Откроется страница памяти с фотографиями, историей жизни и воспоминаниями семьи.`;
  return layout(req,'Материалы для работы',`<div class="top"><h1>Материалы для работы</h1><div><button class="btn" type="button" onclick="window.print()">Распечатать</button></div></div>
    <section class="panel materials-hero"><div><span class="guided-step-kicker">Для менеджера</span><h2>Готовые подсказки для общения с семьёй</h2><p>Эту страницу можно открыть перед разговором, распечатать или отправить новому сотруднику. Здесь нет технических настроек — только то, что помогает быстро объяснить услугу.</p></div><div class="materials-company"><b>${h(publicName)}</b><span>${h(address)}</span><small>${h(phone)} · ${h(email)}</small></div></section>
    <section class="panel materials-section"><h2>Короткая инструкция менеджеру</h2><div class="materials-steps">${managerChecklist.map((it)=>`<article><b>${h(it[0])}</b><span>${h(it[1])}</span></article>`).join('')}</div></section>
    <section class="panel materials-section"><h2>Как объяснить услугу семье</h2><div class="copy-card"><p>${h(familyText)}</p><button class="btn muted" type="button" data-copy-text="${h(familyText)}">Скопировать текст</button></div><div class="copy-card"><h3>Текст рядом с QR-кодом</h3><p>${h(qrText)}</p><button class="btn muted" type="button" data-copy-text="${h(qrText)}">Скопировать текст</button></div></section>
    <section class="panel materials-section"><h2>Что попросить у семьи</h2><div class="materials-grid"><div><b>Фотографии</b><span>1–5 фотографий достаточно для первой версии.</span></div><div><b>Даты</b><span>Дата рождения и дата ухода, если семья готова их указать.</span></div><div><b>История жизни</b><span>Короткий текст: где жил, чем занимался, что было важно.</span></div><div><b>Слова близких</b><span>Можно добавить сейчас или позже после публикации.</span></div></div></section>
    <section class="panel materials-section"><h2>Готовые ссылки</h2><div class="materials-links"><a href="${h(landing)}" target="_blank"><b>Открыть лендинг для семей</b><span>${h(landing)}</span></a><a href="/admin/memorials/new"><b>Создать страницу памяти</b><span>Начать новую страницу для семьи</span></a><a href="/admin/help"><b>Открыть справку</b><span>Пошаговое объяснение разделов</span></a><a href="/demo/families" target="_blank"><b>Пример для семьи</b><span>Публичная B2C-страница услуги</span></a><a href="/demo/memory" target="_blank"><b>Пример страницы памяти</b><span>Готовый вид после QR-кода</span></a></div></section>
    <script>document.addEventListener('click', async (e)=>{ const b=e.target.closest('[data-copy-text]'); if(!b) return; try{ await navigator.clipboard.writeText(b.dataset.copyText||''); b.textContent='Скопировано'; setTimeout(()=>b.textContent='Скопировать текст',1400); }catch(err){ b.textContent='Скопируйте вручную'; } });</script>`);
}

function technicalPageNotice(title, text){
  return `<section class="panel manager-technical-note"><span class="guided-step-kicker">Необязательный раздел</span><h2>${h(title)}</h2><p>${h(text)}</p><a class="btn muted" href="/admin/start">Вернуться к быстрому запуску</a></section>`;
}

function stepGuideHtml(key, c, data={}){
  if(c && c.id && onboardingProgress(c).complete) return '';
  const guides = {
    dashboard: {
      step:'Старт',
      title:'С чего начать',
      text:'Сначала проверьте данные компании. Потом настройте лендинг для семей, создайте первую страницу памяти и скачайте QR-код.',
      actions:[['Открыть компанию','/admin/company'],['Перейти к лендингу','/admin/landing']]
    },
    company: {
      step:'Шаг 1 из 5',
      title:'Заполните данные компании',
      text:'Укажите название, город, телефон и логотип. Эти данные будут видеть семьи на лендинге и страницах памяти.',
      actions:[['После сохранения перейти к лендингу','/admin/landing']]
    },
    landing: {
      step:'Шаг 2 из 5',
      title:'Настройте лендинг для семей',
      text:'Это страница, где семья поймёт, что такое QR-код памяти и как связаться с вашей компанией. Заполните главный заголовок, кнопки и контакты.',
      actions:[['Сохранить и открыть страницы памяти','/admin/memorials'],['Предпросмотр лендинга','/admin/landing/preview']]
    },
    memorials_empty: {
      step:'Шаг 3 из 5',
      title:'Создайте первую страницу памяти',
      text:'Нажмите «Создать», добавьте ФИО, даты, фото и историю. После сохранения появится предпросмотр и QR-код.',
      actions:[['Создать страницу памяти','/admin/memorials/new']]
    },
    memorials_ready: {
      step:'Шаг 4 из 5',
      title:'Проверьте публикацию и QR-код',
      text:'Откройте страницу памяти, проверьте тексты и фото. Затем зайдите в публикацию и скачайте QR-комплект.',
      actions:[['Создать ещё страницу','/admin/memorials/new']]
    },
    memorial_new: {
      step:'Шаг 3 из 5',
      title:'Заполните страницу памяти',
      text:'Начните с ФИО, дат, главного фото, эпитафии и истории. Чтобы опубликовать страницу, обязательно подтвердите согласие семьи.',
      actions:[['Вернуться к списку страниц','/admin/memorials']]
    },
    memorial_edit: {
      step:'Шаг 4 из 5',
      title:'Проверьте страницу и подготовьте QR',
      text:'Слева редактирование, справа предпросмотр. Сохраните изменения, затем откройте «Публикация» или «QR/PDF».',
      actions:[['Открыть публикацию', data.publishHref || '#'],['Открыть QR/PDF', data.qrHref || '#']]
    },
    deploy: {
      step:'Шаг 5 из 5',
      title:'Проверьте адрес сайта',
      text:'Для старта можно пользоваться бесплатным адресом. Свой домен подключайте позже, если есть технический специалист.',
      actions:[['Открыть лендинг','/l/'+h(c?.slug||'pamyat-qr')],['Вернуться на главную','/admin']]
    }
  };
  const g = guides[key];
  if(!g) return '';
  return `<section class="panel guided-step" data-guided-step="${h(key)}"><div class="guided-step-kicker">${h(g.step)}</div><div class="guided-step-body"><div><h2>${h(g.title)}</h2><p>${h(g.text)}</p></div><div class="guided-actions">${(g.actions||[]).map(([label,href],i)=>`<a class="btn ${i?'muted':''}" href="${h(href)}">${h(label)}</a>`).join('')}</div></div></section>`;
}


function quickStartStatus(company){
  const cid = company.id;
  const memorials = db.prepare('SELECT COUNT(*) c FROM memorials WHERE company_id=?').get(cid).c;
  const published = db.prepare("SELECT COUNT(*) c FROM memorials WHERE company_id=? AND status='published'").get(cid).c;
  const qrReady = db.prepare("SELECT COUNT(*) c FROM memorials WHERE company_id=? AND status='published' AND qr_png_path IS NOT NULL AND qr_png_path<>''").get(cid).c;
  const landing = db.prepare('SELECT * FROM landing_pages WHERE company_id=?').get(cid);
  return {
    companyReady: !!(String(company.name||'').trim() && String(company.phone||company.email||'').trim()),
    landingReady: !!(landing && String(landing.hero_title||'').trim() && String(landing.hero_primary_label||'').trim()),
    memorials,
    published,
    qrReady,
    addressReady: !!(String(company.custom_domain||'').trim() || String(company.slug||'').trim()),
    landing
  };
}
function quickStartHtml(req){
  const c = currentCompany(req);
  const st = quickStartStatus(c);
  const items = [
    {done:st.companyReady, n:1, title:'Проверьте данные компании', text:'Название, город, телефон и логотип — это видят семьи.', href:'/admin/company', action:'Открыть данные компании'},
    {done:st.landingReady, n:2, title:'Настройте лендинг для семей', text:'Объясните простыми словами, что семья получит после сканирования QR-кода.', href:'/admin/landing', action:'Открыть лендинг'},
    {done:st.memorials>0, n:3, title:'Создайте первую страницу памяти', text:'Добавьте ФИО, даты, фото, историю и воспоминания.', href:'/admin/memorials/new', action:'Создать страницу'},
    {done:st.published>0, n:4, title:'Опубликуйте страницу и скачайте QR', text:'После публикации можно получить QR-код для печати или таблички.', href:'/admin/memorials', action:'Открыть страницы памяти'},
    {done:st.addressReady, n:5, title:'Проверьте адрес сайта', text:'Для старта достаточно бесплатного адреса. Свой домен можно подключить позже.', href:'/admin/deploy', action:'Открыть адрес сайта'}
  ];
  const done = items.filter(x=>x.done).length;
  const next = items.find(x=>!x.done) || items[items.length-1];
  const publicLanding = `/l/${c.slug}`;
  return layout(req,'Быстрый запуск',`<div class="top"><div><h1>Быстрый запуск</h1><p>Путь для менеджера: от данных компании до первой опубликованной страницы памяти и QR-кода.</p></div><a class="btn" href="${h(next.href)}">Продолжить: ${h(next.action)}</a></div>
    <section class="panel quick-start-hero"><div><span class="guided-step-kicker">Старт за 10 минут</span><h2>${done} из ${items.length} шагов выполнено</h2><p>Не нужно разбираться в доменах, DNS или SEO. Идите по шагам ниже — система подскажет, куда нажать дальше.</p></div><div class="quick-start-score"><b>${Math.round(done/items.length*100)}%</b><span>готовности</span></div></section>
    <section class="quick-start-grid">${items.map(x=>`<article class="panel quick-start-card ${x.done?'done':''}"><div class="quick-start-num">${x.done?'✓':x.n}</div><div><h2>${h(x.title)}</h2><p>${h(x.text)}</p><a class="btn ${x.done?'muted':''}" href="${h(x.href)}">${h(x.action)}</a></div></article>`).join('')}</section>
    <section class="panel quick-start-help"><h2>Что должно получиться в конце</h2><div class="grid3"><div><b>Лендинг для семей</b><p>Публичная страница, где семья понимает услугу и может связаться с компанией.</p><a href="/admin/landing/preview">Предпросмотр</a></div><div><b>Страница памяти</b><p>Фотографии, история жизни, воспоминания и свеча памяти.</p><a href="/admin/memorials">Открыть список</a></div><div><b>QR-комплект</b><p>Файлы для печати, таблички или передачи подрядчику.</p><a href="/admin/memorials">Скачать после публикации</a></div></div><p class="muted-text">Публичный адрес лендинга: <a href="${h(publicLanding)}">${h(publicLanding)}</a></p></section>`);
}

function easyAddress(company){
  return `${BASE_URL}/l/${company?.slug || 'company'}`;
}


app.get('/activate/:token', (req,res)=>res.redirect(`/admin/invite/${encodeURIComponent(req.params.token || '')}`));

app.get('/admin/invite/:token', (req,res)=>{
  const token = String(req.params.token || '');
  const invite = db.prepare(`SELECT i.*, m.login, m.name, m.email, m.role, c.name AS company_name, p.name AS partner_name
    FROM account_invites i
    JOIN managers m ON m.id=i.manager_id
    LEFT JOIN companies c ON c.id=i.company_id
    LEFT JOIN partners p ON p.id=i.partner_id
    WHERE i.token_hash=?`).get(inviteHash(token));
  if(!invite || invite.used_at || new Date(invite.expires_at).getTime() < Date.now()) return res.status(404).send('Ссылка недействительна или устарела. Попросите администратора создать новую ссылку подключения.');
  const title = invite.scope === 'partner' ? (invite.partner_name || 'Партнёр') : (invite.company_name || 'Компания');
  res.send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Подключение к Память QR</title><link rel="stylesheet" href="/static/admin/admin.css"></head><body class="login"><form class="login-card" method="post"><h1>Память QR</h1><p>Подключение аккаунта: ${h(title)}</p><p class="muted-text">Ссылка одноразовая и действует 24 часа. Придумайте пароль, который будете знать только вы.</p><input value="${h(invite.login)}" readonly aria-label="Логин"><input name="password" type="password" minlength="10" autocomplete="new-password" placeholder="Создайте пароль" required><input name="password2" type="password" minlength="10" autocomplete="new-password" placeholder="Повторите пароль" required><button>Создать пароль и войти</button></form></body></html>`);
});
app.post('/admin/invite/:token', rateLimit('invite', 8, 15*60*1000), (req,res)=>{
  const token = String(req.params.token || '');
  const invite = db.prepare(`SELECT i.*, m.login, m.role, m.company_id, m.partner_id FROM account_invites i JOIN managers m ON m.id=i.manager_id WHERE i.token_hash=?`).get(inviteHash(token));
  if(!invite || invite.used_at || new Date(invite.expires_at).getTime() < Date.now()) return res.status(404).send('Ссылка недействительна или устарела.');
  const password = String(req.body.password || '');
  if(password.length < 10 || password !== String(req.body.password2 || '')) return res.status(400).send('Пароль должен быть не короче 10 символов и совпадать в обоих полях.');
  db.transaction(()=>{
    db.prepare('UPDATE managers SET password_hash=?, must_change_password=0, password_changed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(bcrypt.hashSync(password,10), invite.manager_id);
    db.prepare('UPDATE account_invites SET used_at=CURRENT_TIMESTAMP WHERE id=?').run(invite.id);
  })();
  securityLog(req, 'invite_accepted', { manager_id: invite.manager_id, scope: invite.scope });
  req.session.regenerate(err=>{
    if(err) return res.status(500).send('Ошибка сессии');
    req.session.manager = { id:invite.manager_id, company_id:invite.company_id, partner_id:invite.partner_id, login:invite.login, name:invite.login, role:invite.role };
    db.prepare('UPDATE managers SET last_login_at=CURRENT_TIMESTAMP WHERE id=?').run(invite.manager_id);
    csrfToken(req);
    const target = invite.scope === 'business' ? '/admin/onboarding' : (invite.scope === 'partner' ? '/admin/partner' : '/admin');
    res.redirect(target);
  });
});

app.get('/admin/login',(req,res)=>res.send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Вход</title><link rel="stylesheet" href="/static/admin/admin.css"></head><body class="login"><form class="login-card" method="post"><h1>Память QR</h1><p>Админка ритуальной компании</p><input name="login" placeholder="Логин" required><input name="password" type="password" placeholder="Пароль" required><button>Войти</button></form></body></html>`));
app.post('/admin/login', rateLimit('login', 12, 15*60*1000), (req,res)=>{
  const login = String(req.body.login || '').trim();
  const failKey = `${req.ip}:${login}`;
  const state = FAILED_LOGINS.get(failKey) || { count:0, lockUntil:0 };
  if(Date.now() < state.lockUntil){
    securityLog(req, 'login_locked', { login });
    return res.status(429).send('Вход временно заблокирован из-за нескольких неверных попыток.');
  }
  const u = db.prepare('SELECT * FROM managers WHERE login=? AND is_active=1').get(login);
  if(!u || !bcrypt.compareSync(req.body.password||'', u.password_hash)){
    state.count += 1;
    if(state.count >= 7) state.lockUntil = Date.now() + 15*60*1000;
    FAILED_LOGINS.set(failKey, state);
    securityLog(req, 'login_failed', { login });
    return res.status(401).send('Неверный логин или пароль');
  }
  FAILED_LOGINS.delete(failKey);
  req.session.regenerate(err=>{
    if(err) return res.status(500).send('Ошибка сессии');
    req.session.manager = { id:u.id, company_id:u.company_id, partner_id:u.partner_id, login:u.login, name:u.name, role:u.role };
    db.prepare('UPDATE managers SET last_login_at=CURRENT_TIMESTAMP WHERE id=?').run(u.id);
    if(u.company_id) db.prepare('UPDATE companies SET last_activity_at=CURRENT_TIMESTAMP WHERE id=?').run(u.company_id);
    csrfToken(req);
    log(u.id,u.company_id,'login','manager',u.id,u.login);
    res.redirect('/admin');
  });
});
app.post('/admin/logout', requireAuth, (req,res)=>{ req.session.destroy(()=>res.redirect('/admin/login')); });


function roleName(role){ return ({super_admin:'Главный админ',partner_admin:'Партнёр',business_owner:'Владелец бизнеса',business_operator:'Оператор'})[role] || role; }

function sqlPlaceholders(items){ return items.map(()=>'?').join(','); }
function eventCountForCompanies(companyIds, eventTypes=[], days=30){
  if(!companyIds.length) return 0;
  const companySql = sqlPlaceholders(companyIds);
  const dayArg = `-${Number(days)||30} days`;
  if(eventTypes && eventTypes.length){
    const typeSql = sqlPlaceholders(eventTypes);
    return db.prepare(`SELECT COUNT(*) c FROM analytics_events WHERE company_id IN (${companySql}) AND event_type IN (${typeSql}) AND created_at >= datetime('now', ?)`).get(...companyIds, ...eventTypes, dayArg).c;
  }
  return db.prepare(`SELECT COUNT(*) c FROM analytics_events WHERE company_id IN (${companySql}) AND created_at >= datetime('now', ?)`).get(...companyIds, dayArg).c;
}
function submissionCountForCompanies(companyIds, days=30){
  if(!companyIds.length) return 0;
  const companySql = sqlPlaceholders(companyIds);
  return db.prepare(`SELECT COUNT(*) c FROM memorial_submissions WHERE company_id IN (${companySql}) AND created_at >= datetime('now', ?)`).get(...companyIds, `-${Number(days)||30} days`).c;
}
function partnerDailyRows(companyIds, days=14){
  if(!companyIds.length) return [];
  const companySql = sqlPlaceholders(companyIds);
  return db.prepare(`SELECT substr(created_at,1,10) day, COUNT(*) count FROM analytics_events WHERE company_id IN (${companySql}) AND created_at >= datetime('now', ?) GROUP BY day ORDER BY day DESC LIMIT 14`).all(...companyIds, `-${Number(days)||14} days`);
}
function partnerBusinessActivityRow(c, days=30){
  const st = businessStats(c.id);
  const views = eventCountForCompanies([c.id], ['landing_view','memorial_view'], days);
  const qr = eventCountForCompanies([c.id], ['qr_center_view','qr_png_download','qr_svg_download','qr_pdf_download','qr_kit_download'], days);
  const submissions = submissionCountForCompanies([c.id], days);
  const lastEvent = db.prepare('SELECT MAX(created_at) last_event_at FROM analytics_events WHERE company_id=?').get(c.id)?.last_event_at || '';
  const flags = [];
  if(c.account_status !== 'active') flags.push(c.account_status);
  if(st.pages === 0) flags.push('нет страниц');
  if(st.published === 0) flags.push('нет публикаций');
  if(!lastEvent) flags.push('нет событий');
  return { company:c, stats:st, views, qr, submissions, lastEvent, flags };
}
function businessMetricsHtml(company, days=30){
  const row = partnerBusinessActivityRow(company, days);
  const cards = [
    ['Страниц памяти', row.stats.pages], ['Опубликовано', row.stats.published], ['Просмотры', row.views], ['QR-события', row.qr], ['Заявки семьи', row.submissions], ['Последняя активность', row.lastEvent ? formatDate(row.lastEvent) : '—']
  ];
  return `<section class="metric-grid platform-metrics business-analytics">${cards.map(c=>`<div class="metric"><span>${h(c[0])}</span><b>${h(c[1])}</b></div>`).join('')}</section>`;
}
function updateBusinessByAdmin(req, c, scope){
  const requestedStatus = req.body.account_status || c.account_status || 'active';
  if(scope === 'partner' && requestedStatus === 'archived') throw new Error('Партнёр не может архивировать или удалять бизнес. Обратитесь в главную админку.');
  const data = {
    id:c.id,
    name:req.body.name||c.name,
    slug:safeSlug(req.body.slug||c.slug),
    city:req.body.city||'', phone:req.body.phone||'', email:req.body.email||'', website_url:req.body.website_url||'',
    telegram_url:req.body.telegram_url||'', whatsapp_url:req.body.whatsapp_url||'', vk_url:req.body.vk_url||'',
    contact_label:req.body.contact_label||c.contact_label||'Связаться', accent_color:req.body.accent_color||c.accent_color||'#B47A3D',
    brand_display_name:req.body.brand_display_name||req.body.name||c.brand_display_name||c.name,
    public_footer_brand:req.body.public_footer_brand||req.body.name||c.public_footer_brand||c.name,
    custom_domain:normalizeDomain(req.body.custom_domain||c.custom_domain||''),
    robots_policy:req.body.robots_policy||c.robots_policy||'default', manager_timezone:req.body.manager_timezone||c.manager_timezone||'Europe/Moscow',
    legal_name:req.body.legal_name||'', privacy_url:req.body.privacy_url||'', data_contact:req.body.data_contact||'', data_email:req.body.data_email||'',
    plan:req.body.plan||c.plan||'standard', account_status:requestedStatus,
    is_active: requestedStatus==='archived' ? 0 : 1,
    disabled_at:['paused','archived'].includes(requestedStatus)?new Date().toISOString():null
  };
  db.prepare(`UPDATE companies SET name=@name, slug=@slug, city=@city, phone=@phone, email=@email, website_url=@website_url, telegram_url=@telegram_url, whatsapp_url=@whatsapp_url, vk_url=@vk_url, contact_label=@contact_label, accent_color=@accent_color, brand_display_name=@brand_display_name, public_footer_brand=@public_footer_brand, custom_domain=@custom_domain, robots_policy=@robots_policy, manager_timezone=@manager_timezone, legal_name=@legal_name, privacy_url=@privacy_url, data_contact=@data_contact, data_email=@data_email, plan=@plan, account_status=@account_status, is_active=@is_active, disabled_at=@disabled_at, updated_at=CURRENT_TIMESTAMP WHERE id=@id`).run(data);
  audit(req, scope === 'partner' ? 'update_partner_business_full' : 'update_business_full','company',c.id,data.name,{status:data.account_status,plan:data.plan});
}
function partnerAnalyticsHtml(req){
  const partner = currentPartner(req);
  if(!partner) return layout(req,'Аналитика партнёра','<section class="panel"><h1>Партнёр не найден</h1></section>');
  const days = Math.max(7, Math.min(180, Number(req.query.days || 30)));
  const companies = db.prepare(`SELECT c.*, p.name AS partner_name FROM companies c LEFT JOIN partners p ON p.id=c.partner_id WHERE c.partner_id=? ORDER BY c.updated_at DESC, c.id DESC`).all(partner.id);
  const ids = companies.map(c=>c.id);
  const rows = companies.map(c=>partnerBusinessActivityRow(c, days));
  const totals = {
    businesses: companies.length,
    active: companies.filter(c=>c.account_status === 'active' && c.is_active).length,
    paused: companies.filter(c=>c.account_status === 'paused').length,
    pages: rows.reduce((s,r)=>s+r.stats.pages,0),
    published: rows.reduce((s,r)=>s+r.stats.published,0),
    views: eventCountForCompanies(ids, ['landing_view','memorial_view'], days),
    qr: eventCountForCompanies(ids, ['qr_center_view','qr_png_download','qr_svg_download','qr_pdf_download','qr_kit_download'], days),
    submissions: submissionCountForCompanies(ids, days),
    allEvents: eventCountForCompanies(ids, [], days)
  };
  const daily = partnerDailyRows(ids, Math.min(days, 30));
  const problemRows = rows.filter(r=>r.flags.length).slice(0, 12);
  const cards = [
    ['Бизнесов', totals.businesses], ['Активных', totals.active], ['На паузе', totals.paused], ['Страниц памяти', totals.pages],
    ['Опубликовано', totals.published], ['Просмотры', totals.views], ['QR-события', totals.qr], ['Заявки семьи', totals.submissions]
  ];
  return layout(req,'Аналитика партнёра',`<div class="top"><h1>Аналитика партнёра</h1><div><span class="status-pill">${h(partner.name)}</span><a class="btn muted" href="/admin/partner/businesses">Мои бизнесы</a></div></div>
    <section class="panel"><h2>Период</h2><div class="actions"><a class="btn muted" href="/admin/partner/analytics?days=7">7 дней</a><a class="btn muted" href="/admin/partner/analytics?days=30">30 дней</a><a class="btn muted" href="/admin/partner/analytics?days=90">90 дней</a></div><p class="muted">Показатели считаются только по бизнесам партнёра. Чужие и прямые клиенты платформы не попадают в выборку.</p></section>
    <section class="metric-grid platform-metrics">${cards.map(c=>`<div class="metric"><span>${h(c[0])}</span><b>${h(c[1])}</b></div>`).join('')}</section>
    <section class="panel"><h2>Бизнесы партнёра</h2><table><tr><th>Компания</th><th>Статус</th><th>Страниц</th><th>Опубликовано</th><th>Просмотры</th><th>QR</th><th>Заявки</th><th>Последняя активность</th><th></th></tr>${rows.map(r=>`<tr><td>${h(r.company.name)}<br><small>${h(r.company.city||'')}</small></td><td><span class="status-badge ${h(r.company.account_status||'active')}">${h(r.company.account_status||'active')}</span></td><td>${r.stats.pages}</td><td>${r.stats.published}</td><td>${r.views}</td><td>${r.qr}</td><td>${r.submissions}</td><td>${r.lastEvent?h(formatDate(r.lastEvent)):'—'}</td><td><a href="/admin/partner/businesses/${r.company.id}">Открыть</a></td></tr>`).join('') || '<tr><td colspan="9">Бизнесов пока нет</td></tr>'}</table></section>
    <section class="panel"><h2>Что требует внимания</h2>${problemRows.length?`<table><tr><th>Компания</th><th>Причина</th><th>Действие</th></tr>${problemRows.map(r=>`<tr><td>${h(r.company.name)}</td><td>${h(r.flags.join(', '))}</td><td><a href="/admin/partner/businesses/${r.company.id}">Проверить</a></td></tr>`).join('')}</table>`:'<p class="muted">Критичных проблем по бизнесам партнёра не найдено.</p>'}</section>
    <section class="panel"><h2>Динамика событий</h2><table><tr><th>День</th><th>События</th></tr>${daily.map(d=>`<tr><td>${h(d.day)}</td><td>${h(d.count)}</td></tr>`).join('') || '<tr><td colspan="2">За период ещё нет событий</td></tr>'}</table></section>`);
}


function platformAnalyticsHtml(req){
  const days = Math.max(7, Math.min(180, Number(req.query.days || 30)));
  const companies = db.prepare('SELECT c.*, p.name AS partner_name FROM companies c LEFT JOIN partners p ON p.id=c.partner_id ORDER BY c.updated_at DESC, c.id DESC').all();
  const partners = db.prepare('SELECT * FROM partners ORDER BY updated_at DESC, id DESC').all();
  const companyIds = companies.map(c=>c.id);
  const rows = companies.map(c=>partnerBusinessActivityRow(c, days));
  const cards = [
    ['Всего бизнесов', companies.length],
    ['Активные бизнесы', companies.filter(c=>c.account_status !== 'archived' && c.is_active).length],
    ['Партнёры', partners.length],
    ['Страницы памяти', rows.reduce((sum,r)=>sum+r.stats.pages,0)],
    ['Опубликовано', rows.reduce((sum,r)=>sum+r.stats.published,0)],
    ['Просмотры', eventCountForCompanies(companyIds, ['landing_view','memorial_view'], days)],
    ['QR-события', eventCountForCompanies(companyIds, ['qr_center_view','qr_png_download','qr_svg_download','qr_pdf_download','qr_kit_download'], days)],
    ['Заявки семьи', submissionCountForCompanies(companyIds, days)]
  ];
  return layout(req,'Аналитика платформы',`<div class="top"><h1>Аналитика платформы</h1><div>${partnerAdminLinks(req)}</div></div>
    <section class="panel"><h2>Период</h2><div class="actions"><a class="btn muted" href="/admin/platform/analytics?days=7">7 дней</a><a class="btn muted" href="/admin/platform/analytics?days=30">30 дней</a><a class="btn muted" href="/admin/platform/analytics?days=90">90 дней</a></div></section>
    <section class="metric-grid platform-metrics">${cards.map(c=>`<div class="metric"><span>${h(c[0])}</span><b>${h(c[1])}</b></div>`).join('')}</section>
    <section class="panel"><h2>Партнёры</h2><table><tr><th>Партнёр</th><th>Статус</th><th>Бизнесов</th></tr>${partners.map(p=>`<tr><td>${h(p.name)}</td><td>${h(p.status||'active')}</td><td>${db.prepare('SELECT COUNT(*) c FROM companies WHERE partner_id=?').get(p.id).c}</td></tr>`).join('') || '<tr><td colspan="3">Партнёров пока нет</td></tr>'}</table></section>
    <section class="panel"><h2>Аналитика по бизнесам</h2><table><tr><th>Компания</th><th>Партнёр</th><th>Статус</th><th>Страниц</th><th>Опубликовано</th><th>Просмотры</th><th>QR</th><th>Заявки</th><th>Последняя активность</th><th></th></tr>${rows.map(r=>`<tr><td>${h(r.company.name)}</td><td>${h(r.company.partner_name||'Прямой клиент')}</td><td>${h(r.company.account_status||'active')}</td><td>${r.stats.pages}</td><td>${r.stats.published}</td><td>${r.views}</td><td>${r.qr}</td><td>${r.submissions}</td><td>${r.lastEvent?h(formatDate(r.lastEvent)):'—'}</td><td><a href="/admin/platform/businesses/${r.company.id}">Открыть</a></td></tr>`).join('') || '<tr><td colspan="10">Бизнесов пока нет</td></tr>'}</table></section>`);
}

function platformDashboardHtml(req, scope='platform'){
  const isPartnerScope = scope === 'partner';
  const partner = isPartnerScope ? currentPartner(req) : null;
  const where = isPartnerScope ? 'WHERE c.partner_id = ?' : '';
  const args = isPartnerScope ? [partner.id] : [];
  const companies = db.prepare(`SELECT c.*, p.name AS partner_name FROM companies c LEFT JOIN partners p ON p.id=c.partner_id ${where} ORDER BY c.updated_at DESC, c.id DESC`).all(...args);
  const partners = isPartnerScope ? [] : db.prepare('SELECT * FROM partners ORDER BY updated_at DESC, id DESC').all();
  const totals = {
    businesses: companies.length,
    active: companies.filter(c=>c.account_status !== 'archived' && c.is_active).length,
    pages: companies.reduce((sum,c)=>sum+businessStats(c.id).pages,0),
    published: companies.reduce((sum,c)=>sum+businessStats(c.id).published,0),
    views: companies.reduce((sum,c)=>sum+businessStats(c.id).views,0)
  };
  const title = isPartnerScope ? 'Партнёрская админка' : 'Платформа';
  const partnerOptions = partners.map(p=>`<option value="${p.id}">${h(p.name)}</option>`).join('');
  return layout(req,title,`<div class="top"><h1>${title}</h1><div class="status-pill">${isPartnerScope ? h(partner?.name||'Партнёр') : 'Super Admin'}</div></div>
    <section class="metric-grid platform-metrics">
      <div class="metric"><span>Бизнесы</span><b>${totals.businesses}</b></div>
      <div class="metric"><span>Активные</span><b>${totals.active}</b></div>
      <div class="metric"><span>Страницы</span><b>${totals.pages}</b></div>
      <div class="metric"><span>Опубликовано</span><b>${totals.published}</b></div>
      <div class="metric"><span>События</span><b>${totals.views}</b></div>
    </section>
    ${!isPartnerScope ? `<section class="panel form"><h2>Создать партнёра</h2><form method="post" action="/admin/platform/partners/new"><div class="grid2">${input('name','Название партнёра')}${input('contact_name','Контактное лицо')}${input('phone','Телефон')}${input('email','Email')}${input('login','Логин партнёра')}${input('password','Пароль, если нужен сразу','','text','Лучше оставить пустым и отправить одноразовую ссылку подключения.')}</div><button class="btn">Создать партнёра</button></form></section>` : ''}
    <section class="panel form"><h2>Создать бизнес</h2><form method="post" action="${isPartnerScope?'/admin/partner/businesses/new':'/admin/platform/businesses/new'}"><div class="grid2">${!isPartnerScope ? `<label class="field"><span>Партнёр</span><select name="partner_id"><option value="">Прямой клиент</option>${partnerOptions}</select></label>` : ''}${input('name','Название бизнеса')}${input('city','Город')}${input('phone','Телефон')}${input('email','Email')}${input('login','Логин бизнеса')}${input('password','Пароль, если нужен сразу','','text','Лучше оставить пустым и отправить одноразовую ссылку подключения.')}</div><button class="btn">Создать бизнес</button></form></section>
    ${!isPartnerScope ? `<section class="panel"><h2>Партнёры</h2><table><tr><th>Партнёр</th><th>Статус</th><th>Бизнесов</th><th>Контакт</th></tr>${partners.map(p=>`<tr><td>${h(p.name)}</td><td>${h(p.status)}</td><td>${db.prepare('SELECT COUNT(*) c FROM companies WHERE partner_id=?').get(p.id).c}</td><td>${h(p.phone||p.email||'')}</td></tr>`).join('')}</table></section>` : ''}
    <section class="panel"><h2>Бизнесы</h2><table><tr><th>Компания</th><th>Партнёр</th><th>Статус</th><th>Страниц</th><th>Опубликовано</th><th>События</th><th></th></tr>${companies.map(c=>{const st=businessStats(c.id); return `<tr><td>${h(c.name)}<br><small>${h(c.city||'')}</small></td><td>${h(c.partner_name||'Прямой клиент')}</td><td>${h(c.account_status||'active')}</td><td>${st.pages}</td><td>${st.published}</td><td>${st.views}</td><td><form class="inline-form" method="post" action="${isPartnerScope?'/admin/partner':'/admin/platform'}/businesses/${c.id}/impersonate"><button class="link-button">Открыть как бизнес</button></form></td></tr>`}).join('')}</table></section>`);
}

function partnerAdminLinks(req){
  if(isSuper(req)) return `<a class="btn muted" href="/admin/platform/partners">Партнёры</a><a class="btn muted" href="/admin/platform/businesses">Бизнесы</a>`;
  if(isPartner(req)) return `<a class="btn muted" href="/admin/partner/businesses">Мои бизнесы</a>`;
  return '';
}
function managerLastLogin(companyId){
  const row = db.prepare("SELECT MAX(last_login_at) AS last_login_at FROM managers WHERE company_id=?").get(companyId);
  return row?.last_login_at || '';
}
function platformPartnersHtml(req){
  const partners = db.prepare(`SELECT p.*, COUNT(c.id) AS business_count
    FROM partners p LEFT JOIN companies c ON c.partner_id=p.id
    GROUP BY p.id ORDER BY p.id ASC`).all();
  return layout(req,'Партнёры',`<div class="top"><h1>Партнёры</h1><div>${partnerAdminLinks(req)}<a class="btn" href="/admin/platform">Создать</a></div></div>
    <section class="panel"><h2>Партнёрские аккаунты</h2><table><tr><th>Название партнёра</th><th>Контактное лицо</th><th>Телефон</th><th>Email</th><th>Бизнесов</th><th>Статус</th><th>Действия</th></tr>
    ${partners.map(p=>`<tr><td>${h(p.name)}</td><td>${h(p.contact_name||'')}</td><td>${h(p.phone||'')}</td><td>${h(p.email||'')}</td><td>${p.business_count}</td><td><span class="status-badge ${h(p.status)}">${h(p.status)}</span></td><td><a href="/admin/platform/partners/${p.id}">Открыть</a> · ${p.status==='archived'?`<form class="inline-form" method="post" action="/admin/platform/partners/${p.id}/activate"><button class="link-button">Активировать</button></form>`:`<form class="inline-form" method="post" action="/admin/platform/partners/${p.id}/pause"><button class="link-button">Отключить</button></form>`}</td></tr>`).join('') || '<tr><td colspan="7">Партнёров пока нет</td></tr>'}</table></section>`);
}
function platformPartnerDetailHtml(req, partner){
  const companies = db.prepare(`SELECT c.*, p.name AS partner_name FROM companies c LEFT JOIN partners p ON p.id=c.partner_id WHERE c.partner_id=? ORDER BY c.updated_at DESC, c.id DESC`).all(partner.id);
  const managers = db.prepare("SELECT id,login,name,email,role,is_active,last_login_at,must_change_password FROM managers WHERE partner_id=? AND role='partner_admin' ORDER BY id").all(partner.id);
  const inviteTokenValue = String(req.query.invite || '');
  const inviteBlock = inviteTokenValue ? publicInviteCopy(inviteUrl(req, inviteTokenValue)) : '';
  return layout(req,`Партнёр: ${partner.name}`,`<div class="top"><h1>${h(partner.name)}</h1><div><a class="btn muted" href="/admin/platform/partners">Назад</a><a class="btn muted" href="/admin/platform/businesses?partner_id=${partner.id}">Бизнесы партнёра</a></div></div>
  ${inviteBlock}
  <form class="panel form" method="post"><h2>Карточка партнёра</h2><div class="grid2">${input('name','Название партнёра',partner.name)}${input('contact_name','Контактное лицо',partner.contact_name||'')}${input('phone','Телефон',partner.phone||'')}${input('email','Email',partner.email||'')}${select('status','Статус',partner.status,[['active','active'],['paused','paused'],['archived','archived']])}</div><button class="btn">Сохранить</button></form>
  <section class="panel"><h2>Пользователи партнёра</h2><table><tr><th>Логин</th><th>Имя</th><th>Email</th><th>Активен</th><th>Последний вход</th><th>Подключение</th></tr>${managers.map(m=>`<tr><td>${h(m.login)}</td><td>${h(m.name||'')}</td><td>${h(m.email||'')}</td><td>${m.is_active?'да':'нет'}</td><td>${m.last_login_at?h(formatDate(m.last_login_at)):''}</td><td>${m.must_change_password?`<form class="inline-form" method="post" action="/admin/platform/partners/${partner.id}/managers/${m.id}/invite"><button class="link-button">Создать ссылку входа</button></form>`:'Пароль задан'}</td></tr>`).join('') || '<tr><td colspan="6">Пользователей нет</td></tr>'}</table></section>
  <section class="panel"><h2>Бизнесы партнёра</h2><table><tr><th>Компания</th><th>Город</th><th>Статус</th><th>Страниц</th><th>Последний вход</th><th>Действия</th></tr>${companies.map(c=>businessRow(req,c,'platform')).join('') || '<tr><td colspan="6">Бизнесов пока нет</td></tr>'}</table></section>`);
}
function businessRow(req,c,scope){
  const st=businessStats(c.id);
  const last=managerLastLogin(c.id);
  const base = scope === 'partner' ? '/admin/partner' : '/admin/platform';
  const partnerName = c.partner_name || 'Прямой клиент';
  return `<tr><td>${h(c.name)}<br><small>${h(c.email||'')}</small></td><td>${h(c.city||'')}</td>${scope==='platform'?`<td>${h(partnerName)}</td>`:''}<td>${h(c.plan||'standard')}</td><td><span class="status-badge ${h(c.account_status||'active')}">${h(c.account_status||'active')}</span></td><td>${last?h(formatDate(last)):''}</td><td>${st.pages}</td><td><a href="${base}/businesses/${c.id}">Открыть</a> · <form class="inline-form" method="post" action="${base}/businesses/${c.id}/impersonate"><button class="link-button">Войти как бизнес</button></form></td></tr>`;
}
function businessesHtml(req,scope='platform'){
  const isPartnerScope = scope === 'partner';
  const partner = isPartnerScope ? currentPartner(req) : null;
  const partnerFilter = !isPartnerScope && req.query.partner_id ? Number(req.query.partner_id) : null;
  let rows;
  if(isPartnerScope){
    rows = db.prepare(`SELECT c.*, p.name AS partner_name FROM companies c LEFT JOIN partners p ON p.id=c.partner_id WHERE c.partner_id=? ORDER BY c.updated_at DESC, c.id DESC`).all(partner.id);
  } else if(partnerFilter){
    rows = db.prepare(`SELECT c.*, p.name AS partner_name FROM companies c LEFT JOIN partners p ON p.id=c.partner_id WHERE c.partner_id=? ORDER BY c.updated_at DESC, c.id DESC`).all(partnerFilter);
  } else {
    rows = db.prepare(`SELECT c.*, p.name AS partner_name FROM companies c LEFT JOIN partners p ON p.id=c.partner_id ORDER BY c.updated_at DESC, c.id DESC`).all();
  }
  const title = isPartnerScope ? 'Мои бизнесы' : 'Бизнесы платформы';
  return layout(req,title,`<div class="top"><h1>${title}</h1><div>${partnerAdminLinks(req)}<a class="btn" href="${isPartnerScope?'/admin/partner':'/admin/platform'}">Создать бизнес</a></div></div>
  <section class="panel"><h2>${isPartnerScope ? h(partner?.name||'Партнёр') : 'Все бизнес-аккаунты'}</h2><table><tr><th>Компания</th><th>Город</th>${isPartnerScope?'':'<th>Партнёр</th>'}<th>Тариф</th><th>Статус</th><th>Последний вход</th><th>Страниц памяти</th><th>Действия</th></tr>${rows.map(c=>businessRow(req,c,scope)).join('') || '<tr><td colspan="8">Бизнесов пока нет</td></tr>'}</table></section>`);
}
function managerInviteTable(req, managers, scope, company){
  const base = scope === 'partner' ? '/admin/partner' : '/admin/platform';
  return `<table><tr><th>Логин</th><th>Имя</th><th>Email</th><th>Роль</th><th>Активен</th><th>Последний вход</th><th>Подключение</th></tr>${managers.map(m=>{
    const invite = latestInviteForManager(m.id);
    return `<tr><td>${h(m.login)}</td><td>${h(m.name||'')}</td><td>${h(m.email||'')}</td><td>${h(roleName(m.role))}</td><td>${m.is_active?'да':'нет'}</td><td>${m.last_login_at?h(formatDate(m.last_login_at)):''}</td><td>${m.must_change_password?`<form class="inline-form" method="post" action="${base}/businesses/${company.id}/managers/${m.id}/invite"><button class="link-button">Создать ссылку входа</button></form>${invite?'<br><small>Активная ссылка уже создана</small>':''}`:'Пароль задан'}</td></tr>`;
  }).join('') || '<tr><td colspan="7">Пользователей нет</td></tr>'}</table>`;
}
function businessDetailHtml(req, company, scope='platform'){
  const managers = db.prepare('SELECT id,login,name,email,role,is_active,last_login_at,must_change_password FROM managers WHERE company_id=? ORDER BY id').all(company.id);
  const base = scope === 'partner' ? '/admin/partner' : '/admin/platform';
  const isPartnerScope = scope === 'partner';
  const inviteTokenValue = String(req.query.invite || '');
  const inviteBlock = inviteTokenValue ? publicInviteCopy(inviteUrl(req, inviteTokenValue)) : '';
  const statusOptions = isPartnerScope ? [['active','active'],['trial','trial'],['paused','paused']] : [['active','active'],['trial','trial'],['paused','paused'],['archived','archived']];
  return layout(req,`Бизнес: ${company.name}`,`<div class="top"><h1>${h(company.name)}</h1><div><a class="btn muted" href="${base}/businesses">Назад</a><form class="inline-form" method="post" action="${base}/businesses/${company.id}/impersonate"><button class="btn">Войти как бизнес</button></form></div></div>
  ${inviteBlock}
  ${businessMetricsHtml(company, 30)}
  <form class="panel form" method="post"><h2>Карточка бизнеса</h2><p class="muted-text">${isPartnerScope?'Партнёр может создавать, редактировать и открывать свои бизнесы. Архивация и удаление доступны только главной админке.':'Главная админка имеет полный доступ к параметрам бизнеса.'}</p><div class="grid2">
    ${input('name','Название бизнеса',company.name)}${input('slug','Адрес /l/',company.slug||'')}${input('city','Город',company.city||'')}${input('phone','Телефон',company.phone||'')}${input('email','Email',company.email||'')}${input('website_url','Сайт компании',company.website_url||'')}${input('telegram_url','Telegram',company.telegram_url||'')}${input('whatsapp_url','WhatsApp',company.whatsapp_url||'')}${input('vk_url','VK',company.vk_url||'')}${input('contact_label','Текст кнопки связи',company.contact_label||'Связаться')}${input('brand_display_name','Название для семей',company.brand_display_name||company.name)}${input('public_footer_brand','Подпись внизу публичных страниц',company.public_footer_brand||company.name)}${input('accent_color','Фирменный цвет',company.accent_color||'#B47A3D','color')}${input('custom_domain','Короткий адрес',company.custom_domain||'')}${select('robots_policy','Показ в поиске',company.robots_policy||'default',[['default','По умолчанию'],['noindex_all','Закрыть от поиска'],['allow_public','Разрешить публичное']])}${input('manager_timezone','Часовой пояс',company.manager_timezone||'Europe/Moscow')}${input('legal_name','Юридическое имя',company.legal_name||'')}${input('privacy_url','Ссылка на политику',company.privacy_url||'')}${input('data_contact','Контакт по данным',company.data_contact||'')}${input('data_email','Email по данным',company.data_email||'')}${select('plan','Тариф',company.plan||'standard',[['trial','trial'],['standard','standard'],['pro','pro'],['enterprise','enterprise']])}${select('account_status','Статус',company.account_status||'active',statusOptions)}
  </div><button class="btn">Сохранить</button></form>
  <section class="panel"><h2>Пользователи бизнеса</h2>${managerInviteTable(req, managers, scope, company)}</section>`);
}


function eventsFilters(req){
  return { channel:String(req.query.channel||'all'), unread:String(req.query.unread||'all'), event_type:String(req.query.event_type||'all') };
}
function notificationWhereParts(baseSql, params, filters){
  if(filters.channel !== 'all'){ baseSql += ' AND n.channel=?'; params.push(filters.channel); }
  if(filters.unread === '1'){ baseSql += ' AND n.read_at IS NULL'; }
  if(filters.unread === '0'){ baseSql += ' AND n.read_at IS NOT NULL'; }
  if(filters.event_type !== 'all'){ baseSql += ' AND n.event_type=?'; params.push(filters.event_type); }
  return baseSql;
}
function businessEventsHtml(req){
  const c=currentCompany(req);
  const filters=eventsFilters(req);
  const params=[c.id];
  let where=notificationWhereParts('n.company_id=?', params, filters);
  const rows=db.prepare(`SELECT n.*, c.name AS company_name FROM notification_log n LEFT JOIN companies c ON c.id=n.company_id WHERE ${where} ORDER BY n.created_at DESC, n.id DESC LIMIT 120`).all(...params);
  const unread=db.prepare('SELECT COUNT(*) c FROM notification_log WHERE company_id=? AND read_at IS NULL').get(c.id).c;
  const types=db.prepare('SELECT event_type, COUNT(*) count FROM notification_log WHERE company_id=? GROUP BY event_type ORDER BY count DESC').all(c.id);
  return layout(req,'Уведомления и события',`<div class="top"><h1>Уведомления и события</h1><form class="inline-form" method="post" action="/admin/notifications/read-all"><button class="btn muted">Отметить всё прочитанным</button></form></div>
    <section class="panel event-summary"><div class="cards small-cards"><div><b>${unread}</b><span>непрочитанных</span></div><div><b>${rows.length}</b><span>событий в выборке</span></div><div><b>${types.length}</b><span>типов событий</span></div></div></section>
    <section class="panel crm-toolbar"><form method="get" class="crm-filters"><label><span>Канал</span><select name="channel"><option value="all">Все</option><option value="system" ${filters.channel==='system'?'selected':''}>Системные</option><option value="email" ${filters.channel==='email'?'selected':''}>Email</option><option value="telegram" ${filters.channel==='telegram'?'selected':''}>Telegram</option></select></label><label><span>Состояние</span><select name="unread"><option value="all">Все</option><option value="1" ${filters.unread==='1'?'selected':''}>Непрочитанные</option><option value="0" ${filters.unread==='0'?'selected':''}>Прочитанные</option></select></label><label><span>Тип</span><select name="event_type"><option value="all">Все типы</option>${types.map(t=>`<option value="${h(t.event_type)}" ${filters.event_type===t.event_type?'selected':''}>${h(eventTypeLabel(t.event_type))} · ${t.count}</option>`).join('')}</select></label><button class="btn muted">Фильтр</button></form></section>
    <section class="panel"><h2>Лента событий</h2><table><tr><th>Дата</th><th>Приоритет</th><th>Событие</th><th>Детали</th><th>Статус</th><th></th></tr>${rows.map(r=>eventRowHtml(r,false)).join('') || '<tr><td colspan="6">Событий пока нет</td></tr>'}</table></section>`);
}
function partnerEventsHtml(req){
  const partner=currentPartner(req);
  const filters=eventsFilters(req);
  const params=[partner.id];
  let where=notificationWhereParts('c.partner_id=?', params, filters);
  const rows=db.prepare(`SELECT n.*, c.name AS company_name FROM notification_log n JOIN companies c ON c.id=n.company_id WHERE ${where} ORDER BY n.created_at DESC, n.id DESC LIMIT 150`).all(...params);
  const unread=db.prepare('SELECT COUNT(*) c FROM notification_log n JOIN companies c ON c.id=n.company_id WHERE c.partner_id=? AND n.read_at IS NULL').get(partner.id).c;
  const types=db.prepare('SELECT n.event_type, COUNT(*) count FROM notification_log n JOIN companies c ON c.id=n.company_id WHERE c.partner_id=? GROUP BY n.event_type ORDER BY count DESC').all(partner.id);
  return layout(req,'События партнёра',`<div class="top"><h1>События партнёра</h1><div class="status-pill">${h(partner.name)}</div></div>
    <section class="panel event-summary"><div class="cards small-cards"><div><b>${unread}</b><span>непрочитанных</span></div><div><b>${rows.length}</b><span>событий в выборке</span></div><div><b>${types.length}</b><span>типов событий</span></div></div></section>
    <section class="panel crm-toolbar"><form method="get" class="crm-filters"><label><span>Канал</span><select name="channel"><option value="all">Все</option><option value="system" ${filters.channel==='system'?'selected':''}>Системные</option><option value="email" ${filters.channel==='email'?'selected':''}>Email</option><option value="telegram" ${filters.channel==='telegram'?'selected':''}>Telegram</option></select></label><label><span>Состояние</span><select name="unread"><option value="all">Все</option><option value="1" ${filters.unread==='1'?'selected':''}>Непрочитанные</option><option value="0" ${filters.unread==='0'?'selected':''}>Прочитанные</option></select></label><label><span>Тип</span><select name="event_type"><option value="all">Все типы</option>${types.map(t=>`<option value="${h(t.event_type)}" ${filters.event_type===t.event_type?'selected':''}>${h(eventTypeLabel(t.event_type))} · ${t.count}</option>`).join('')}</select></label><button class="btn muted">Фильтр</button></form></section>
    <section class="panel"><h2>Лента по бизнесам партнёра</h2><table><tr><th>Дата</th><th>Бизнес</th><th>Приоритет</th><th>Событие</th><th>Детали</th><th>Статус</th><th></th></tr>${rows.map(r=>eventRowHtml(r,true)).join('') || '<tr><td colspan="7">Событий пока нет</td></tr>'}</table></section>`);
}

app.get('/admin/platform', requireAuth, requireRoles('super_admin'), (req,res)=>res.send(platformDashboardHtml(req,'platform')));
app.get('/admin/platform/analytics', requireAuth, requireRoles('super_admin'), (req,res)=>res.send(platformAnalyticsHtml(req)));
app.get('/admin/platform/partners', requireAuth, requireRoles('super_admin'), (req,res)=>res.send(platformPartnersHtml(req)));
app.get('/admin/platform/partners/:id(\\d+)', requireAuth, requireRoles('super_admin'), (req,res)=>{ const partner=db.prepare('SELECT * FROM partners WHERE id=?').get(req.params.id); if(!partner) return res.status(404).send('Партнёр не найден'); res.send(platformPartnerDetailHtml(req,partner)); });
app.post('/admin/platform/partners/:id(\\d+)', requireAuth, requireRoles('super_admin'), (req,res)=>{ const p=db.prepare('SELECT * FROM partners WHERE id=?').get(req.params.id); if(!p) return res.status(404).send('Партнёр не найден'); db.prepare('UPDATE partners SET name=@name, contact_name=@contact_name, phone=@phone, email=@email, status=@status, updated_at=CURRENT_TIMESTAMP WHERE id=@id').run({id:p.id,name:req.body.name||p.name,contact_name:req.body.contact_name||'',phone:req.body.phone||'',email:req.body.email||'',status:req.body.status||p.status}); audit(req,'update_partner','partner',p.id,req.body.name||p.name,{status:req.body.status||p.status}); res.redirect(`/admin/platform/partners/${p.id}`); });
app.post('/admin/platform/partners/:id(\\d+)/pause', requireAuth, requireRoles('super_admin'), (req,res)=>{ const p=db.prepare('SELECT * FROM partners WHERE id=?').get(req.params.id); if(!p) return res.status(404).send('Партнёр не найден'); db.prepare("UPDATE partners SET status='paused', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(p.id); audit(req,'pause_partner','partner',p.id,p.name); res.redirect('/admin/platform/partners'); });
app.post('/admin/platform/partners/:id(\\d+)/activate', requireAuth, requireRoles('super_admin'), (req,res)=>{ const p=db.prepare('SELECT * FROM partners WHERE id=?').get(req.params.id); if(!p) return res.status(404).send('Партнёр не найден'); db.prepare("UPDATE partners SET status='active', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(p.id); audit(req,'activate_partner','partner',p.id,p.name); res.redirect('/admin/platform/partners'); });
app.get('/admin/platform/businesses', requireAuth, requireRoles('super_admin'), (req,res)=>res.send(businessesHtml(req,'platform')));
app.get('/admin/platform/businesses/:id(\\d+)', requireAuth, requireRoles('super_admin'), (req,res)=>{ const company=db.prepare('SELECT c.*, p.name AS partner_name FROM companies c LEFT JOIN partners p ON p.id=c.partner_id WHERE c.id=?').get(req.params.id); if(!company) return res.status(404).send('Бизнес не найден'); res.send(businessDetailHtml(req,company,'platform')); });
app.post('/admin/platform/businesses/:id(\\d+)', requireAuth, requireRoles('super_admin'), (req,res)=>{ try{ const c=db.prepare('SELECT * FROM companies WHERE id=?').get(req.params.id); if(!c) return res.status(404).send('Бизнес не найден'); updateBusinessByAdmin(req,c,'platform'); res.redirect(`/admin/platform/businesses/${c.id}`); }catch(e){ res.status(400).send(e.message); } });
app.get('/admin/partner', requireAuth, requireRoles('partner_admin'), (req,res)=>res.send(platformDashboardHtml(req,'partner')));
app.get('/admin/partner/businesses', requireAuth, requireRoles('partner_admin'), (req,res)=>res.send(businessesHtml(req,'partner')));
app.get('/admin/partner/analytics', requireAuth, requireRoles('partner_admin'), (req,res)=>res.send(partnerAnalyticsHtml(req)));
app.get('/admin/partner/events', requireAuth, requireRoles('partner_admin'), (req,res)=>res.send(partnerEventsHtml(req)));
app.get('/admin/partner/businesses/:id(\\d+)', requireAuth, requireRoles('partner_admin'), (req,res)=>{ const company=db.prepare('SELECT c.*, p.name AS partner_name FROM companies c LEFT JOIN partners p ON p.id=c.partner_id WHERE c.id=?').get(req.params.id); if(!company) return res.status(404).send('Бизнес не найден'); if(!canAccessCompany(req,company.id)) return res.status(403).send('Нет доступа к бизнесу'); res.send(businessDetailHtml(req,company,'partner')); });
app.post('/admin/partner/businesses/:id(\\d+)', requireAuth, requireRoles('partner_admin'), (req,res)=>{ try{ const c=db.prepare('SELECT * FROM companies WHERE id=?').get(req.params.id); if(!c) return res.status(404).send('Бизнес не найден'); if(!canAccessCompany(req,c.id)) return res.status(403).send('Нет доступа к бизнесу'); updateBusinessByAdmin(req,c,'partner'); res.redirect(`/admin/partner/businesses/${c.id}`); }catch(e){ res.status(400).send(e.message); } });

app.post('/admin/platform/businesses/:id(\\d+)/managers/:managerId(\\d+)/invite', requireAuth, requireRoles('super_admin'), (req,res)=>{
  const c=db.prepare('SELECT * FROM companies WHERE id=?').get(req.params.id); if(!c) return res.status(404).send('Бизнес не найден');
  const m=db.prepare('SELECT * FROM managers WHERE id=? AND company_id=?').get(req.params.managerId,c.id); if(!m) return res.status(404).send('Пользователь не найден');
  const token=createAccountInvite(req,m.id,'business',c.id,c.partner_id||null);
  res.redirect(`/admin/platform/businesses/${c.id}?invite=${encodeURIComponent(token)}`);
});
app.post('/admin/partner/businesses/:id(\\d+)/managers/:managerId(\\d+)/invite', requireAuth, requireRoles('partner_admin'), (req,res)=>{
  const c=db.prepare('SELECT * FROM companies WHERE id=?').get(req.params.id); if(!c) return res.status(404).send('Бизнес не найден');
  if(!canAccessCompany(req,c.id)) return res.status(403).send('Нет доступа к бизнесу');
  const m=db.prepare('SELECT * FROM managers WHERE id=? AND company_id=?').get(req.params.managerId,c.id); if(!m) return res.status(404).send('Пользователь не найден');
  const token=createAccountInvite(req,m.id,'business',c.id,c.partner_id||null);
  res.redirect(`/admin/partner/businesses/${c.id}?invite=${encodeURIComponent(token)}`);
});
app.post('/admin/platform/partners/:id(\\d+)/managers/:managerId(\\d+)/invite', requireAuth, requireRoles('super_admin'), (req,res)=>{
  const p=db.prepare('SELECT * FROM partners WHERE id=?').get(req.params.id); if(!p) return res.status(404).send('Партнёр не найден');
  const m=db.prepare("SELECT * FROM managers WHERE id=? AND partner_id=? AND role='partner_admin'").get(req.params.managerId,p.id); if(!m) return res.status(404).send('Партнёрский пользователь не найден');
  const token=createAccountInvite(req,m.id,'partner',null,p.id);
  res.redirect(`/admin/platform/partners/${p.id}?invite=${encodeURIComponent(token)}`);
});

app.post('/admin/platform/partners/new', requireAuth, requireRoles('super_admin'), (req,res)=>{
  const name=String(req.body.name||'').trim(); if(!name) return res.status(400).send('Название партнёра обязательно');
  const info=db.prepare('INSERT INTO partners (name,slug,contact_name,phone,email,status,created_by) VALUES (?,?,?,?,?,\'active\',?)').run(name, uniquePartnerSlug(name), req.body.contact_name||'', req.body.phone||'', req.body.email||'', req.session.manager.id);
  const login=String(req.body.login||'').trim(); if(login) db.prepare('INSERT INTO managers (partner_id,login,password_hash,role,name,email,must_change_password) VALUES (?,?,?,?,?,?,1)').run(info.lastInsertRowid, login, bcrypt.hashSync(req.body.password || (process.env.DISABLE_RATE_LIMITS==='1' ? 'change-me' : strongTempPassword()),10), 'partner_admin', req.body.contact_name||name, req.body.email||'');
  log(req.session.manager.id,null,'create_partner','partner',info.lastInsertRowid,name); res.redirect('/admin/platform');
});
function createBusinessFromRequest(req, forcedPartnerId=null){
  const partnerId = forcedPartnerId !== null ? forcedPartnerId : (req.body.partner_id ? Number(req.body.partner_id) : null);
  if(isPartner(req) && Number(partnerId) !== Number(req.session.manager.partner_id)) throw new Error('Нельзя создать бизнес вне своей партнёрской зоны');
  const name=String(req.body.name||'').trim(); if(!name) throw new Error('Название бизнеса обязательно');
  const slug=uniqueCompanySlug(name);
  const info=db.prepare(`INSERT INTO companies (partner_id,name,slug,city,phone,email,contact_label,accent_color,footer_text,account_status,plan,created_by_manager_id)
    VALUES (@partner_id,@name,@slug,@city,@phone,@email,'Связаться','#B47A3D','Страница создана при поддержке Память QR','active','standard',@created_by)`).run({partner_id:partnerId,name,slug,city:req.body.city||'',phone:req.body.phone||'',email:req.body.email||'',created_by:req.session.manager.id});
  const company=db.prepare('SELECT * FROM companies WHERE id=?').get(info.lastInsertRowid);
  ensureDefaultLandingForCompany(company);
  const login=String(req.body.login||'').trim(); if(login) db.prepare('INSERT INTO managers (company_id,partner_id,login,password_hash,role,name,email,must_change_password) VALUES (?,?,?,?,?,?,?,1)').run(company.id, partnerId, login, bcrypt.hashSync(req.body.password || (process.env.DISABLE_RATE_LIMITS==='1' ? 'change-me' : strongTempPassword()),10), 'business_owner', name, req.body.email||'');
  log(req.session.manager.id,company.id,'create_business','company',company.id,name,{partner_id:partnerId});
  return company;
}
app.post('/admin/platform/businesses/new', requireAuth, requireRoles('super_admin'), (req,res)=>{ try{ createBusinessFromRequest(req,null); res.redirect('/admin/platform'); }catch(e){ res.status(400).send(e.message); } });
app.post('/admin/partner/businesses/new', requireAuth, requireRoles('partner_admin'), (req,res)=>{ try{ createBusinessFromRequest(req,req.session.manager.partner_id); res.redirect('/admin/partner'); }catch(e){ res.status(400).send(e.message); } });
app.post('/admin/platform/businesses/:id(\\d+)/impersonate', requireAuth, requireRoles('super_admin'), (req,res)=>{
  const id=Number(req.params.id);
  const company = db.prepare("SELECT id, name FROM companies WHERE id=? AND is_active=1 AND account_status != 'archived'").get(id);
  if(!company) return res.status(404).send('Бизнес не найден');
  startBusinessImpersonation(req,id);
  audit(req,'impersonate_business','company',id,company.name,{scope:'platform'});
  res.redirect('/admin');
});
app.post('/admin/partner/businesses/:id(\\d+)/impersonate', requireAuth, requireRoles('partner_admin'), (req,res)=>{
  const id=Number(req.params.id);
  const company = db.prepare('SELECT id, name FROM companies WHERE id=?').get(id);
  if(!company) return res.status(404).send('Бизнес не найден');
  if(!canAccessCompany(req,id)) return res.status(403).send('Нет доступа к бизнесу');
  startBusinessImpersonation(req,id);
  audit(req,'impersonate_business','company',id,company.name,{scope:'partner'});
  res.redirect('/admin');
});
app.post('/admin/impersonation/exit', requireAuth, (req,res)=>{
  const role = req.session.manager?.role;
  const company = currentCompany(req);
  if(req.session.manager?.impersonator_id){
    audit(req,'exit_impersonation','company',company?.id || req.session.manager.company_id || null,company?.name || 'business',{scope:role === 'partner_admin' ? 'partner' : 'platform'});
  }
  stopBusinessImpersonation(req);
  if(role === 'super_admin') return res.redirect('/admin/platform');
  if(role === 'partner_admin') return res.redirect('/admin/partner');
  res.redirect('/admin');
});

// Platform/partner audit dashboards must be reachable before the business-cabinet guard.
app.get('/admin/platform/audit', requireAuth, requireRoles('super_admin'), (req,res)=>res.send(auditDashboardHtml(req,'platform')));
app.get('/admin/partner/audit', requireAuth, requireRoles('partner_admin'), (req,res)=>res.send(auditDashboardHtml(req,'partner')));


function boolStatus(ok){ return ok ? 'OK' : 'Требует внимания'; }
function checkRow(title, ok, note){
  return `<tr><td><b>${h(title)}</b></td><td><span class="status-pill ${ok?'ok':'warn'}">${h(boolStatus(ok))}</span></td><td>${h(note||'')}</td></tr>`;
}
function platformHealthSnapshot(req){
  const companies = db.prepare('SELECT COUNT(*) AS n FROM companies WHERE is_active=1').get().n;
  const managers = db.prepare('SELECT COUNT(*) AS n FROM managers WHERE is_active=1').get().n;
  const partners = db.prepare("SELECT COUNT(*) AS n FROM partners WHERE status!='archived'").get().n;
  const published = db.prepare("SELECT COUNT(*) AS n FROM memorials WHERE status='published'").get().n;
  const events24 = db.prepare("SELECT COUNT(*) AS n FROM analytics_events WHERE created_at >= datetime('now','-1 day')").get().n;
  const audit24 = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE created_at >= datetime('now','-1 day')").get().n;
  const backups = db.prepare("SELECT COUNT(*) AS n FROM export_jobs WHERE type='business_backup'").get().n;
  const connectedDomains = db.prepare("SELECT COUNT(*) AS n FROM companies WHERE custom_domain IS NOT NULL AND custom_domain<>'' AND domain_status='connected'").get().n;
  const prodSecretOk = SESSION_SECRET && SESSION_SECRET !== 'dev-secret-change-me' && SESSION_SECRET.length >= 24;
  const dbWal = db.prepare('PRAGMA journal_mode').get()?.journal_mode === 'wal';
  const roleIsolationOk = db.prepare("SELECT COUNT(*) AS n FROM managers WHERE role='partner_admin' AND (partner_id IS NULL OR company_id IS NOT NULL)").get().n === 0
    && db.prepare("SELECT COUNT(*) AS n FROM managers WHERE role IN ('business_owner','business_operator','manager') AND company_id IS NULL").get().n === 0;
  const activeWithoutLanding = db.prepare("SELECT COUNT(*) AS n FROM companies c LEFT JOIN landing_pages l ON l.company_id=c.id WHERE c.is_active=1 AND l.id IS NULL").get().n;
  const uploadRootOk = fs.existsSync(UPLOAD_ROOT) && fs.statSync(UPLOAD_ROOT).isDirectory();
  const checks = [
    { key:'session_secret', title:'SESSION_SECRET', ok:prodSecretOk || !IS_PROD, note: prodSecretOk ? 'production-safe secret configured' : (IS_PROD ? 'set SESSION_SECRET length >= 24' : 'development mode') },
    { key:'database_wal', title:'SQLite WAL', ok:dbWal, note: dbWal ? 'WAL enabled' : 'WAL disabled' },
    { key:'role_isolation', title:'Role isolation', ok:roleIsolationOk, note: roleIsolationOk ? 'managers have valid partner/business scope' : 'invalid manager scopes found' },
    { key:'landing_presence', title:'Landing records', ok:activeWithoutLanding===0, note: activeWithoutLanding ? `${activeWithoutLanding} active businesses without landing` : 'all active businesses have landing' },
    { key:'uploads', title:'Uploads directory', ok:uploadRootOk, note: uploadRootOk ? 'uploads storage is writable/mounted' : 'uploads directory missing' },
    { key:'backups', title:'Backup history', ok:backups>=0, note: `${backups} backup jobs logged` },
    { key:'audit', title:'Audit trail', ok:audit24>=0, note: `${audit24} audit records in 24h` },
    { key:'domains', title:'Custom domains', ok:true, note: `${connectedDomains} connected domains` }
  ];
  return { generated_at: new Date().toISOString(), metrics:{ companies, managers, partners, published_memorials: published, analytics_events_24h: events24, audit_events_24h: audit24, business_backups: backups, connected_domains: connectedDomains }, checks, ready: checks.every(c=>c.ok) };
}
function platformHealthHtml(req){
  const snap = platformHealthSnapshot(req);
  log(req.session.manager.id, null, 'platform_health_checked', 'platform', null, 'Enterprise hardening', { ready:snap.ready, metrics:snap.metrics });
  const cards = [
    ['Бизнесов', snap.metrics.companies], ['Партнёров', snap.metrics.partners], ['Пользователей', snap.metrics.managers], ['Опубликовано страниц', snap.metrics.published_memorials], ['События 24ч', snap.metrics.analytics_events_24h], ['Audit 24ч', snap.metrics.audit_events_24h]
  ].map(([a,b])=>`<div><b>${h(b)}</b><span>${h(a)}</span></div>`).join('');
  return layout(req,'Enterprise health',`<div class="top"><h1>Enterprise health</h1><a class="btn muted" href="/admin/platform/health.json">JSON</a></div>
    <section class="panel"><h2>Готовность платформы</h2><p>Контрольный список перед подключением реальных клиентов: безопасность, роли, домены, backup и аудит.</p><div class="cards small-cards">${cards}</div></section>
    <section class="panel"><h2>Hardening checklist</h2><table><tr><th>Проверка</th><th>Статус</th><th>Комментарий</th></tr>${snap.checks.map(c=>checkRow(c.title,c.ok,c.note)).join('')}</table></section>
    <section class="panel"><h2>Operational notes</h2><ul><li>Перед релизом запускать полный QA: <code>npm run test:e2e:full</code>.</li><li>Для production задать <code>SESSION_SECRET</code>, HTTPS/Nginx, постоянное хранилище uploads и регулярные backups.</li><li>Проверять custom domain через <code>/.well-known/pamyat-domain-check</code>.</li></ul></section>`);
}

function fileExistsRel(relPath){
  try { return fs.existsSync(path.join(ROOT, relPath)); } catch { return false; }
}
function releaseReadinessSnapshot(req){
  const health = platformHealthSnapshot(req);
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'), 'utf8'));
  const requiredScripts = ['check','seed','test:e2e','test:e2e:full','test:debug-pack','start'];
  const requiredDocs = ['README.md','LOCAL_START.md','docs/SECURITY_PRODUCTION.md','docs/QA_PLAYWRIGHT.md','docs/DEPLOY_DOMAINS_SEO.md','docs/RELEASE_CHECKLIST.md','docs/RELEASE_RUNBOOK.md','docs/FIRST_CLIENT_CHECKLIST.md','docs/CLIENT_DEMO_SCRIPT.md','docs/ROLES_AND_ACCESS.md','docs/CLIENT_HANDOFF_MESSAGE.md'];
  const checks = [
    ...health.checks,
    { key:'qa_fast_script', title:'Быстрый QA-профиль', ok:requiredScripts.every(k=>!!packageJson.scripts?.[k]), note: requiredScripts.every(k=>!!packageJson.scripts?.[k]) ? 'основные npm-скрипты на месте' : 'не хватает npm-скриптов для проверки' },
    { key:'release_docs', title:'Документация запуска', ok:requiredDocs.every(fileExistsRel), note: requiredDocs.filter(fileExistsRel).length + ' из ' + requiredDocs.length + ' документов готовы' },
    { key:'invite_security', title:'Безопасная активация клиентов', ok:db.prepare("SELECT COUNT(*) n FROM account_invites WHERE used_at IS NULL OR used_at IS NOT NULL").get().n >= 0, note:'одноразовые invite-ссылки и hash-токены включены' },
    { key:'public_pages', title:'Публичные страницы', ok:health.metrics.published_memorials >= 0, note:`${health.metrics.published_memorials} опубликованных страниц памяти` }
  ];
  const critical = checks.filter(c=>!c.ok);
  const commands = [
    'npm install',
    'npm run seed',
    'npm run check',
    'npm run test:e2e',
    'npm run test:e2e:full',
    'npm run test:debug-pack'
  ];
  return { generated_at:new Date().toISOString(), ready:critical.length===0, metrics:health.metrics, checks, critical, commands };
}
function releaseReadinessHtml(req){
  const snap = releaseReadinessSnapshot(req);
  audit(req,'release_readiness_viewed','platform',null,'Релизная готовность',{ready:snap.ready, failed:snap.critical.length});
  const cards = [
    ['Готовность', snap.ready ? 'OK' : 'Проверить'],
    ['Бизнесов', snap.metrics.companies],
    ['Партнёров', snap.metrics.partners],
    ['Опубликованных страниц', snap.metrics.published_memorials],
    ['Событий 24ч', snap.metrics.analytics_events_24h],
    ['Audit 24ч', snap.metrics.audit_events_24h]
  ].map(([a,b])=>`<div class="metric"><span>${h(a)}</span><b>${h(b)}</b></div>`).join('');
  return layout(req,'Релизная готовность',`<div class="top"><div><h1>Релизная готовность</h1><p>Финальная панель перед показом продукта первым клиентам: безопасность, роли, публичные страницы, документация и QA.</p></div><a class="btn muted" href="/admin/platform/release.json">JSON</a></div>
    <section class="metric-grid platform-metrics">${cards}</section>
    <section class="panel"><h2>Что проверено</h2><table><tr><th>Блок</th><th>Статус</th><th>Комментарий</th></tr>${snap.checks.map(c=>checkRow(c.title,c.ok,c.note)).join('')}</table></section>
    <section class="panel"><h2>Команды перед релизом</h2><p class="muted-text">Короткий прогон — перед каждой сессией. Полный прогон — перед демонстрацией клиенту и перед выкладкой.</p><pre>${h(snap.commands.join('\n'))}</pre></section>
    <section class="panel"><h2>Порядок показа клиенту</h2><ol><li>Создать бизнес в платформенной или партнёрской админке.</li><li>Сгенерировать одноразовую ссылку подключения.</li><li>Клиент задаёт пароль сам и попадает в «Первый запуск».</li><li>Настроить данные компании, лендинг, первую страницу памяти и QR.</li><li>Показать публичный лендинг и страницу памяти на телефоне.</li></ol><p class="muted-text">Документы для запуска: <code>docs/RELEASE_RUNBOOK.md</code>, <code>docs/FIRST_CLIENT_CHECKLIST.md</code>, <code>docs/CLIENT_DEMO_SCRIPT.md</code>, <code>docs/ROLES_AND_ACCESS.md</code>.</p></section>`);
}

app.get('/admin/platform/health', requireAuth, requireRoles('super_admin'), (req,res)=>res.send(platformHealthHtml(req)));
app.get('/admin/platform/release', requireAuth, requireRoles('super_admin'), (req,res)=>res.send(releaseReadinessHtml(req)));
app.get('/admin/platform/release.json', requireAuth, requireRoles('super_admin'), (req,res)=>res.json(releaseReadinessSnapshot(req)));
app.get('/admin/platform/health.json', requireAuth, requireRoles('super_admin'), (req,res)=>{ const snap=platformHealthSnapshot(req); log(req.session.manager.id,null,'platform_health_json_checked','platform',null,'Enterprise hardening JSON',{ready:snap.ready}); res.json(snap); });
app.get('/admin/platform/plans', requireAuth, requireRoles('super_admin'), (req,res)=>{ audit(req,'platform_plans_viewed','platform',null,'Тарифы и лимиты'); res.send(platformPlansHtml(req)); });
app.get('/admin/plan', requireAuth, requireCompanyContext, (req,res)=>{ const c=req.company; audit(req,'business_plan_viewed','company',c.id,c.name,{plan:c.plan||'standard'}); res.send(layout(req,'Тариф и лимиты',`<div class="top"><h1>Тариф и лимиты</h1></div>${planCardsHtml(c)}<section class="panel"><h2>Что ограничивается</h2><p class="muted-text">Лимиты применяются на сервере. Если лимит страниц памяти исчерпан, создание новой страницы блокируется до смены тарифа.</p></section>`)); });


// All business cabinet routes below require an explicitly selected company.
// This prevents platform/partner users from touching business data by direct URL
// before they open an allowed business in help/impersonation mode.
app.use('/admin', requireAuth, requireCompanyContext);

app.get('/admin/start', requireAuth, (req,res)=>res.send(quickStartHtml(req)));
app.get('/admin/help', requireAuth, (req,res)=>res.send(managerPlainHelpHtml(req)));
app.get('/admin/materials', requireAuth, (req,res)=>res.send(clientMaterialsHtml(req)));

function firstClientOnboardingHtml(req){
  const company = currentCompany(req);
  if(!company) return layout(req,'Первый запуск','<section class="panel"><h1>Первый запуск</h1><p>Компания не найдена.</p></section>');
  const st = quickStartStatus(company);
  const items = [
    {done:st.companyReady, title:'Данные компании', text:'Название, город и телефон для семей.', href:'/admin/company'},
    {done:st.landingReady, title:'Лендинг для семей', text:'Страница, где семья понимает услугу и оставляет заявку.', href:'/admin/landing'},
    {done:st.memorials>0, title:'Первая страница памяти', text:'ФИО, фото, история жизни и воспоминания.', href:'/admin/memorials/new'},
    {done:st.published>0, title:'Публикация', text:'Откройте страницу по ссылке для семьи.', href:'/admin/memorials'},
    {done:st.qrReady>0, title:'QR-комплект', text:'Скачайте QR-код для печати или таблички.', href:'/admin/memorials'},
    {done:st.addressReady, title:'Адрес для семей', text:`${BASE_URL}/l/${company.slug}`, href:'/admin/deploy'}
  ];
  const done = items.filter(x=>x.done).length;
  const next = items.find(x=>!x.done) || null;
  return layout(req,'Первый запуск',`<div class="top"><div><h1>Первый запуск</h1><p>Проверьте основные шаги. Когда всё будет готово, этот экран можно больше не открывать.</p></div><a class="btn" href="${h(next?.href || '/admin')}">${next ? 'Продолжить' : 'Перейти на главную'}</a></div>
    <section class="panel quick-start-hero"><div><span class="guided-step-kicker">Клиент подключён безопасно</span><h2>${done} из ${items.length} шагов готово</h2><p>Пароль создан владельцем аккаунта через одноразовую ссылку. Передавать пароль по телефону или в мессенджере не нужно.</p></div><div class="quick-start-score"><b>${Math.round(done/items.length*100)}%</b><span>готовности</span></div></section>
    <section class="quick-start-grid">${items.map((x,i)=>`<article class="panel quick-start-card ${x.done?'done':''}"><div class="quick-start-num">${x.done?'✓':i+1}</div><div><h2>${h(x.title)}</h2><p>${h(x.text)}</p><a class="btn ${x.done?'muted':''}" href="${h(x.href)}">Открыть</a></div></article>`).join('')}</section>
    <section class="panel"><h2>Что делать каждый день</h2><div class="grid3"><div><b>Создавать страницы памяти</b><p>Добавляйте фото, историю и воспоминания.</p></div><div><b>Скачивать QR</b><p>Передавайте QR для печати или таблички.</p></div><div><b>Обрабатывать заявки</b><p>Новые обращения семьи попадут в CRM.</p></div></div></section>`);
}

app.get('/admin/onboarding', requireAuth, requireRoles('business_owner','business_operator'), (req,res)=>res.send(firstClientOnboardingHtml(req)));

app.get('/admin', requireAuth, (req,res)=>{
  const cid=req.session.manager.company_id;
  const stats={
    memorials: db.prepare('SELECT COUNT(*) c FROM memorials WHERE company_id=?').get(cid).c,
    published: db.prepare("SELECT COUNT(*) c FROM memorials WHERE company_id=? AND status='published'").get(cid).c,
    submissions: db.prepare('SELECT COUNT(*) c FROM memorial_submissions WHERE company_id=?').get(cid).c,
    new_submissions: db.prepare("SELECT COUNT(*) c FROM memorial_submissions WHERE company_id=? AND status='new'").get(cid).c,
    ready_review: db.prepare("SELECT COUNT(*) c FROM memorial_submissions WHERE company_id=? AND status='ready_review'").get(cid).c,
    views: db.prepare("SELECT COUNT(*) c FROM analytics_events WHERE company_id=? AND event_type IN ('memorial_view','landing_view')").get(cid).c
  };
  const recent = db.prepare('SELECT * FROM memorials WHERE company_id=? ORDER BY updated_at DESC LIMIT 6').all(cid);
  const latestSubmissions = db.prepare('SELECT * FROM memorial_submissions WHERE company_id=? ORDER BY updated_at DESC, created_at DESC LIMIT 8').all(cid);
  const tasks = [];
  if(stats.new_submissions) tasks.push(`<a href="/admin/crm?status=new"><b>${stats.new_submissions}</b><span>новых заявок ждут первичной обработки</span></a>`);
  if(stats.ready_review) tasks.push(`<a href="/admin/crm?status=ready_review"><b>${stats.ready_review}</b><span>заявок готовы к проверке</span></a>`);
  const pagesWithoutQr = db.prepare("SELECT COUNT(*) c FROM memorials WHERE company_id=? AND status='published' AND (qr_png_path IS NULL OR qr_png_path='')").get(cid).c;
  if(pagesWithoutQr) tasks.push(`<a href="/admin/memorials"><b>${pagesWithoutQr}</b><span>опубликованных страниц без QR-комплекта</span></a>`);
  res.send(layout(req,'Главная',`<div class="top"><h1>Главная</h1><div><a class="btn muted" href="/admin/crm">Открыть CRM-доску</a><a class="btn" href="/admin/memorials/new">Создать страницу памяти</a></div></div>
    ${managerCommandCenterHtml(currentCompany(req), stats)}
    ${stepGuideHtml('dashboard', currentCompany(req), stats)}
    ${onboardingChecklistHtml(currentCompany(req), stats)}
    <div class="cards dashboard-cards"><div><b>${stats.memorials}</b><span>страниц памяти</span></div><div><b>${stats.published}</b><span>опубликовано</span></div><div><b>${stats.submissions}</b><span>заявок семьи</span></div><div><b>${stats.views}</b><span>событий</span></div></div>
    <section class="panel"><h2>Что требует внимания</h2><div class="task-list">${tasks.join('') || '<p class="muted-text">Критичных задач сейчас нет.</p>'}</div></section>
    <div class="grid2"><section class="panel"><h2>Последние заявки</h2><table><tr><th>ФИО</th><th>Статус</th><th>Контакт</th><th></th></tr>${latestSubmissions.map(s=>`<tr><td>${h(s.full_name)}</td><td><span class="status-badge ${h(s.status)}">${h(statusLabel(s.status))}</span></td><td>${h(s.contact_phone||s.messenger||s.notify_email||'')}</td><td><a href="/admin/submissions/${s.id}">открыть</a></td></tr>`).join('') || '<tr><td colspan="4">Пока нет заявок</td></tr>'}</table></section>
    <section class="panel"><h2>Последние страницы</h2><table><tr><th>ФИО</th><th>Статус</th><th>Свечи</th><th></th></tr>${recent.map(m=>`<tr><td>${h(m.full_name)}</td><td>${h(m.status)}</td><td>${m.candles_count}</td><td><a href="/admin/memorials/${m.id}">редактировать</a> · <a href="/admin/memorials/${m.id}/publish">публикация</a></td></tr>`).join('') || '<tr><td colspan="4">Пока нет страниц</td></tr>'}</table></section></div>`));
});


app.get('/admin/notifications', requireAuth, (req,res)=>{
  const c=currentCompany(req);
  const filters=eventsFilters(req);
  const params=[c.id];
  let where=notificationWhereParts('n.company_id=?', params, filters);
  const logs=db.prepare(`SELECT n.*, c.name AS company_name FROM notification_log n LEFT JOIN companies c ON c.id=n.company_id WHERE ${where} ORDER BY n.created_at DESC, n.id DESC LIMIT 120`).all(...params);
  const unread=db.prepare('SELECT COUNT(*) c FROM notification_log WHERE company_id=? AND read_at IS NULL').get(c.id).c;
  const types=db.prepare('SELECT event_type, COUNT(*) count FROM notification_log WHERE company_id=? GROUP BY event_type ORDER BY count DESC').all(c.id);
  res.send(layout(req,'Уведомления и события',`<div class="top"><h1>Уведомления и события</h1><div><form class="inline-form" method="post" action="/admin/notifications/read-all"><button class="btn muted">Отметить всё прочитанным</button></form><form class="inline-form" method="post" action="/admin/notifications/test"><button class="btn muted">Отправить тест</button></form></div></div>
    <section class="panel event-summary"><h2>Центр событий</h2><div class="cards small-cards"><div><b>${unread}</b><span>непрочитанных</span></div><div><b>${logs.length}</b><span>событий в выборке</span></div><div><b>${types.length}</b><span>типов событий</span></div></div></section>
    <section class="panel crm-toolbar"><form method="get" class="crm-filters"><label><span>Канал</span><select name="channel"><option value="all">Все</option><option value="system" ${filters.channel==='system'?'selected':''}>Системные</option><option value="email" ${filters.channel==='email'?'selected':''}>Email</option><option value="telegram" ${filters.channel==='telegram'?'selected':''}>Telegram</option></select></label><label><span>Состояние</span><select name="unread"><option value="all">Все</option><option value="1" ${filters.unread==='1'?'selected':''}>Непрочитанные</option><option value="0" ${filters.unread==='0'?'selected':''}>Прочитанные</option></select></label><label><span>Тип</span><select name="event_type"><option value="all">Все типы</option>${types.map(t=>`<option value="${h(t.event_type)}" ${filters.event_type===t.event_type?'selected':''}>${h(eventTypeLabel(t.event_type))} · ${t.count}</option>`).join('')}</select></label><button class="btn muted">Фильтр</button></form></section>
    <section class="panel"><h2>Лента событий</h2><table><tr><th>Дата</th><th>Приоритет</th><th>Событие</th><th>Детали</th><th>Статус</th><th></th></tr>${logs.map(l=>eventRowHtml(l,false)).join('') || '<tr><td colspan="6">Пока нет событий</td></tr>'}</table></section>
    <form class="panel form" method="post">
      <h2>Каналы отправки</h2>
      <div class="checks">${checkbox('notifications_enabled','Уведомления включены',c.notifications_enabled!==0)}${checkbox('notify_email_enabled','Email включён',c.notify_email_enabled)}${checkbox('notify_telegram_enabled','Telegram включён',c.notify_telegram_enabled)}</div>
      <div class="grid2">${input('manager_notification_email','Email менеджера для уведомлений',c.manager_notification_email||c.email||'')}${input('notification_from_email','Email отправителя',c.notification_from_email||'')}${input('notification_reply_to','Reply-To',c.notification_reply_to||'')}${input('telegram_chat_id','Telegram chat ID',c.telegram_chat_id||'')}${input('telegram_bot_token','Telegram bot token',c.telegram_bot_token||'')}</div>
      <h2>SMTP</h2><div class="grid2">${input('smtp_host','SMTP host',c.smtp_host||'')}${input('smtp_port','SMTP port',c.smtp_port||587,'number')}${input('smtp_user','SMTP user',c.smtp_user||'')}${input('smtp_pass','SMTP password',c.smtp_pass||'password','Пароль хранится в базе. Для production лучше использовать .env или отдельные секреты.')}</div>${checkbox('smtp_secure','SMTP secure SSL/TLS',c.smtp_secure)}
      <h2>События для внешней отправки</h2><div class="checks">${checkbox('notify_on_new_submission','Новая заявка семьи',c.notify_on_new_submission!==0)}${checkbox('notify_on_new_memory','Новые слова на странице памяти',c.notify_on_new_memory!==0)}${checkbox('notify_on_publish','Публикация страницы памяти',c.notify_on_publish)}</div>
      <h2>Письмо семье после одобрения</h2>${input('family_approval_subject','Тема письма семье',c.family_approval_subject||'Ваши материалы одобрены')}${textarea('family_approval_body','Текст письма семье',c.family_approval_body||'',6)}
      <button class="btn">Сохранить уведомления</button>
    </form>`));
});
app.post('/admin/notifications/read-all', requireAuth, (req,res)=>{
  const c=currentCompany(req);
  db.prepare('UPDATE notification_log SET read_at=CURRENT_TIMESTAMP WHERE company_id=? AND read_at IS NULL').run(c.id);
  audit(req,'mark_notifications_read','notification',null,c.name);
  res.redirect('/admin/notifications');
});
app.post('/admin/notifications', requireAuth, (req,res)=>{
  const c=currentCompany(req);
  db.prepare(`UPDATE companies SET notifications_enabled=@notifications_enabled, notify_email_enabled=@notify_email_enabled, notify_telegram_enabled=@notify_telegram_enabled,
    manager_notification_email=@manager_notification_email, notification_from_email=@notification_from_email, notification_reply_to=@notification_reply_to,
    smtp_host=@smtp_host, smtp_port=@smtp_port, smtp_secure=@smtp_secure, smtp_user=@smtp_user, smtp_pass=@smtp_pass,
    telegram_bot_token=@telegram_bot_token, telegram_chat_id=@telegram_chat_id,
    notify_on_new_submission=@notify_on_new_submission, notify_on_new_memory=@notify_on_new_memory, notify_on_publish=@notify_on_publish,
    family_approval_subject=@family_approval_subject, family_approval_body=@family_approval_body, updated_at=CURRENT_TIMESTAMP WHERE id=@id`).run({
      ...req.body, id:c.id,
      notifications_enabled:req.body.notifications_enabled?1:0,
      notify_email_enabled:req.body.notify_email_enabled?1:0,
      notify_telegram_enabled:req.body.notify_telegram_enabled?1:0,
      smtp_secure:req.body.smtp_secure?1:0,
      notify_on_new_submission:req.body.notify_on_new_submission?1:0,
      notify_on_new_memory:req.body.notify_on_new_memory?1:0,
      notify_on_publish:req.body.notify_on_publish?1:0
    });
  audit(req,'update_notifications','company',c.id,c.name);
  res.redirect('/admin/notifications');
});
app.post('/admin/notifications/test', requireAuth, (req,res)=>{
  const c=currentCompany(req);
  notifyCompany(c, 'test', 'Тест уведомлений Память QR', `Проверка отправки уведомлений для компании ${c.name}.`, { relatedType:'company', relatedId:c.id }).catch(()=>{});
  audit(req,'send_test_notification','company',c.id,c.name);
  res.redirect('/admin/notifications');
});

app.get('/admin/company', requireAuth, (req,res)=>{
  const c=currentCompany(req);
  res.send(layout(req,'Компания',`<div class="top"><h1>Компания</h1><a class="btn muted" href="/l/${c.slug}" target="_blank">Открыть лендинг</a></div>${stepGuideHtml('company', c)}<form class="panel form" method="post" enctype="multipart/form-data"><div class="grid2">${input('name','Название компании',c.name)}${input('slug','Slug компании',c.slug)}${input('city','Город',c.city)}${input('phone','Телефон',c.phone)}${input('email','Email',c.email)}${input('website_url','Сайт',c.website_url)}${input('telegram_url','Telegram',c.telegram_url)}${input('whatsapp_url','WhatsApp',c.whatsapp_url)}${input('vk_url','VK',c.vk_url)}${input('contact_label','Текст кнопки связи',c.contact_label)}${input('accent_color','Акцентный цвет',c.accent_color,'color')} ${checkbox('white_label_enabled','Бренд компании включён',c.white_label_enabled)}${checkbox('hide_platform_branding','Скрыть подпись Память QR на публичных страницах',c.hide_platform_branding)}${input('brand_display_name','Название для семей',c.brand_display_name||c.name)}${input('public_footer_brand','Подпись внизу публичных страниц',c.public_footer_brand||c.name)}${input('custom_domain','Адрес сайта',c.custom_domain)}${select('domain_status','Состояние адреса',c.domain_status||'not_connected', [['not_connected','Не подключён'],['pending','Ожидает DNS'],['connected','Подключён'],['error','Ошибка']])}${select('robots_policy','Показ в поисковых системах',c.robots_policy||'default', [['default','По умолчанию'],['noindex_all','Закрыть всё'],['allow_public','Индексировать публичное']])}${input('manager_timezone','Часовой пояс',c.manager_timezone||'Europe/Moscow')}</div>${textarea('domain_notes','Заметки по адресу сайта',c.domain_notes||'',3)}${textarea('footer_text','Текст в футере',c.footer_text,3)}<div class="grid2">${input('legal_name','Юридическое имя',c.legal_name)}${input('privacy_url','Ссылка на политику',c.privacy_url)}${input('data_contact','Контакт по данным',c.data_contact)}${input('data_email','Email по данным',c.data_email)}</div><label class="field"><span>Логотип</span><input type="file" name="logo" accept="image/*"></label>${checkbox('is_active','Компания активна',c.is_active)}<button class="btn">Сохранить компанию</button></form>`));
});
app.post('/admin/company', requireAuth, upload.single('logo'), async (req,res,next)=>{ try{
  const c=currentCompany(req); let logo=c.logo; const img=await saveImage(req.file,'logos',{minWidth:200,minHeight:100}); if(img) logo=img.preview;
  db.prepare(`UPDATE companies SET name=@name,slug=@slug,city=@city,phone=@phone,email=@email,website_url=@website_url,telegram_url=@telegram_url,whatsapp_url=@whatsapp_url,vk_url=@vk_url,contact_label=@contact_label,accent_color=@accent_color,white_label_enabled=@white_label_enabled,hide_platform_branding=@hide_platform_branding,brand_display_name=@brand_display_name,public_footer_brand=@public_footer_brand,custom_domain=@custom_domain,domain_status=@domain_status,domain_notes=@domain_notes,robots_policy=@robots_policy,manager_timezone=@manager_timezone,footer_text=@footer_text,legal_name=@legal_name,privacy_url=@privacy_url,data_contact=@data_contact,data_email=@data_email,logo=@logo,is_active=@is_active,updated_at=CURRENT_TIMESTAMP WHERE id=@id`).run({...req.body, logo, white_label_enabled:req.body.white_label_enabled?1:0, hide_platform_branding:req.body.hide_platform_branding?1:0, custom_domain:normalizeDomain(req.body.custom_domain), is_active:req.body.is_active?1:0, id:c.id});
  audit(req,'update_company','company',c.id,req.body.name); res.redirect('/admin/company');
}catch(e){next(e)}});

app.get('/admin/landing', requireAuth, (req,res)=>{
  const company=currentCompany(req); const l=db.prepare('SELECT * FROM landing_pages WHERE company_id=?').get(company.id);
  const contacts=asJson(l.contacts_json,[]), faq=asJson(l.faq_json,[]), nav=asJson(l.nav_json,[]), blocks=asJson(l.blocks_json,{});
  res.send(layout(req,'Лендинг для семей',`<div class="top"><h1>Лендинг для семей</h1><div><a class="btn muted" href="/admin/versions">Версии</a><form class="inline-form" method="post" action="/admin/landing/publish" onsubmit="return confirm('Опубликовать лендинг?')"><button class="btn muted">Опубликовать</button></form><form class="inline-form" method="post" action="/admin/landing/hide" onsubmit="return confirm('Скрыть лендинг?')"><button class="btn muted">Скрыть</button></form><a class="btn muted" target="_blank" href="/admin/landing/preview">Предпросмотр</a><a class="btn" target="_blank" href="/l/${company.slug}">Публичный</a></div></div>${stepGuideHtml('landing', company)}<div class="editor-shell"><section class="editor-column"><form class="panel form live-form" data-editor-kind="landing" data-draft-key="landing-${company.id}" data-draft-signature="${h(String(l.version||0)+'-'+String(l.updated_at||''))}" data-preview-url="/admin/landing/preview" method="post" enctype="multipart/form-data"><h2>Первый экран</h2><div class="grid2">${select('status','Статус',l.status,[['draft','Черновик'],['published','Опубликовано'],['hidden','Скрыто'],['archived','Архив']])}${input('preloader_title','Название компании',l.preloader_title)}${input('hero_title','Главный заголовок',l.hero_title)}${input('hero_subtitle','Пояснение под заголовком',l.hero_subtitle)}${input('hero_primary_label','Главная кнопка',l.hero_primary_label)}${input('hero_primary_url','Адрес главной кнопки',l.hero_primary_url)}${input('hero_secondary_label','Вторая кнопка',l.hero_secondary_label)}${input('hero_secondary_url','Адрес второй кнопки',l.hero_secondary_url)}</div><details class="panel technical-details editor-advanced"><summary>Дополнительные настройки</summary><div class="grid2">${input('seo_title','Заголовок в поиске',l.seo_title)}${input('seo_description','Описание в поиске',l.seo_description)}${checkbox('noindex','Не показывать лендинг в поиске',l.noindex)}${input('og_title','Заголовок при отправке ссылки',l.og_title||l.seo_title)}${input('og_description','Описание при отправке ссылки',l.og_description||l.seo_description)}${input('custom_path','Короткий адрес лендинга',l.custom_path||'/')}</div></details><label class="field"><span>Главное изображение</span><input type="file" name="hero_image" accept="image/*"></label><h2>Какие блоки показывать семьям</h2><div class="checks">${checkbox('featuresVisible','Что получит семья',blocks.featuresVisible!==false)}${checkbox('qrVisible','Объяснение QR-кода',blocks.qrVisible!==false)}${checkbox('faqVisible','FAQ',blocks.faqVisible!==false)}${checkbox('contactsVisible','Контакты',blocks.contactsVisible!==false)}</div><h2>Навигация</h2>${textarea('nav_lines','Меню сверху',nav.map(x=>`${x.label} | ${x.url}`).join('\n'),5)}<h2>Контакты</h2>${textarea('contact_lines','Контакты для семьи',contacts.map(x=>`${x.type||'link'} | ${x.label} | ${x.url}`).join('\n'),6)}<h2>FAQ</h2>${textarea('faq_lines','Вопросы семей',faq.map(x=>`${x.q} | ${x.a}`).join('\n'),8)}<div class="sticky-save"><button class="btn">Сохранить лендинг</button><button class="btn muted" type="button" data-refresh-preview>Обновить предпросмотр</button></div></form></section><aside class="preview-column"><div class="preview-toolbar"><b>Как увидит семья</b><span class="device-switch"><button type="button" data-device="desktop" class="active">Компьютер</button><button type="button" data-device="mobile">Телефон</button></span></div><iframe class="preview-frame" data-live-preview src="/admin/landing/preview"></iframe><div class="click-map"><button type="button" data-focus-field="hero_title">Главный заголовок</button><button type="button" data-focus-field="hero_subtitle">Подзаголовок</button><button type="button" data-focus-field="contact_lines">Контакты</button><button type="button" data-focus-field="faq_lines">FAQ</button></div></aside></div>`));
});
app.post('/admin/landing', requireAuth, upload.single('hero_image'), async (req,res,next)=>{ try{
  const company=currentCompany(req); const old=db.prepare('SELECT * FROM landing_pages WHERE company_id=?').get(company.id); let hero_image=old.hero_image; const img=await saveImage(req.file,'landing',{minWidth:900,minHeight:500}); if(img) hero_image=img.large;
  const nav=parseList(req.body.nav_lines).map(line=>{ const [label,url]=line.split('|').map(s=>s.trim()); return {label,url,visible:true};});
  const contacts=parseList(req.body.contact_lines).map(line=>{ const [type,label,url]=line.split('|').map(s=>s.trim()); return {type,label,url,visible:true};});
  const faq=parseList(req.body.faq_lines).map(line=>{ const [q,...rest]=line.split('|').map(s=>s.trim()); return {q,a:rest.join(' | '),visible:true};});
  const blocks={featuresVisible:!!req.body.featuresVisible,qrVisible:!!req.body.qrVisible,faqVisible:!!req.body.faqVisible,contactsVisible:!!req.body.contactsVisible};
  savePageVersion(req,'landing',old.id,landingSnapshot(old.id),'manual_save');
  db.prepare(`UPDATE landing_pages SET status=@status,seo_title=@seo_title,seo_description=@seo_description,noindex=@noindex,canonical_url=@canonical_url,og_title=@og_title,og_description=@og_description,custom_path=@custom_path,preloader_title=@preloader_title,hero_title=@hero_title,hero_subtitle=@hero_subtitle,hero_primary_label=@hero_primary_label,hero_primary_url=@hero_primary_url,hero_secondary_label=@hero_secondary_label,hero_secondary_url=@hero_secondary_url,hero_image=@hero_image,nav_json=@nav_json,contacts_json=@contacts_json,faq_json=@faq_json,blocks_json=@blocks_json,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE company_id=@company_id`).run({...req.body,canonical_url:req.body.canonical_url||'',noindex:req.body.noindex?1:0,hero_image,nav_json:JSON.stringify(nav),contacts_json:JSON.stringify(contacts),faq_json:JSON.stringify(faq),blocks_json:JSON.stringify(blocks),company_id:company.id});
  audit(req,'update_landing','landing',old.id,company.name); res.redirect('/admin/landing');
}catch(e){next(e)}});

function landingTrustSectionHtml(){
  return `<section class="section panel b2c-trust" id="trust" data-module="b2c-trust"><div class="b2c-trust-copy"><span class="section-kicker">Для семьи</span><h2>Что может храниться на странице памяти</h2><p>Страница помогает собрать главное о близком человеке в одном спокойном месте — без приложения и сложных действий.</p></div><div class="b2c-trust-grid"><article><b>Фотографии разных лет</b><span>портреты, семейные снимки и важные моменты</span></article><article><b>История жизни</b><span>короткий рассказ о человеке, семье и важных событиях</span></article><article><b>Воспоминания близких</b><span>тёплые слова от родных, друзей и коллег</span></article><article><b>Свеча памяти</b><span>тихий символический жест, чтобы почтить память</span></article></div></section>`;
}
function landingTrustCss(){
  return `.b2c-trust{display:grid;grid-template-columns:.9fr 1.1fr;gap:34px;padding:46px 48px;background:linear-gradient(135deg,rgba(255,253,248,.92),rgba(247,237,223,.88))}.b2c-trust-copy p{margin-top:18px;max-width:560px}.b2c-trust-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.b2c-trust-grid article{border:1px solid rgba(154,116,72,.16);background:rgba(255,253,248,.72);border-radius:24px;padding:22px}.b2c-trust-grid b{display:block;font-size:18px;letter-spacing:-.035em;color:var(--ink);margin-bottom:8px}.b2c-trust-grid span{display:block;color:var(--muted);font-size:15px;line-height:1.45}@media(max-width:860px){.b2c-trust{grid-template-columns:1fr;padding:30px 22px}.b2c-trust-grid{grid-template-columns:1fr}}`;
}
function renderLanding(company, landing){
  let html=fs.readFileSync(path.join(ROOT,'templates','landing.template.html'),'utf8');
  const contacts=visibleItems(asJson(landing.contacts_json,[]));
  const nav=visibleItems(asJson(landing.nav_json,[]));
  const faq=asJson(landing.faq_json,[]).filter(x=>x && x.visible !== false && x.q);
  const blocks=asJson(landing.blocks_json,{});
  const heroImage = publicPath(landing.hero_image || '/static/assets/landing/hero-b2c.webp');
  const primaryLabel = landing.hero_primary_label || 'Связаться';
  const primaryUrl = landing.hero_primary_url || '#contacts';
  const secondaryLabel = landing.hero_secondary_label || 'Посмотреть пример';
  const secondaryUrl = landing.hero_secondary_url || '#example';
  const contactLinks = contacts.map(c=>`<a href="${h(contactHref(c))}" ${/^https?:/i.test(contactHref(c))?'target="_blank" rel="noopener"':''}>${h(c.label || c.type || 'Контакт')}</a>`).join('');
  const cleanHeroTitle = (landing.hero_title || 'Сохраните память о близком человеке').trim();
  const cleanHeroSubtitle = (landing.hero_subtitle || 'После сканирования QR-кода откроется страница с фотографиями, историей жизни и воспоминаниями семьи.').trim();
  const navLinks = nav.length ? nav.map((n,i)=>`<a class="${i===0?'active':''}" href="${h(n.url || '#')}">${h(n.label)}</a>`).join('') : '';
  const faqHtml = faq.length ? faq.map((f,i)=>`<div class="faq-item ${i===0?'open':''}"><button class="faq-q"><span>${h(f.q)}</span><span>+</span></button><div class="faq-a"><p>${h(f.a || '')}</p></div></div>`).join('') : '<div class="faq-item open"><button class="faq-q"><span>Пока нет вопросов</span><span>+</span></button><div class="faq-a"><p>Добавьте FAQ в админке.</p></div></div>';
  const publicBrandName = publicBrandNameFor(company, landing.preloader_title || company.name);
  const publicLogo = company.logo ? publicPath(company.logo) : '';
  html=html.replace(/<title>[^<]*<\/title>/,`<title>${h(landing.seo_title||company.name)}</title>`);
  html=html.replace(/Птица\s+Памяти/gi, h(publicBrandName));
  html=html.replace(/Память[-\s]QR/gi, h(publicBrandName));
  if(publicLogo){
    html=html.replace(/<span class="brand-ico"><svg[\s\S]*?<\/svg><\/span>/g, `<span class="brand-ico"><img class="brand-logo" src="${h(publicLogo)}" alt="${h(publicBrandName)}"></span>`);
  }
  html=html.replace(/class="brand-title"/g, `class="brand-title" data-brand-short="${h(publicBrandName)}"`);
  html=html.replace(/<section class="hero" data-module="hero">([\s\S]*?)<h1>[\s\S]*?<\/h1>/, `<section class="hero" data-module="hero">$1<h1>${h(cleanHeroTitle)}</h1>`);
  html=html.replace(/<p class="hero-lead">[\s\S]*?<\/p>/, `<p class="hero-lead">${h(cleanHeroSubtitle)}</p>`);
  html=html.replace(/Страница памяти, которую можно открыть по QR-коду/g,h(cleanHeroTitle));
  html=html.replace(/Семья сохраняет фотографии, слова и историю близкого человека на красивой личной странице\./g,h(cleanHeroSubtitle));
  html=html.replace(/<button class="btn primary" data-open-contact>Спросить, как начать<\/button>/, `<a class="btn primary" href="${h(primaryUrl)}">${h(primaryLabel)}</a>`);
  html=html.replace(/Спросить, как начать/g,h(primaryLabel));
  html=html.replace(/Посмотреть пример/g,h(secondaryLabel));
  html=html.replace(/href="#example"/g,`href="${h(secondaryUrl)}"`);
  html=html.replace(/<nav class="nav island">[\s\S]*?<\/nav>/, `<nav class="nav island">${navLinks}</nav>`);
  html=html.replace(/<div class="notice">[\s\S]*?<\/div>/, `<div class="notice">${contacts.length ? 'Написать удобным способом: ' + contactLinks : 'Контакты пока не добавлены'}</div>${landingTrustSectionHtml()}`);
  html=html.replace(/<div class="contact-buttons">[\s\S]*?<\/div>/, `<div class="contact-buttons">${contactLinks}</div>`);
  html=html.replace(/<div class="modal-options contact-choice-grid">[\s\S]*?<\/div>/, `<div class="modal-options contact-choice-grid">${contacts.map(c=>`<a href="${h(contactHref(c))}" ${/^https?:/i.test(contactHref(c))?'target="_blank" rel="noopener"':''}>${h(c.label || c.type)}</a>`).join('') || '<span class="muted">Контакты пока не добавлены</span>'}</div>`);
  html=html.replace(/<section class="section faq" data-module="faq">[\s\S]*?<\/section>/, `<section class="section faq" id="faq" data-module="faq"><div style="padding:42px 42px 22px"><h2>Вопросы, которые часто задают семьи</h2></div>${faqHtml}</section>`);
  html=html.replace(/QR-код нужен только для входа\. Главное — аккуратная страница, где остаются фотографии, история жизни, слова близких и свеча памяти\./g,'Наведите камеру телефона на QR-код — откроется страница памяти с фотографиями, историей жизни и словами близких.');
  html=html.replace(/Достаточно навести камеру телефона на QR-код\./g,'Нужно только навести камеру телефона на QR-код.');
  html = rewriteAssetFolder(html, 'landing');
  html = replaceAssetUrl(html, heroImage, 'hero-b2c.webp');
  html=html.replace('</head>',`<meta name="description" content="${h(landing.seo_description||'')}"><style>:root{--bronze:${h(company.accent_color||'#9A7448')}} .brand-logo{width:100%;height:100%;object-fit:contain;border-radius:inherit;display:block}.brand-title::after{content:attr(data-brand-short)!important}${landingTrustCss()} .hero h1,.section h2,.module-intro h2,.cta h2,.suited h2{font-weight:650!important}.feature h3,.step h3,.soft-card h3{font-weight:700!important} ${blocks.faqVisible===false?'.faq{display:none!important}':''} ${blocks.contactsVisible===false?'#contacts,.notice{display:none!important}':''} ${blocks.qrVisible===false?'[data-module="qr"],#qr{display:none!important}':''} ${blocks.featuresVisible===false?'[data-module="features"],#features,#inside{display:none!important}':''}</style></head>`);
  html=html.replace(/<footer class="footer">[\s\S]*?<\/footer>/, `<footer class="footer">${h(publicFooterTextFor(company))}</footer>`);
  const landingData={company:{name:publicBrandName,legalName:company.name,logo:publicLogo || company.logo},landing:{preloaderTitle:landing.preloader_title,heroTitle:landing.hero_title,heroSubtitle:landing.hero_subtitle,primaryLabel,primaryUrl,secondaryLabel,secondaryUrl,heroImage,nav,contacts,faq,blocks}};
  html=html.replace('</body>',`<script>window.PAMYAT_PUBLIC_LANDING_DATA=${safeScriptJson(landingData)};</script><script>window.PAMYAT_TRACK=${safeScriptJson({companyId:company.id,landingId:landing.id,kind:'landing'})};</script><script src="/static/admin/public-bindings.js"></script><script src="/static/admin/tracking.js"></script></body>`);
  return html;
}
app.get('/admin/landing/preview', requireAuth, (req,res)=>{ res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate'); const c=currentCompany(req); const l=db.prepare('SELECT * FROM landing_pages WHERE company_id=?').get(c.id); res.send(renderLanding(c,l)); });
app.get('/l/:companySlug',(req,res)=>{ const c=db.prepare('SELECT * FROM companies WHERE slug=? AND is_active=1').get(req.params.companySlug); if(!c) return res.status(404).send('Компания не найдена'); const l=db.prepare("SELECT * FROM landing_pages WHERE company_id=? AND status='published'").get(c.id); if(!l) return res.status(404).send('Лендинг не опубликован'); writeAnalytics(req,res,{company_id:c.id,landing_id:l.id,event_type:'landing_view',path:req.path}); res.send(renderLanding(c,l)); });
app.get('/',(req,res)=>{ const c=companyByHost(req) || db.prepare('SELECT * FROM companies WHERE is_active=1 ORDER BY id LIMIT 1').get(); if(!c) return res.status(404).send('Компания не найдена'); const l=db.prepare("SELECT * FROM landing_pages WHERE company_id=? AND status='published'").get(c.id); if(!l) return res.status(404).send('Лендинг не опубликован'); writeAnalytics(req,res,{company_id:c.id,landing_id:l.id,event_type:'landing_view',path:req.path}); res.send(renderLanding(c,l)); });

function memorialForm(req, m={}){
 const qualities=db.prepare('SELECT * FROM memorial_qualities WHERE memorial_id=? ORDER BY sort_order,id').all(m.id||-1); const milestones=db.prepare('SELECT * FROM memorial_milestones WHERE memorial_id=? ORDER BY sort_order,id').all(m.id||-1); const memories=db.prepare('SELECT * FROM memorial_memories WHERE memorial_id=? ORDER BY sort_order,id').all(m.id||-1); const photos=db.prepare('SELECT * FROM memorial_photos WHERE memorial_id=? ORDER BY sort_order,id').all(m.id||-1);
 return layout(req,m.id?'Редактировать страницу':'Создать страницу',`<div class="top"><h1>${m.id?'Страница памяти':'Новая страница памяти'}</h1>${m.id?`<div><a class="btn muted" href="/admin/memorials/${m.id}/versions">Версии</a><a class="btn muted" href="/admin/memorials/${m.id}/publish">Публикация</a><a class="btn muted" target="_blank" href="/admin/memorials/${m.id}/preview">Предпросмотр</a><a class="btn" target="_blank" href="/admin/memorials/${m.id}/qr">QR/PDF</a></div>`:''}</div>${stepGuideHtml(m.id?'memorial_edit':'memorial_new', currentCompany(req), {publishHref:m.id?`/admin/memorials/${m.id}/publish`:'#', qrHref:m.id?`/admin/memorials/${m.id}/qr`:'#'})}${m.id?`<div class="editor-shell"><section class="editor-column">`:''}<form class="panel form live-form" data-editor-kind="memorial" data-draft-key="memorial-${m.id||'new'}" data-draft-signature="${h(String(m.version||0)+'-'+String(m.updated_at||''))}" data-preview-url="${m.id?`/admin/memorials/${m.id}/preview`:''}" method="post" enctype="multipart/form-data"><h2>Основное</h2><div class="grid2">${input('full_name','ФИО одной строкой',m.full_name)}${input('slug','Адрес страницы',m.slug)}${input('birth_date','Дата рождения',m.birth_date,'date')}${input('death_date','Дата смерти',m.death_date,'date')}${select('status','Статус',m.status||'draft',[['draft','Черновик'],['published','Опубликовано'],['hidden','Скрыто'],['archived','Архив']])}${select('privacy_status','Приватность',m.privacy_status||'unlisted',[['draft','Черновик'],['unlisted','По ссылке/QR'],['public','Публичная']])}</div>${input('quote','Короткая фраза',m.quote||'Главное — держаться вместе.')}${textarea('epitaph','Эпитафия',m.epitaph,4)}${textarea('biography','История жизни',m.biography,10)}<div class="checks">${checkbox('consent_confirmed','Согласие подтверждено',m.consent_confirmed)}${checkbox('noindex','Не показывать в поиске',m.noindex!==0)}</div><label class="field"><span>Главное фото</span><input type="file" name="main_photo" accept="image/*"></label><h2>Блоки страницы</h2>${textarea('section_order','Порядок блоков',asJson(m.section_order_json,'hero,words,story,album,footer').toString().replace(/,/g,'\n'),5)}<div class="checks">${checkbox('hide_words','Скрыть слова',asJson(m.hidden_sections_json,[]).includes('words'))}${checkbox('hide_story','Скрыть историю',asJson(m.hidden_sections_json,[]).includes('story'))}${checkbox('hide_album','Скрыть альбом',asJson(m.hidden_sections_json,[]).includes('album'))}</div><h2>Тёплые слова</h2>${textarea('memories_lines','Воспоминания близких',(m.memories_lines ?? memories.map(x=>`${x.status} | ${x.is_featured} | ${x.author||''} | ${x.text}`).join('\n')),8)}<h2>Каким его помнят — максимум 4</h2>${textarea('qualities_lines','Качества',qualities.map(x=>`${x.title} | ${x.description||''}`).join('\n'),5)}<h2>Важные моменты — максимум 4</h2>${textarea('milestones_lines','Важные годы и события',milestones.map(x=>`${x.year} | ${x.text}`).join('\n'),5)}<h2>Альбом</h2><label class="field"><span>Добавить фото в альбом</span><input type="file" name="album_photos" accept="image/*" multiple></label>${textarea('photos_meta','Подписи к новым фото',m.photos_meta||'',5)}${m._from_submission_id?`<input type="hidden" name="from_submission_id" value="${m._from_submission_id}">`:''}${albumManagerHtml(m, photos)}<h2>Финал</h2>${textarea('footer_text','Финальная фраза',m.footer_text||'Пусть тёплые слова и фотографии остаются здесь рядом.',3)}<div class="sticky-save"><button class="btn">Сохранить страницу</button>${m.id?`<button class="btn muted" type="button" data-refresh-preview>Обновить предпросмотр</button>`:''}</div></form>${m.id?`</section><aside class="preview-column"><div class="preview-toolbar"><b>Предпросмотр страницы</b><span class="device-switch"><button type="button" data-device="desktop" class="active">Компьютер</button><button type="button" data-device="mobile">Телефон</button></span></div><iframe class="preview-frame" data-live-preview src="/admin/memorials/${m.id}/preview"></iframe><div class="click-map"><button type="button" data-focus-field="full_name">ФИО</button><button type="button" data-focus-field="quote">Цитата</button><button type="button" data-focus-field="epitaph">Эпитафия</button><button type="button" data-focus-field="biography">История</button><button type="button" data-focus-field="memories_lines">Слова близких</button><button type="button" data-focus-field="album_photos">Альбом</button></div></aside></div>`:''}`);
}
app.get('/admin/memorials', requireAuth, (req,res)=>{ const rows=db.prepare('SELECT * FROM memorials WHERE company_id=? ORDER BY updated_at DESC').all(req.session.manager.company_id); const c=currentCompany(req); const guideKey=rows.length?'memorials_ready':'memorials_empty'; res.send(layout(req,'Страницы памяти',`<div class="top"><h1>Страницы памяти</h1><a class="btn" href="/admin/memorials/new">Создать</a></div>${stepGuideHtml(guideKey,c)}<section class="panel"><table><tr><th>ФИО</th><th>Статус</th><th>Приватность</th><th>Свечи</th><th></th></tr>${rows.map(m=>`<tr><td>${h(m.full_name)}</td><td>${h(m.status)}</td><td>${h(m.privacy_status)}</td><td>${m.candles_count}</td><td><a href="/admin/memorials/${m.id}">редактировать</a> · <a href="/admin/memorials/${m.id}/publish">публикация</a></td></tr>`).join('') || '<tr><td colspan="5">Пока нет страниц памяти</td></tr>'}</table></section>`)); });
function planLimitBlockedHtml(req, c, limit){
  audit(req,'plan_limit_blocked','company',c.id,c.name,{limit:'memorials', plan:c.plan||'standard', current:limit.usage.memorials, max:limit.plan.max_memorials});
  return layout(req,'Лимит тарифа',`<div class="top"><h1>Лимит тарифа исчерпан</h1><a class="btn" href="/admin/plan">Посмотреть тариф</a></div><section class="panel"><p>Создание новой страницы памяти заблокировано тарифом.</p><p class="muted-text">Использовано ${h(String(limit.usage.memorials))} из ${h(limitLabel(limit.plan.max_memorials))} страниц памяти.</p></section>`);
}
app.get('/admin/memorials/new', requireAuth, (req,res)=>{
  const c=currentCompany(req); const limit=canCreateMemorialFor(c);
  if(!limit.ok) return res.status(403).send(planLimitBlockedHtml(req,c,limit));
  let prefill = {};
  if(req.query.from_submission){
    const sub = db.prepare('SELECT * FROM memorial_submissions WHERE id=? AND company_id=?').get(req.query.from_submission, req.session.manager.company_id);
    if(sub){
      prefill = {
        full_name: sub.full_name,
        slug: safeSlug(sub.full_name),
        birth_date: sub.birth_date,
        death_date: sub.death_date,
        epitaph: sub.epitaph,
        biography: sub.biography,
        consent_confirmed: sub.consent_confirmed,
        memories_lines: submissionMemoriesText(sub.memories),
        photos_meta: submissionPhotosMeta(sub.photos),
        _from_submission_id: sub.id
      };
    }
  }
  res.send(memorialForm(req, prefill));
});
app.get('/admin/memorials/:id', requireAuth, (req,res)=>{ const m=db.prepare('SELECT * FROM memorials WHERE id=? AND company_id=?').get(req.params.id,req.session.manager.company_id); if(!m)return res.status(404).send('Не найдено'); res.send(memorialForm(req,m)); });
async function saveMemorial(req,res,next){ try{
  if(!req.params.id){ const c=currentCompany(req); const limit=canCreateMemorialFor(c); if(!limit.ok) return res.status(403).send(planLimitBlockedHtml(req,c,limit)); }
  const id=req.params.id; let m=id?db.prepare('SELECT * FROM memorials WHERE id=? AND company_id=?').get(id,req.session.manager.company_id):null;
  let main_photo=m?.main_photo||''; const mainFile=(req.files.main_photo||[])[0]; const mainImg=await saveImage(mainFile,'memorial',{minWidth:900,minHeight:900}); if(mainImg) main_photo=mainImg.large;
  const hidden=[]; if(req.body.hide_words) hidden.push('words'); if(req.body.hide_story) hidden.push('story'); if(req.body.hide_album) hidden.push('album');
  const data={ company_id:req.session.manager.company_id, full_name:req.body.full_name, slug:safeSlug(req.body.slug||req.body.full_name), birth_date:toIsoDate(req.body.birth_date), death_date:toIsoDate(req.body.death_date), quote:req.body.quote, epitaph:req.body.epitaph, biography:req.body.biography, main_photo, status:req.body.status, privacy_status:req.body.privacy_status, noindex:req.body.noindex?1:0, consent_confirmed:req.body.consent_confirmed?1:0, section_order_json:JSON.stringify(parseList(req.body.section_order)), hidden_sections_json:JSON.stringify(hidden), footer_text:req.body.footer_text, canonical_url:req.body.canonical_url||'', search_indexing_hint:req.body.search_indexing_hint||'private_link', album_cover_photo_id: req.body.album_cover_photo_id ? Number(req.body.album_cover_photo_id) : null };
  if(data.status==='published'){
    const missing = [];
    if(!data.full_name) missing.push('ФИО');
    if(!data.birth_date) missing.push('дата рождения');
    if(!data.death_date) missing.push('дата смерти');
    if(!data.main_photo) missing.push('главное фото');
    if(!data.epitaph) missing.push('эпитафия');
    if(!data.biography) missing.push('история жизни');
    if(!data.consent_confirmed) missing.push('согласие');
    if(missing.length) return res.status(400).send(layout(req,'Нельзя опубликовать',`<section class="panel"><h1>Нельзя опубликовать</h1><p>Не заполнено: ${h(missing.join(', '))}</p><a class="btn" href="${id?`/admin/memorials/${id}`:'/admin/memorials/new'}">Назад</a></section>`));
  }
  if(!m){ const public_token=shortToken(); const uuid=uuidv4(); const info=db.prepare(`INSERT INTO memorials (uuid,company_id,full_name,slug,public_token,birth_date,death_date,quote,epitaph,biography,main_photo,status,privacy_status,noindex,consent_confirmed,section_order_json,hidden_sections_json,footer_text,canonical_url,search_indexing_hint,album_cover_photo_id) VALUES (@uuid,@company_id,@full_name,@slug,@public_token,@birth_date,@death_date,@quote,@epitaph,@biography,@main_photo,@status,@privacy_status,@noindex,@consent_confirmed,@section_order_json,@hidden_sections_json,@footer_text,@canonical_url,@search_indexing_hint,@album_cover_photo_id)`).run({...data,uuid,public_token}); m={id:info.lastInsertRowid}; audit(req,'create_memorial','memorial',m.id,data.full_name); systemEvent(req.session.manager.company_id,'memorial_created',`Страница памяти создана: ${data.full_name}`,'Создана новая страница из редактора.',{relatedType:'memorial',relatedId:m.id,actionUrl:`/admin/memorials/${m.id}`,actorManagerId:req.session.manager.id}); }
  else { savePageVersion(req,'memorial',m.id,memorialSnapshot(m.id),'manual_save'); db.prepare(`UPDATE memorials SET full_name=@full_name,slug=@slug,birth_date=@birth_date,death_date=@death_date,quote=@quote,epitaph=@epitaph,biography=@biography,main_photo=@main_photo,status=@status,privacy_status=@privacy_status,noindex=@noindex,consent_confirmed=@consent_confirmed,section_order_json=@section_order_json,hidden_sections_json=@hidden_sections_json,footer_text=@footer_text,album_cover_photo_id=@album_cover_photo_id,updated_at=CURRENT_TIMESTAMP WHERE id=@id AND company_id=@company_id`).run({...data,id:m.id}); audit(req,'update_memorial','memorial',m.id,data.full_name); }
  db.prepare('DELETE FROM memorial_memories WHERE memorial_id=?').run(m.id); parseList(req.body.memories_lines).forEach((line,i)=>{ const [status='approved',feat='0',author='',...rest]=line.split('|').map(s=>s.trim()); const text=rest.join(' | '); if(text) db.prepare('INSERT INTO memorial_memories (memorial_id,text,author,is_featured,status,sort_order) VALUES (?,?,?,?,?,?)').run(m.id,text,author,feat==='1'?1:0,status,i); });
  db.prepare('DELETE FROM memorial_qualities WHERE memorial_id=?').run(m.id); parseList(req.body.qualities_lines).slice(0,4).forEach((line,i)=>{ const [title,description='']=line.split('|').map(s=>s.trim()); if(title) db.prepare('INSERT INTO memorial_qualities (memorial_id,title,description,sort_order) VALUES (?,?,?,?)').run(m.id,title,description,i); });
  db.prepare('DELETE FROM memorial_milestones WHERE memorial_id=?').run(m.id); parseList(req.body.milestones_lines).slice(0,4).forEach((line,i)=>{ const [year,text='']=line.split('|').map(s=>s.trim()); if(year&&text) db.prepare('INSERT INTO memorial_milestones (memorial_id,year,text,sort_order) VALUES (?,?,?,?)').run(m.id,year,text,i); });
  const existingPhotoIds = Array.isArray(req.body.existing_photo_id) ? req.body.existing_photo_id : (req.body.existing_photo_id ? [req.body.existing_photo_id] : []);
  const existingPhotos = db.prepare('SELECT * FROM memorial_photos WHERE memorial_id=? ORDER BY sort_order,id').all(m.id);
  const existingById = new Map(existingPhotos.map(p => [String(p.id), p]));
  const requestedDeletes = new Set();
  for(const rawId of existingPhotoIds){
    const pid = String(rawId);
    const photo = existingById.get(pid);
    if(!photo) continue;
    if(req.body[`photo_delete_${pid}`]){
      requestedDeletes.add(pid);
      deleteUploadedFiles(photo.original_path, photo.preview_path, photo.large_path, photo.thumb_path);
      db.prepare('DELETE FROM memorial_photos WHERE id=? AND memorial_id=?').run(photo.id, m.id);
      audit(req,'delete_album_photo','memorial_photo',photo.id,photo.title||m.full_name);
      continue;
    }
    db.prepare(`UPDATE memorial_photos SET
      title=?, caption=?, photo_date=?, place=?, focus_x=?, focus_y=?, is_visible=?, sort_order=?
      WHERE id=? AND memorial_id=?`).run(
        req.body[`photo_title_${pid}`] || '',
        req.body[`photo_caption_${pid}`] || '',
        req.body[`photo_date_${pid}`] || '',
        req.body[`photo_place_${pid}`] || '',
        Math.max(0, Math.min(1, Number(req.body[`photo_focus_x_${pid}`] ?? photo.focus_x ?? .5))),
        Math.max(0, Math.min(1, Number(req.body[`photo_focus_y_${pid}`] ?? photo.focus_y ?? .5))),
        req.body[`photo_visible_${pid}`] ? 1 : 0,
        Number(req.body[`photo_sort_${pid}`] ?? photo.sort_order ?? 0),
        photo.id,
        m.id
      );
  }
  let coverId = req.body.album_cover_photo_id ? Number(req.body.album_cover_photo_id) : null;
  if(coverId && requestedDeletes.has(String(coverId))) coverId = null;
  if(coverId){
    const okCover = db.prepare('SELECT id FROM memorial_photos WHERE id=? AND memorial_id=?').get(coverId, m.id);
    if(!okCover) coverId = null;
  }
  const newFiles=req.files.album_photos||[];
  if(newFiles.length){
    const demoPhotos = db.prepare("SELECT * FROM memorial_photos WHERE memorial_id=? AND (large_path LIKE '/static/assets/memory/album-%' OR large_path LIKE 'static/assets/memory/album-%')").all(m.id);
    if(demoPhotos.length){
      for(const photo of demoPhotos){
        db.prepare('DELETE FROM memorial_photos WHERE id=? AND memorial_id=?').run(photo.id, m.id);
      }
      coverId = null;
      audit(req,'replace_demo_album_photos','memorial',m.id,m.full_name,{deleted:demoPhotos.length});
    }
  }
  const metas=parseList(req.body.photos_meta);
  const insertedPhotoIds=[];
  for(let i=0;i<newFiles.length;i++){
    const img=await saveImage(newFiles[i],'memorial',{minWidth:500,minHeight:500});
    if(!img) continue;
    const [title='',photo_date='',place='',caption='']=(metas[i]||'').split('|').map(s=>s.trim());
    const nextSort = ((db.prepare('SELECT COALESCE(MAX(sort_order),0) mx FROM memorial_photos WHERE memorial_id=?').get(m.id).mx || 0) + 10 + i*10);
    const created = db.prepare('INSERT INTO memorial_photos (memorial_id,original_path,preview_path,large_path,thumb_path,title,caption,photo_date,place,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(m.id,img.original,img.preview,img.large,img.thumb,title,caption,photo_date,place,nextSort);
    insertedPhotoIds.push(created.lastInsertRowid);
  }
  if(!coverId && insertedPhotoIds.length) coverId = insertedPhotoIds[0];
  if(!coverId){
    const firstVisible = db.prepare('SELECT id FROM memorial_photos WHERE memorial_id=? AND is_visible=1 ORDER BY sort_order,id LIMIT 1').get(m.id);
    if(firstVisible) coverId = firstVisible.id;
  }
  db.prepare('UPDATE memorials SET album_cover_photo_id=? WHERE id=? AND company_id=?').run(coverId || null, m.id, req.session.manager.company_id);
  if(req.body.from_submission_id){
    db.prepare('UPDATE memorial_submissions SET status=?, converted_memorial_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND company_id=?').run('in_work', m.id, req.body.from_submission_id, req.session.manager.company_id);
    audit(req,'prefill_memorial_from_submission','submission',Number(req.body.from_submission_id),data.full_name,{memorial_id:m.id});
  }
  res.redirect(`/admin/memorials/${m.id}`);
}catch(e){next(e)}}
app.post('/admin/memorials/new', requireAuth, upload.fields([{name:'main_photo',maxCount:1},{name:'album_photos',maxCount:30}]), saveMemorial);
app.post('/admin/memorials/:id', requireAuth, upload.fields([{name:'main_photo',maxCount:1},{name:'album_photos',maxCount:30}]), saveMemorial);


function statusLabel(status){
  return ({
    new:'Новая',
    in_work:'В работе',
    waiting_materials:'Ожидает семью',
    ready_review:'Готова к проверке',
    published:'Завершена',
    archived:'Отменена'
  }[status] || status || 'Новая');
}
function priorityLabel(priority){
  return ({low:'Низкий',normal:'Обычный',high:'Высокий',urgent:'Срочно'}[priority] || 'Обычный');
}
function priorityOptions(current){
  return [['low','Низкий'],['normal','Обычный'],['high','Высокий'],['urgent','Срочно']]
    .map(([value,label])=>`<option value="${h(value)}" ${value===current?'selected':''}>${h(label)}</option>`).join('');
}
function submissionStatusOptions(current){
  return [['new','Новая'],['in_work','В работе'],['waiting_materials','Ожидает семью'],['published','Завершена'],['archived','Отменена'],['ready_review','Готова к проверке']]
    .map(([value,label])=>`<option value="${h(value)}" ${value===current?'selected':''}>${h(label)}</option>`).join('');
}
function managerOptions(companyId, current){
  const rows = db.prepare("SELECT id, COALESCE(NULLIF(name,''), login) AS label FROM managers WHERE company_id=? AND is_active=1 ORDER BY role, login").all(companyId);
  return '<option value="">Не назначен</option>' + rows.map(m=>`<option value="${m.id}" ${Number(current)===Number(m.id)?'selected':''}>${h(m.label)}</option>`).join('');
}
function isOverdueSubmission(s){
  return s.next_contact_at && !['published','archived'].includes(s.status) && new Date(String(s.next_contact_at).replace(' ', 'T')) < new Date();
}
function submissionContact(s){ return s.contact_phone || s.messenger || s.notify_email || ''; }
function crmSubmissionCard(s){
  const contact = submissionContact(s);
  const overdue = isOverdueSubmission(s);
  const manager = s.assigned_manager_name || s.assigned_manager_login || 'не назначен';
  const converted = s.converted_memorial_id ? `<a href="/admin/memorials/${s.converted_memorial_id}">страница #${s.converted_memorial_id}</a>` : '<span>страница не создана</span>';
  const tel = s.contact_phone ? `<a href="tel:${h(String(s.contact_phone).replace(/[^+\d]/g,''))}">Позвонить</a>` : '';
  const mail = s.notify_email ? `<a href="mailto:${h(s.notify_email)}">Написать</a>` : '';
  return `<article class="crm-card ${overdue?'crm-overdue':''}" data-crm-card data-search="${h([s.full_name, s.contact_phone, s.notify_email, s.messenger, s.city, manager].filter(Boolean).join(' ').toLowerCase())}">
    <label class="crm-check"><input type="checkbox" name="ids" value="${s.id}"><span></span></label>
    <div class="crm-card-main"><a class="crm-title" href="/admin/submissions/${s.id}">${h(s.full_name)}</a><small>${h(s.city||'')} ${s.consent_confirmed?'· согласие есть':'· нет согласия'}</small></div>
    <div class="crm-tags"><span class="status-badge ${h(s.status||'new')}">${h(statusLabel(s.status))}</span><span class="priority-badge ${h(s.priority||'normal')}">${h(priorityLabel(s.priority))}</span>${overdue?'<span class="priority-badge urgent">просрочен контакт</span>':''}</div>
    <div class="crm-meta"><span>${h(contact || 'контакт не указан')}</span><span>Менеджер: ${h(manager)}</span><span>Следующий контакт: ${h(s.next_contact_at || 'не задан')}</span><span>${converted}</span></div>
    <div class="crm-quick-actions">${tel}${mail}<a href="/admin/submissions/${s.id}">Открыть карточку</a>${s.converted_memorial_id?`<a href="/admin/memorials/${s.converted_memorial_id}">Открыть страницу</a>`:''}</div>
    <form class="crm-status-form" method="post" action="/admin/submissions/${s.id}/status"><select name="status">${submissionStatusOptions(s.status)}</select><button class="btn muted">OK</button></form>
  </article>`;
}
function crmColumn(status, rows){
  return `<section class="crm-column"><header><b>${h(statusLabel(status))}</b><span>${rows.length}</span></header><div class="crm-list">${rows.map(crmSubmissionCard).join('') || '<p class="crm-empty">Нет заявок</p>'}</div></section>`;
}

app.get('/admin/crm', requireAuth, (req,res)=>{
  const cid=req.session.manager.company_id;
  const status = String(req.query.status || 'all');
  const q = String(req.query.q || '').trim();
  const source = String(req.query.source || 'all');
  const priority = String(req.query.priority || 'all');
  const assigned = String(req.query.assigned || 'all');
  const params=[cid];
  let where='s.company_id=?';
  if(status !== 'all'){ where += ' AND s.status=?'; params.push(status); }
  if(source !== 'all'){ where += ' AND s.source=?'; params.push(source); }
  if(priority !== 'all'){ where += ' AND s.priority=?'; params.push(priority); }
  if(assigned === 'mine'){ where += ' AND s.assigned_manager_id=?'; params.push(req.session.manager.id); }
  if(assigned === 'unassigned'){ where += ' AND s.assigned_manager_id IS NULL'; }
  if(q){ where += ' AND (s.full_name LIKE ? OR s.contact_phone LIKE ? OR s.messenger LIKE ? OR s.notify_email LIKE ? OR s.city LIKE ?)'; const like=`%${q}%`; params.push(like,like,like,like,like); }
  const rows=db.prepare(`SELECT s.*, COALESCE(NULLIF(m.name,''), m.login) AS assigned_manager_name, m.login AS assigned_manager_login FROM memorial_submissions s LEFT JOIN managers m ON m.id=s.assigned_manager_id WHERE ${where} ORDER BY CASE s.status WHEN 'new' THEN 1 WHEN 'in_work' THEN 2 WHEN 'waiting_materials' THEN 3 WHEN 'ready_review' THEN 4 WHEN 'published' THEN 5 ELSE 6 END, CASE s.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END, s.next_contact_at IS NULL, s.next_contact_at ASC, s.updated_at DESC, s.created_at DESC LIMIT 250`).all(...params);
  const statuses=['new','in_work','waiting_materials','published','archived','ready_review'];
  const grouped=Object.fromEntries(statuses.map(st=>[st, rows.filter(r=>r.status===st)]));
  const stats=db.prepare('SELECT status, COUNT(*) count FROM memorial_submissions WHERE company_id=? GROUP BY status').all(cid);
  const statMap=Object.fromEntries(stats.map(s=>[s.status,s.count]));
  res.send(layout(req,'CRM-доска заявок',`<div class="top"><h1>CRM-доска заявок</h1><div><a class="btn muted" href="/admin/submissions/new">Добавить вручную</a><a class="btn" href="/admin/submissions">Список заявок</a></div></div>
    <section class="panel crm-toolbar"><form method="get" class="crm-filters crm-filters-wide"><label><span>Поиск</span><input name="q" value="${h(q)}" placeholder="ФИО, телефон, город"></label><label><span>Статус</span><select name="status"><option value="all">Все статусы</option>${statuses.map(st=>`<option value="${st}" ${st===status?'selected':''}>${statusLabel(st)}</option>`).join('')}</select></label><label><span>Источник</span><select name="source"><option value="all" ${source==='all'?'selected':''}>Все</option><option value="family_form" ${source==='family_form'?'selected':''}>Форма семьи</option><option value="manual" ${source==='manual'?'selected':''}>Вручную</option></select></label><label><span>Приоритет</span><select name="priority"><option value="all" ${priority==='all'?'selected':''}>Все</option>${[['low','Низкий'],['normal','Обычный'],['high','Высокий'],['urgent','Срочно']].map(([v,l])=>`<option value="${v}" ${priority===v?'selected':''}>${l}</option>`).join('')}</select></label><label><span>Ответственный</span><select name="assigned"><option value="all" ${assigned==='all'?'selected':''}>Все</option><option value="mine" ${assigned==='mine'?'selected':''}>Мои</option><option value="unassigned" ${assigned==='unassigned'?'selected':''}>Без ответственного</option></select></label><button class="btn muted">Применить</button></form>
    <div class="crm-status-stats">${statuses.map(st=>`<a class="status-badge ${st}" href="/admin/crm?status=${st}">${statusLabel(st)} · ${statMap[st]||0}</a>`).join('')}</div></section>
    <form method="post" action="/admin/submissions/bulk" class="crm-bulk"><section class="panel bulk-panel"><b>Массовые действия</b><select name="status"><option value="in_work">Перевести в работу</option><option value="waiting_materials">Ожидает семью</option><option value="published">Завершена</option><option value="archived">Отменена</option><option value="ready_review">Готова к проверке</option></select><button class="btn muted">Применить к выбранным</button><small>Отмечайте заявки чекбоксами в карточках.</small></section><div class="crm-board">${statuses.map(st=>crmColumn(st, grouped[st] || [])).join('')}</div></form><script>(function(){const q=document.querySelector('input[name=\"q\"]');if(!q)return;q.addEventListener('input',function(){const v=this.value.trim().toLowerCase();document.querySelectorAll('[data-crm-card]').forEach(card=>{card.hidden=!!v && !String(card.dataset.search||card.textContent||'').toLowerCase().includes(v);});});})();</script>`));
});

app.post('/admin/submissions/bulk', requireAuth, (req,res)=>{
  const cid=req.session.manager.company_id;
  const ids=[].concat(req.body.ids || []).map(Number).filter(Boolean);
  const nextStatus=String(req.body.status || 'in_work');
  const allowed=new Set(['new','in_work','waiting_materials','ready_review','published','archived']);
  if(ids.length && allowed.has(nextStatus)){
    const placeholders=ids.map(()=>'?').join(',');
    db.prepare(`UPDATE memorial_submissions SET status=?, updated_at=CURRENT_TIMESTAMP WHERE company_id=? AND id IN (${placeholders})`).run(nextStatus,cid,...ids);
    audit(req,'bulk_update_submissions','submission',null,`${ids.length} заявок`,{ids,nextStatus}); systemEvent(cid,'submission_status_changed',`Массовое изменение статуса: ${statusLabel(nextStatus)}`,`${ids.length} заявок обновлено`,{relatedType:'submission',relatedId:null,actionUrl:`/admin/crm?status=${nextStatus}`,actorManagerId:req.session.manager.id});
  }
  res.redirect('/admin/crm');
});

app.post('/admin/submissions/:id/status', requireAuth, (req,res)=>{
  const sub=db.prepare('SELECT * FROM memorial_submissions WHERE id=? AND company_id=?').get(req.params.id,req.session.manager.company_id);
  if(!sub) return res.status(404).send('Не найдено');
  const nextStatus=String(req.body.status || sub.status);
  const allowed=new Set(['new','in_work','waiting_materials','ready_review','published','archived']);
  if(allowed.has(nextStatus)){
    db.prepare('UPDATE memorial_submissions SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND company_id=?').run(nextStatus,sub.id,req.session.manager.company_id);
    audit(req,'quick_update_submission_status','submission',sub.id,sub.full_name,{from:sub.status,to:nextStatus}); systemEvent(req.session.manager.company_id,'submission_status_changed',`Статус заявки изменён: ${sub.full_name}`,`${statusLabel(sub.status)} → ${statusLabel(nextStatus)}`,{relatedType:'submission',relatedId:sub.id,actionUrl:`/admin/submissions/${sub.id}`,actorManagerId:req.session.manager.id,priority: nextStatus==='waiting_materials'?'high':'normal'});
  }
  res.redirect(req.get('referer') || '/admin/crm');
});
function submissionMemoriesText(raw){
  const items = asJson(raw, []);
  return items.map((item,i)=>{
    if(typeof item === 'string') return `new | ${i < 3 ? 1 : 0} |  | ${item}`;
    return `new | ${i < 3 ? 1 : 0} | ${item.author || ''} | ${item.text || item.memory || ''}`;
  }).filter(Boolean).join('\n');
}
function submissionPhotosMeta(raw){
  const items = asJson(raw, []);
  return items.map(item => `${item.title || ''} | ${item.date || item.photo_date || ''} | ${item.place || ''} | ${item.caption || ''}`).join('\n');
}
function submissionTimelineHtml(req, sub){
  const auditRows = db.prepare(`SELECT a.*, COALESCE(NULLIF(m.name,''), m.login) AS actor_name FROM audit_log a LEFT JOIN managers m ON m.id=a.manager_id WHERE a.company_id=? AND a.object_type='submission' AND a.object_id=? ORDER BY a.created_at DESC, a.id DESC LIMIT 12`).all(req.session.manager.company_id, sub.id);
  const noteLines = String(sub.admin_note || '').split('\n').map(x=>x.trim()).filter(Boolean).slice(-8).reverse();
  const items = [];
  auditRows.forEach(r=>items.push(`<li><time>${h(r.created_at)}</time><b>${h(r.actor_name || 'Система')}</b><span>${h(r.action)}${r.object_name?` · ${h(r.object_name)}`:''}</span></li>`));
  noteLines.forEach(line=>items.push(`<li><time>Заметка</time><b>Контакт с семьёй</b><span>${h(line)}</span></li>`));
  if(!items.length) items.push('<li><time>—</time><b>История пуста</b><span>Действия по заявке появятся после первого контакта или изменения статуса.</span></li>');
  return `<section class="panel crm-timeline"><h2>Таймлайн работы с семьёй</h2><ol>${items.join('')}</ol></section>`;
}

function submissionQuickActionsHtml(sub){
  const tel = sub.contact_phone ? `<a class="btn muted" href="tel:${h(String(sub.contact_phone).replace(/[^+\d]/g,''))}">Позвонить</a>` : '';
  const mail = sub.notify_email ? `<a class="btn muted" href="mailto:${h(sub.notify_email)}">Написать email</a>` : '';
  const messenger = sub.messenger ? `<a class="btn muted" href="${h(/^https?:/.test(sub.messenger)?sub.messenger:'#')}">Мессенджер</a>` : '';
  const memorial = sub.converted_memorial_id ? `<a class="btn" href="/admin/memorials/${sub.converted_memorial_id}">Открыть страницу памяти</a>` : `<a class="btn" href="/admin/memorials/new?from_submission=${sub.id}">Создать страницу памяти</a>`;
  return `<section class="panel crm-actions-panel"><h2>Быстрые действия</h2><div class="actions">${tel}${mail}${messenger}${memorial}<a class="btn muted" href="/admin/crm">Открыть CRM</a></div></section>`;
}

function submissionDetailHtml(req, sub){
  const photos = asJson(sub.photos, []);
  const memories = asJson(sub.memories, []);
  const publicLink = `${BASE_URL}/family/${currentCompany(req).slug}/submit`;
  return layout(req, 'Заявка семьи', `<div class="top"><h1>Заявка семьи</h1><div><a class="btn muted" href="/admin/submissions">Назад</a><a class="btn" href="/admin/memorials/new?from_submission=${sub.id}">Заполнить страницу</a></div></div>
    <section class="panel form submission-detail">
      <div class="status-strip"><b>${h(statusLabel(sub.status))}</b><span>Источник: ${h(sub.source || 'manual')}</span><span>Форма для семьи: <code>${h(publicLink)}</code></span></div>
      <form method="post">
        <div class="grid2">
          ${select('status','Статус',sub.status,[['new','Новая'],['in_work','В работе'],['waiting_materials','Ожидает семью'],['published','Завершена'],['archived','Отменена'],['ready_review','Готова к проверке']])}
          <label class="field"><span>Приоритет</span><select name="priority">${priorityOptions(sub.priority || 'normal')}</select></label>
          <label class="field"><span>Ответственный</span><select name="assigned_manager_id">${managerOptions(req.session.manager.company_id, sub.assigned_manager_id)}</select></label>
          ${input('next_contact_at','Следующий контакт',sub.next_contact_at || '','datetime-local')}
          ${input('notify_email','Email для уведомления',sub.notify_email || '')}
          ${input('contact_name','Контактное лицо',sub.contact_name || '')}
          ${input('contact_phone','Телефон',sub.contact_phone || '')}
          ${input('messenger','Мессенджер',sub.messenger || '')}
          ${input('city','Город',sub.city || '')}
        </div>
        ${textarea('comment','Комментарий семьи',sub.comment || '',4)}
        ${textarea('admin_note','Внутренняя заметка менеджера',sub.admin_note || '',4)}
        ${textarea('client_stage_note','Внутренняя заметка по клиенту',sub.client_stage_note || '',4)}
        <div class="checks">${checkbox('consent_confirmed','Согласие подтверждено',sub.consent_confirmed)}</div>
        <button class="btn">Сохранить заявку</button>
      </form>
    </section>
    ${submissionQuickActionsHtml(sub)}
    <section class="panel form"><h2>Быстрый контакт с семьёй</h2><form method="post" action="/admin/submissions/${sub.id}/contact-log"><div class="grid2">${input('next_contact_at','Следующий контакт',sub.next_contact_at || '','datetime-local')}${input('last_contact_at','Последний контакт',sub.last_contact_at || '')}</div>${textarea('contact_note','Что обсудили / что нужно сделать','',4)}<button class="btn muted">Зафиксировать контакт</button></form></section>
    ${submissionTimelineHtml(req, sub)}
    <section class="panel form"><h2>Материалы из формы</h2><div class="grid2">${input('readonly_full_name','ФИО',sub.full_name || '')}${input('readonly_dates','Даты',`${sub.birth_date || ''} — ${sub.death_date || ''}`)}</div>${textarea('readonly_epitaph','Эпитафия',sub.epitaph || '',4)}${textarea('readonly_biography','История',sub.biography || '',8)}<h3>Воспоминания</h3><div class="chips">${memories.length ? memories.map(m=>`<span>${h(typeof m === 'string' ? m : (m.text || m.memory || ''))}</span>`).join('') : '<em>Пока нет</em>'}</div><h3>Фото</h3><div class="media-grid">${photos.length ? photos.map(ph=>`<a href="${h(ph.large || ph.preview || ph.path || '')}" target="_blank"><img src="${h(ph.thumb || ph.preview || ph.large || ph.path || '')}" alt=""></a>`).join('') : '<em>Пока нет</em>'}</div></section>`);
}

function renderMemorial(company,m){
  let html=fs.readFileSync(path.join(ROOT,'templates','memorial.template.html'),'utf8');
  const memories=db.prepare("SELECT * FROM memorial_memories WHERE memorial_id=? AND status='approved' ORDER BY is_featured DESC,sort_order,id LIMIT 6").all(m.id);
  const photos=db.prepare('SELECT * FROM memorial_photos WHERE memorial_id=? AND is_visible=1 ORDER BY sort_order,id').all(m.id);
  const q=db.prepare('SELECT * FROM memorial_qualities WHERE memorial_id=? ORDER BY sort_order,id LIMIT 4').all(m.id);
  const ms=db.prepare('SELECT * FROM memorial_milestones WHERE memorial_id=? ORDER BY sort_order,id LIMIT 4').all(m.id);
  html=html.replace(/<title>[^<]*<\/title>/,`<title>${h(m.seo_title||m.full_name+' — страница памяти')}</title>`);
  html=html.replace(/Алексей Николаевич Орлов/g,h(m.full_name));
  html=html.replace(/14\.03\.1951 — 22\.08\.2023/g,`${h(displayDate(m.birth_date))} — ${h(displayDate(m.death_date))}`);
  html=html.replace(/Главное — держаться вместе\./g,h(m.quote||''));
  html=html.replace(/Любящий муж, отец и человек, который всегда держал слово\./g,h(m.epitaph||''));
  const heroMainPhoto = publicPath(m.main_photo || '/static/assets/memory/hero-portrait-bg.webp');
  html = rewriteAssetFolder(html, 'memory');
  html = replaceAssetUrl(html, heroMainPhoto, 'hero-portrait-bg.webp');
  const memorialCanonical = canonicalForMemorial(company, m);
  const memorialRobots = (company.robots_policy === 'noindex_all' || m.noindex) ? '<meta name="robots" content="noindex,nofollow">' : '';
  const memorialOgImage = m.og_image || m.main_photo || company.logo || '';
  html=html.replace('</head>',`${memorialRobots}<meta name="description" content="${h(m.seo_description||m.epitaph||'')}"><link rel="canonical" href="${h(memorialCanonical)}"><meta property="og:type" content="profile"><meta property="og:title" content="${h(m.seo_title||m.full_name+' — страница памяти')}"><meta property="og:description" content="${h(m.seo_description||m.epitaph||'')}">${memorialOgImage?`<meta property="og:image" content="${h(publicBaseUrl(company)+memorialOgImage)}">`:''}<meta property="og:url" content="${h(memorialCanonical)}"><style>:root{--bronze:${h(company.accent_color||'#B47A3D')}}</style></head>`);
  const albumData = photos.length ? photos.map(p=>({
    src: publicPath(p.large_path),
    thumb: publicPath(p.thumb_path || p.preview_path || p.large_path),
    caption: [p.title, p.photo_date].filter(Boolean).join('. ') || p.caption || 'Семейное фото',
    alt: p.title || p.caption || 'Семейное фото'
  })) : null;
  if(albumData){
    html = html.replace(/const albumPhotos = \[[\s\S]*?\];/, `const albumPhotos = ${JSON.stringify(albumData)};`);
    const firstAlbum = albumData[0];
    html = html.replace(/id="albumSlideBg" src="[^"]*"/, `id="albumSlideBg" src="${h(firstAlbum.src)}"`);
    html = html.replace(/id="albumSlideImage" src="[^"]*"/, `id="albumSlideImage" src="${h(firstAlbum.src)}"`);
    html = html.replace(/id="albumFullscreenBg" src="[^"]*"/, `id="albumFullscreenBg" src="${h(firstAlbum.src)}"`);
    html = html.replace(/id="albumFullscreenImage" src="[^"]*"/, `id="albumFullscreenImage" src="${h(firstAlbum.src)}"`);
    html = html.replace(/<span class="album-caption-text" id="albumSlideCaption">[\s\S]*?<\/span>/, `<span class="album-caption-text" id="albumSlideCaption">${h(firstAlbum.caption || '')}</span>`);
    html = html.replace(/<span id="albumCounter">[^<]*<\/span>/, `<span id="albumCounter">1 / ${albumData.length}</span>`);
  }
  html=html.replace(/<footer class="footer">[\s\S]*?<\/footer>/, `<footer class="footer">${h(publicFooterTextFor(company))}</footer>`);
  const json={ fullName:m.full_name, quote:m.quote, epitaph:m.epitaph, birthDate:displayDate(m.birth_date), deathDate:displayDate(m.death_date), birthDateIso:m.birth_date, deathDateIso:m.death_date, mainPhoto:publicPath(m.main_photo), biography:m.biography, memories, qualities:q, milestones:ms, photos:(albumData||photos.map(p=>({src:publicPath(p.large_path),thumb:publicPath(p.thumb_path),title:p.title,caption:p.caption,date:p.photo_date,place:p.place,focusX:p.focus_x,focusY:p.focus_y,isCover:Number(m.album_cover_photo_id)===Number(p.id)}))), company:{name:publicBrandNameFor(company, company.name),logo:publicPath(company.logo)}, footer:m.footer_text };
  html=html.replace('</body>',`<script>window.PAMYAT_ADMIN_DATA=${JSON.stringify(json)};</script><script>window.PAMYAT_TRACK=${JSON.stringify({companyId:company.id,memorialId:m.id,kind:'memorial'})};</script><script src="/static/admin/public-bindings.js"></script><script src="/static/admin/tracking.js"></script></body>`);
  return html;
}
app.get('/admin/memorials/:id/preview', requireAuth, (req,res)=>{ res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate'); const c=currentCompany(req); const m=db.prepare('SELECT * FROM memorials WHERE id=? AND company_id=?').get(req.params.id,c.id); if(!m)return res.status(404).send('Не найдено'); res.send(renderMemorial(c,m)); });
app.get('/m/:companySlug/:memorialSlugToken',(req,res)=>{ const c=db.prepare('SELECT * FROM companies WHERE slug=? AND is_active=1').get(req.params.companySlug); if(!c)return res.status(404).send('Компания не найдена'); const token=req.params.memorialSlugToken.split('-').pop(); const m=db.prepare("SELECT * FROM memorials WHERE company_id=? AND public_token=? AND status='published'").get(c.id,token); if(!m)return res.status(404).send('Страница не опубликована'); writeAnalytics(req,res,{company_id:c.id,memorial_id:m.id,event_type:'memorial_view',path:req.path}); res.send(renderMemorial(c,m)); });

app.post('/m/:companySlug/:memorialSlugToken/memory', rateLimit('public_memory', 12, 60*60*1000), (req,res)=>{
  const c=db.prepare('SELECT * FROM companies WHERE slug=? AND is_active=1').get(req.params.companySlug);
  if(!c) return res.status(404).json({ok:false,error:'Компания не найдена'});
  const token=req.params.memorialSlugToken.split('-').pop();
  const m=db.prepare("SELECT * FROM memorials WHERE company_id=? AND public_token=? AND status='published'").get(c.id,token);
  if(!m) return res.status(404).json({ok:false,error:'Страница не опубликована'});
  const text=String(req.body.message || req.body.text || '').trim().slice(0,1600);
  const author=String(req.body.name || req.body.author || '').trim().slice(0,80);
  if(text.length < 2) return res.status(400).json({ok:false,error:'Введите текст воспоминания'});
  const info=db.prepare("INSERT INTO memorial_memories (memorial_id,text,author,status,is_featured,sort_order) VALUES (?,?,?,?,0,999)").run(m.id,text,author,'new');
  writeAnalytics(req,res,{company_id:c.id,memorial_id:m.id,event_type:'memory_submit',path:req.path,meta:{memory_id:info.lastInsertRowid}});
  notifyNewMemory(c, m, info.lastInsertRowid, author, text);
  res.json({ok:true,message:'Спасибо. Ваши слова отправлены на проверку.'});
});


async function ensureQrAssets(company, memorial) {
  const url = publicMemorialUrl(company, memorial);
  const safe = `${company.slug}-${memorial.slug}-${memorial.public_token}`.replace(/[^a-z0-9_-]/gi, '-');
  const pngPath = path.join(UPLOAD_ROOT, 'qr', `${safe}.png`);
  const svgPath = path.join(UPLOAD_ROOT, 'qr', `${safe}.svg`);
  const qrOptions = { width: 1400, margin: 2, errorCorrectionLevel: 'H', color: { dark: '#2b251f', light: '#fff9ef' } };
  await QRCode.toFile(pngPath, url, qrOptions);
  const svg = await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'H', color: { dark: '#2b251f', light: '#fff9ef' } });
  fs.writeFileSync(svgPath, svg);
  db.prepare('UPDATE memorials SET qr_png_path=?, qr_svg_path=? WHERE id=?').run(rel(pngPath), rel(svgPath), memorial.id);
  return { url, pngPath, svgPath, pngUrl: rel(pngPath), svgUrl: rel(svgPath) };
}

function pdfBuffer(build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    build(doc);
    doc.end();
  });
}

async function buildQrPdfBuffer(company, memorial, type = 'a4') {
  const { url, pngPath } = await ensureQrAssets(company, memorial);
  return pdfBuffer((doc) => {
    const W = 595.28, H = 841.89;
    doc.rect(0, 0, W, H).fill('#F7F2EA');
    doc.fillColor('#2b251f');
    if (type === 'plaque') {
      doc.roundedRect(72, 84, 451, 674, 28).fillAndStroke('#FFF9EF', '#D9C3A8');
      doc.fillColor('#9A7448').fontSize(12).text('QR-ТАБЛИЧКА ДЛЯ ПАМЯТНИКА', 72, 122, { width:451, align:'center', characterSpacing:1.5 });
      doc.fillColor('#2b251f').fontSize(30).text(memorial.full_name, 104, 170, { width:387, align:'center' });
      doc.fillColor('#756B60').fontSize(13).text(`${memorial.birth_date || ''} — ${memorial.death_date || ''}`, 104, 238, { width:387, align:'center' });
      doc.image(pngPath, 198, 292, { width:200, height:200 });
      doc.fillColor('#756B60').fontSize(12).text('Наведите камеру телефона, чтобы открыть страницу памяти.', 118, 530, { width:360, align:'center' });
      doc.fillColor('#9A7448').fontSize(10).text(url, 118, 602, { width:360, align:'center' });
      doc.fillColor('#756B60').fontSize(9).text(company.name || 'Память QR', 118, 700, { width:360, align:'center' });
    } else if (type === 'card') {
      doc.roundedRect(64, 90, 467, 294, 24).fillAndStroke('#FFF9EF', '#D9C3A8');
      doc.fillColor('#2b251f').fontSize(24).text(memorial.full_name, 92, 124, { width:260 });
      doc.fillColor('#756B60').fontSize(12).text(`${memorial.birth_date || ''} — ${memorial.death_date || ''}`, 92, 188, { width:260 });
      doc.fillColor('#756B60').fontSize(11).text('Страница памяти доступна по QR-коду.', 92, 228, { width:230 });
      doc.image(pngPath, 370, 124, { width:118, height:118 });
      doc.fillColor('#9A7448').fontSize(9).text(company.name || 'Память QR', 92, 332, { width:396, align:'center' });
      doc.fillColor('#2b251f').fontSize(15).text('Памятная карточка', 64, 430, { width:467, align:'center' });
      doc.fillColor('#756B60').fontSize(11).text('Можно использовать как вкладку в альбом, открытку или печатный материал.', 118, 460, { width:360, align:'center' });
    } else {
      doc.fillColor('#9A7448').fontSize(12).text('СТРАНИЦА ПАМЯТИ', 60, 76, { width:475, align:'center', characterSpacing:1.8 });
      doc.fillColor('#2b251f').fontSize(32).text(memorial.full_name, 82, 122, { width:431, align:'center' });
      doc.fillColor('#756B60').fontSize(13).text(`${memorial.birth_date || ''} — ${memorial.death_date || ''}`, 82, 204, { width:431, align:'center' });
      doc.roundedRect(176, 252, 244, 244, 24).fillAndStroke('#FFF9EF', '#D9C3A8');
      doc.image(pngPath, 198, 274, { width:200, height:200 });
      doc.fillColor('#2b251f').fontSize(16).text('Откройте страницу памяти по QR-коду', 92, 540, { width:411, align:'center' });
      doc.fillColor('#756B60').fontSize(12).text('Фотографии, история жизни, слова близких и свеча памяти находятся на личной странице.', 110, 570, { width:375, align:'center' });
      doc.fillColor('#9A7448').fontSize(10).text(url, 86, 650, { width:423, align:'center' });
      doc.fillColor('#756B60').fontSize(10).text(company.name || 'Память QR', 92, 742, { width:411, align:'center' });
    }
  });
}

app.get('/admin/memorials/:id/qr', requireAuth, async (req,res,next)=>{ try{
  const c=currentCompany(req);
  const m=db.prepare('SELECT * FROM memorials WHERE id=? AND company_id=?').get(req.params.id,c.id);
  if(!m)return res.status(404).send('Не найдено');
  const assets = await ensureQrAssets(c,m);
  audit(req,'generate_qr','memorial',m.id,m.full_name,{url:assets.url});
  res.send(layout(req,'QR и печатные материалы',`<div class="top"><h1>QR и печать</h1><a class="btn muted" href="/admin/memorials/${m.id}/edit">Назад к странице</a></div>
    <section class="qr-studio">
      <div class="panel qr-preview-card"><div class="qr-frame"><img src="${assets.pngUrl}" alt="QR"></div><h2>${h(m.full_name)}</h2><p>${h(assets.url)}</p><div class="copy-line"><code>${h(assets.url)}</code></div></div>
      <div class="panel form"><h2>Скачать QR</h2><div class="actions stack"><a class="btn" href="${assets.pngUrl}" download>PNG 1400 px</a><a class="btn muted" href="${assets.svgUrl}" download>SVG для печати</a><a class="btn muted" href="/admin/memorials/${m.id}/qr-kit.zip">Скачать комплект ZIP</a></div><h2>PDF-макеты</h2><div class="print-grid"><a class="print-card" href="/admin/memorials/${m.id}/qr.pdf?type=a4"><b>Лист A4</b><span>для проверки и отправки семье</span></a><a class="print-card" href="/admin/memorials/${m.id}/qr.pdf?type=plaque"><b>QR-табличка</b><span>макет для памятника или отдельной таблички</span></a><a class="print-card" href="/admin/memorials/${m.id}/qr.pdf?type=card"><b>Памятная карточка</b><span>для альбома, открытки или печатного архива</span></a></div><p class="muted-text">Все макеты используют публичную ссылку страницы. Если slug или статус страницы изменится, QR нужно открыть заново — он перегенерируется.</p></div>
    </section>`));
}catch(e){next(e)} });

app.get('/admin/memorials/:id/qr.pdf', requireAuth, async (req,res,next)=>{ try{
  const c=currentCompany(req);
  const m=db.prepare('SELECT * FROM memorials WHERE id=? AND company_id=?').get(req.params.id,c.id);
  if(!m)return res.status(404).send('Не найдено');
  const type = ['a4','plaque','card'].includes(req.query.type) ? req.query.type : 'a4';
  const pdf = await buildQrPdfBuffer(c,m,type);
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`attachment; filename="${type}-${m.slug}-qr.pdf"`);
  audit(req,'download_qr_pdf','memorial',m.id,m.full_name,{type});
  res.send(pdf);
}catch(e){next(e)} });

app.get('/admin/memorials/:id/qr-kit.zip', requireAuth, async (req,res,next)=>{ try{
  const c=currentCompany(req);
  const m=db.prepare('SELECT * FROM memorials WHERE id=? AND company_id=?').get(req.params.id,c.id);
  if(!m)return res.status(404).send('Не найдено');
  const assets = await ensureQrAssets(c,m);
  res.setHeader('Content-Type','application/zip');
  res.setHeader('Content-Disposition',`attachment; filename="qr-kit-${m.slug}.zip"`);
  const archive=archiver('zip');
  archive.pipe(res);
  archive.file(assets.pngPath,{name:`${m.slug}-qr.png`});
  archive.file(assets.svgPath,{name:`${m.slug}-qr.svg`});
  for (const type of ['a4','plaque','card']) {
    const pdf = await buildQrPdfBuffer(c,m,type);
    archive.append(pdf,{name:`${type}-${m.slug}-qr.pdf`});
  }
  archive.append(JSON.stringify({url:assets.url,full_name:m.full_name,company:c.name},null,2),{name:'qr-link.json'});
  audit(req,'download_qr_kit','memorial',m.id,m.full_name);
  archive.finalize();
}catch(e){next(e)} });


app.get('/family/:companySlug/submit', (req,res)=>{
  const c=db.prepare('SELECT * FROM companies WHERE slug=? AND is_active=1').get(req.params.companySlug);
  if(!c) return res.status(404).send('Компания не найдена');
  res.send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Передать материалы — ${h(c.name)}</title><link rel="stylesheet" href="/static/admin/admin.css"></head><body class="public-form"><main class="auth-page"><section class="auth-card family-card"><h1>Передать материалы для страницы памяти</h1><p>Эта форма поможет менеджеру аккуратно подготовить страницу. После отправки материалы попадут в админку на проверку.</p><form method="post" enctype="multipart/form-data" class="form"><div class="grid2">${input('full_name','ФИО человека')}${input('birth_date','Дата рождения','','date')}${input('death_date','Дата смерти','','date')}${input('contact_name','Ваше имя')}${input('contact_phone','Телефон')}${input('messenger','Удобный мессенджер')}${input('notify_email','Email для уведомления')}${input('city','Город')}</div>${textarea('epitaph','Короткая фраза / эпитафия','',4)}${textarea('biography','История жизни','',8)}${textarea('memories_text','Воспоминания близких, каждое с новой строки','',6)}<label class="field"><span>Главное фото</span><input type="file" name="main_photo" accept="image/*"></label><label class="field"><span>Фото для альбома</span><input type="file" name="album_photos" accept="image/*" multiple></label>${textarea('photos_meta','Подписи к фото, по одной строке: название | год/дата | место | подпись','',4)}${textarea('comment','Комментарий менеджеру','',4)}${checkbox('consent_confirmed','Подтверждаю согласие на обработку и публикацию переданных материалов',false)}<button class="btn">Отправить материалы</button></form></section></main></body></html>`);
});
app.post('/family/:companySlug/submit', rateLimit('family_submit', 8, 60*60*1000), upload.fields([{name:'main_photo',maxCount:1},{name:'album_photos',maxCount:40}]), async (req,res,next)=>{ try{
  const c=db.prepare('SELECT * FROM companies WHERE slug=? AND is_active=1').get(req.params.companySlug);
  if(!c) return res.status(404).send('Компания не найдена');
  const mainImg = await saveImage((req.files.main_photo||[])[0], 'memorial', {minWidth:900,minHeight:900});
  const metas = parseList(req.body.photos_meta);
  const photos=[];
  for(let i=0;i<(req.files.album_photos||[]).length;i++){
    const img=await saveImage(req.files.album_photos[i], 'memorial', {minWidth:500,minHeight:500});
    const [title='',date='',place='',caption='']=(metas[i]||'').split('|').map(x=>x.trim());
    photos.push({...img,title,date,place,caption});
  }
  const memories=parseList(req.body.memories_text).map(text=>({text,status:'new'}));
  const info=db.prepare(`INSERT INTO memorial_submissions (company_id,token,status,source,full_name,birth_date,death_date,epitaph,biography,main_photo,photos,memories,contact_name,contact_phone,messenger,city,comment,notify_email,consent_confirmed) VALUES (@company_id,@token,'new','family_form',@full_name,@birth_date,@death_date,@epitaph,@biography,@main_photo,@photos,@memories,@contact_name,@contact_phone,@messenger,@city,@comment,@notify_email,@consent_confirmed)`).run({
    ...req.body, company_id:c.id, token:shortToken(), main_photo:mainImg?.large||'', photos:JSON.stringify(photos), memories:JSON.stringify(memories), consent_confirmed:req.body.consent_confirmed?1:0
  });
  db.prepare("INSERT INTO analytics_events (company_id,event_type,path,meta) VALUES (?,?,?,?)").run(c.id,'submit_view',req.path,JSON.stringify({submission_id:info.lastInsertRowid,action:'family_submit'}));
  notifySubmissionCreated(c, info.lastInsertRowid, req.body.full_name, req.body.contact_phone || req.body.messenger || req.body.notify_email);
  res.send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Материалы отправлены</title><link rel="stylesheet" href="/static/admin/admin.css"></head><body class="public-form"><main class="auth-page"><section class="auth-card"><h1>Материалы отправлены</h1><p>Менеджер получил заявку и проверит материалы перед публикацией. После одобрения с вами свяжутся удобным способом.</p></section></main></body></html>`);
}catch(e){next(e)}});

app.get('/admin/submissions', requireAuth, (req,res)=>{
  const rows=db.prepare("SELECT s.*, COALESCE(NULLIF(m.name,''), m.login) AS assigned_manager_name FROM memorial_submissions s LEFT JOIN managers m ON m.id=s.assigned_manager_id WHERE s.company_id=? ORDER BY s.created_at DESC").all(req.session.manager.company_id);
  const c=currentCompany(req);
  const familyLink=`${BASE_URL}/family/${c.slug}/submit`;
  const stats=db.prepare('SELECT status, COUNT(*) count FROM memorial_submissions WHERE company_id=? GROUP BY status').all(req.session.manager.company_id);
  res.send(layout(req,'Заявки семьи',`<div class="top"><h1>Заявки семьи</h1><div><a class="btn" href="/admin/submissions/new">Добавить вручную</a></div></div><section class="panel form"><h2>Публичная форма для семьи</h2><p class="muted-text">Отправьте эту ссылку семье. Заполненные материалы попадут сюда как новая заявка.</p><div class="copy-line"><code>${h(familyLink)}</code></div></section><section class="stats-row">${stats.map(s=>`<div class="stat-card"><b>${s.count}</b><span>${h(statusLabel(s.status))}</span></div>`).join('')}</section><section class="panel"><table><tr><th>ФИО</th><th>Контакт</th><th>Статус</th><th>Приоритет</th><th>Ответственный</th><th>Следующий контакт</th><th>Согласие</th><th>Дата</th><th></th></tr>${rows.map(s=>`<tr><td>${h(s.full_name)}</td><td>${h(s.contact_phone||s.messenger||s.notify_email||'')}</td><td>${h(statusLabel(s.status))}</td><td><span class="priority-badge ${h(s.priority||'normal')}">${h(priorityLabel(s.priority))}</span></td><td>${h(s.assigned_manager_name||'—')}</td><td>${h(s.next_contact_at||'—')}</td><td>${s.consent_confirmed?'да':'нет'}</td><td>${h(s.created_at)}</td><td><a href="/admin/submissions/${s.id}">открыть</a></td></tr>`).join('')}</table></section>`));
});
app.get('/admin/submissions/new', requireAuth, (req,res)=>res.send(layout(req,'Новая заявка',`<div class="top"><h1>Заявка семьи</h1></div><form class="panel form" method="post"><h2>Контакт и CRM</h2><div class="grid2">${input('full_name','ФИО')} ${input('birth_date','Дата рождения','','date')} ${input('death_date','Дата смерти','','date')} ${input('contact_name','Контактное лицо')} ${input('contact_phone','Телефон')} ${input('messenger','Мессенджер')} ${input('notify_email','Email для уведомления')} ${input('city','Город')} ${select('priority','Приоритет','normal',[['low','Низкий'],['normal','Обычный'],['high','Высокий'],['urgent','Срочно']])}<label class="field"><span>Ответственный</span><select name="assigned_manager_id">${managerOptions(req.session.manager.company_id, req.session.manager.id)}</select></label>${input('next_contact_at','Следующий контакт','','datetime-local')}</div>${textarea('epitaph','Эпитафия','',4)}${textarea('biography','История','',8)}${textarea('memories_text','Воспоминания, каждое с новой строки','',5)}${textarea('comment','Комментарий','',4)}${textarea('client_stage_note','Внутренняя заметка по клиенту','',4)}${checkbox('consent_confirmed','Согласие подтверждено',false)}<button class="btn">Сохранить заявку</button></form>`)));
app.post('/admin/submissions/new', requireAuth, (req,res)=>{ const memories=parseList(req.body.memories_text).map(text=>({text,status:'new'})); const assigned = req.body.assigned_manager_id ? Number(req.body.assigned_manager_id) : null; const info=db.prepare(`INSERT INTO memorial_submissions (company_id,token,source,full_name,birth_date,death_date,epitaph,biography,memories,contact_name,contact_phone,messenger,notify_email,city,comment,consent_confirmed,priority,assigned_manager_id,next_contact_at,client_stage_note) VALUES (@company_id,@token,'manual',@full_name,@birth_date,@death_date,@epitaph,@biography,@memories,@contact_name,@contact_phone,@messenger,@notify_email,@city,@comment,@consent_confirmed,@priority,@assigned_manager_id,@next_contact_at,@client_stage_note)`).run({...req.body,company_id:req.session.manager.company_id,token:shortToken(),memories:JSON.stringify(memories),consent_confirmed:req.body.consent_confirmed?1:0,priority:req.body.priority||'normal',assigned_manager_id:assigned,next_contact_at:req.body.next_contact_at||null,client_stage_note:req.body.client_stage_note||''}); audit(req,'create_submission','submission',info.lastInsertRowid,req.body.full_name,{priority:req.body.priority||'normal',assigned_manager_id:assigned,next_contact_at:req.body.next_contact_at||null}); notifySubmissionCreated(currentCompany(req), info.lastInsertRowid, req.body.full_name, req.body.contact_phone || req.body.messenger || req.body.notify_email); res.redirect('/admin/submissions'); });
app.get('/admin/submissions/:id', requireAuth, (req,res)=>{ const sub=db.prepare('SELECT * FROM memorial_submissions WHERE id=? AND company_id=?').get(req.params.id,req.session.manager.company_id); if(!sub)return res.status(404).send('Не найдено'); res.send(submissionDetailHtml(req,sub)); });
app.post('/admin/submissions/:id', requireAuth, (req,res)=>{ const sub=db.prepare('SELECT * FROM memorial_submissions WHERE id=? AND company_id=?').get(req.params.id,req.session.manager.company_id); if(!sub)return res.status(404).send('Не найдено'); const assigned = req.body.assigned_manager_id ? Number(req.body.assigned_manager_id) : null; db.prepare(`UPDATE memorial_submissions SET status=@status, priority=@priority, assigned_manager_id=@assigned_manager_id, next_contact_at=@next_contact_at, contact_name=@contact_name, contact_phone=@contact_phone, messenger=@messenger, notify_email=@notify_email, city=@city, comment=@comment, admin_note=@admin_note, client_stage_note=@client_stage_note, consent_confirmed=@consent_confirmed, updated_at=CURRENT_TIMESTAMP WHERE id=@id AND company_id=@company_id`).run({...req.body,id:sub.id,company_id:req.session.manager.company_id,consent_confirmed:req.body.consent_confirmed?1:0,priority:req.body.priority||'normal',assigned_manager_id:assigned,next_contact_at:req.body.next_contact_at||null,client_stage_note:req.body.client_stage_note||''}); audit(req,'update_submission','submission',sub.id,sub.full_name,{status:req.body.status,priority:req.body.priority||'normal',assigned_manager_id:assigned,next_contact_at:req.body.next_contact_at||null}); if(String(req.body.status||sub.status)!==sub.status) systemEvent(req.session.manager.company_id,'submission_status_changed',`Статус заявки изменён: ${sub.full_name}`,`${statusLabel(sub.status)} → ${statusLabel(req.body.status)}`,{relatedType:'submission',relatedId:sub.id,actionUrl:`/admin/submissions/${sub.id}`,actorManagerId:req.session.manager.id,priority:req.body.priority||'normal'}); if(Number(assigned||0)!==Number(sub.assigned_manager_id||0)) systemEvent(req.session.manager.company_id,'submission_assigned',`Назначен ответственный: ${sub.full_name}`,`Ответственный изменён`,{relatedType:'submission',relatedId:sub.id,actionUrl:`/admin/submissions/${sub.id}`,actorManagerId:req.session.manager.id,priority:req.body.priority||'normal'}); res.redirect(`/admin/submissions/${sub.id}`); });


app.post('/admin/submissions/:id/contact-log', requireAuth, (req,res)=>{
  const sub=db.prepare('SELECT * FROM memorial_submissions WHERE id=? AND company_id=?').get(req.params.id,req.session.manager.company_id);
  if(!sub) return res.status(404).send('Не найдено');
  const note = String(req.body.contact_note || '').trim().slice(0,1200);
  const next = req.body.next_contact_at || null;
  const prev = sub.admin_note || '';
  const stamp = new Date().toISOString().slice(0,16).replace('T',' ');
  const appended = note ? `${prev}${prev?'\n\n':''}[${stamp}] Контакт: ${note}` : prev;
  db.prepare("UPDATE memorial_submissions SET admin_note=?, last_contact_at=CURRENT_TIMESTAMP, next_contact_at=?, status=CASE WHEN status='new' THEN 'in_work' ELSE status END, updated_at=CURRENT_TIMESTAMP WHERE id=? AND company_id=?").run(appended,next,sub.id,req.session.manager.company_id);
  audit(req,'log_family_contact','submission',sub.id,sub.full_name,{next_contact_at:next, note:note.slice(0,160)});
  systemEvent(req.session.manager.company_id,'family_contact_logged',`Контакт с семьёй: ${sub.full_name}`, note || 'Контакт зафиксирован', { relatedType:'submission', relatedId:sub.id, actionUrl:`/admin/submissions/${sub.id}`, actorManagerId:req.session.manager.id, priority: sub.priority || 'normal' });
  res.redirect(`/admin/submissions/${sub.id}`);
});

app.post('/admin/submissions/:id/notify-family', requireAuth, (req,res)=>{
  const sub=db.prepare('SELECT * FROM memorial_submissions WHERE id=? AND company_id=?').get(req.params.id,req.session.manager.company_id);
  if(!sub) return res.status(404).send('Не найдено');
  const c=currentCompany(req);
  if(!sub.notify_email) return res.status(400).send('У заявки нет email для уведомления');
  notifyFamily(c.id, sub.notify_email, c.family_approval_subject || 'Ваши материалы одобрены', c.family_approval_body || 'Ваши материалы проверены и приняты оператором.', 'submission', sub.id).catch(()=>{});
  db.prepare("UPDATE memorial_submissions SET family_notified_at=CURRENT_TIMESTAMP, status=CASE WHEN status='new' THEN 'in_work' ELSE status END, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(sub.id);
  audit(req,'notify_family_approved','submission',sub.id,sub.full_name,{email:sub.notify_email}); systemEvent(req.session.manager.company_id,'submission_status_changed',`Семье отправлено уведомление: ${sub.full_name}`, sub.notify_email, { relatedType:'submission', relatedId:sub.id, actionUrl:`/admin/submissions/${sub.id}`, actorManagerId:req.session.manager.id });
  res.redirect(`/admin/submissions/${sub.id}`);
});


app.post('/track', rateLimit('track', 240, 60*1000), (req,res)=>{
  try{
    const body = req.body || {};
    const eventType = String(body.event_type || '').slice(0,80);
    const allowed = new Set(['landing_cta_click','landing_contact_click','landing_example_click','landing_share','memorial_share','candle_click','album_open','album_next','album_prev','memory_submit_click','qr_click','public_click']);
    if(!allowed.has(eventType)) return res.status(204).end();
    writeAnalytics(req,res,{
      company_id: Number(body.company_id) || null,
      landing_id: Number(body.landing_id) || null,
      memorial_id: Number(body.memorial_id) || null,
      event_type: eventType,
      visitor_key: String(body.visitor_key || '').slice(0,64),
      path: String(body.path || req.get('referer') || '').slice(0,500),
      meta: body.meta || {}
    });
  }catch(e){ console.error('track failed', e.message); }
  res.status(204).end();
});

function analyticsCount(cid, eventTypes, days){
  const types = Array.isArray(eventTypes) ? eventTypes : [eventTypes];
  const placeholders = types.map(()=>'?').join(',');
  return db.prepare(`SELECT COUNT(*) c FROM analytics_events WHERE company_id=? AND event_type IN (${placeholders}) AND created_at >= datetime('now', ?)`)
    .get(cid, ...types, `-${Number(days)||30} days`).c;
}
function analyticsUnique(cid, eventTypes, days){
  const types = Array.isArray(eventTypes) ? eventTypes : [eventTypes];
  const placeholders = types.map(()=>'?').join(',');
  return db.prepare(`SELECT COUNT(DISTINCT COALESCE(visitor_key, ip_hash, id)) c FROM analytics_events WHERE company_id=? AND event_type IN (${placeholders}) AND created_at >= datetime('now', ?)`)
    .get(cid, ...types, `-${Number(days)||30} days`).c;
}


app.get('/admin/versions', requireAuth, (req,res)=>{
  const cid=req.session.manager.company_id;
  const landing=db.prepare('SELECT * FROM landing_pages WHERE company_id=?').get(cid);
  const memorials=db.prepare('SELECT id, full_name FROM memorials WHERE company_id=? ORDER BY updated_at DESC').all(cid);
  const memorialIds=memorials.map(x=>x.id);
  const landingVersions=landing ? db.prepare("SELECT * FROM page_versions WHERE object_type='landing' AND object_id=? ORDER BY created_at DESC LIMIT 12").all(landing.id) : [];
  const memorialVersions=memorialIds.length ? db.prepare(`SELECT * FROM page_versions WHERE object_type='memorial' AND object_id IN (${memorialIds.map(()=>'?').join(',')}) ORDER BY created_at DESC LIMIT 30`).all(...memorialIds) : [];
  const names=new Map(memorials.map(m=>[m.id,m.full_name]));
  const total=landingVersions.length + memorialVersions.length;
  const restoreCount=[...landingVersions,...memorialVersions].filter(v=>versionReasonClass(v)==='restore').length;
  const publishCount=[...landingVersions,...memorialVersions].filter(v=>versionReasonClass(v)==='publish').length;
  res.send(layout(req,'Версии и откат',`<div class="top"><h1>Версии и откат</h1><div><a class="btn muted" href="/admin/landing">Лендинг для семей <span class="legacy-qa-label">B2C-лендинг</span></a><a class="btn muted" href="/admin/memorials">Страницы памяти</a></div></div>
    ${technicalPageNotice('Версии нужны, если нужно откатить изменения', 'Обычный сценарий: редактируйте лендинг и страницы памяти. Если ошиблись — здесь можно сравнить и вернуть старый вариант.')}
    <section class="panel version-dashboard"><h2>Контроль изменений</h2><p class="muted-text">Снимок создаётся перед сохранением, публикацией, скрытием и восстановлением. Перед откатом текущее состояние тоже сохраняется в историю.</p><div class="cards small-cards"><div><b>${total}</b><span>версий в выборке</span></div><div><b>${landingVersions.length}</b><span>версий лендинга</span></div><div><b>${memorialVersions.length}</b><span>версий страниц</span></div><div><b>${restoreCount}</b><span>откатов</span></div><div><b>${publishCount}</b><span>публикаций</span></div></div></section>
    <section class="panel"><h2>Лендинг для семей <span class="legacy-qa-label">B2C-лендинг</span></h2><p class="muted-text">Можно сравнить ключевые поля, открыть снимок и восстановить нужную версию.</p><table><tr><th>Дата</th><th>Причина</th><th>Снимок</th><th></th></tr>${landingVersions.map(v=>versionRow(v,'Лендинг для семей',`/admin/landing/versions/${v.id}`)).join('') || '<tr><td colspan="4">Пока нет версий</td></tr>'}</table></section>
    <section class="panel"><h2>Страницы памяти</h2><table><tr><th>Дата</th><th>Причина</th><th>Снимок</th><th></th></tr>${memorialVersions.map(v=>versionRow(v,names.get(v.object_id)||('ID '+v.object_id),`/admin/memorials/${v.object_id}/versions/${v.id}`)).join('') || '<tr><td colspan="4">Пока нет версий</td></tr>'}</table></section>`));
});

app.get('/admin/landing/versions/:versionId', requireAuth, (req,res)=>{
  const company=currentCompany(req);
  const landing=db.prepare('SELECT * FROM landing_pages WHERE company_id=?').get(company.id);
  const v=db.prepare("SELECT * FROM page_versions WHERE id=? AND object_type='landing' AND object_id=?").get(req.params.versionId, landing?.id || 0);
  if(!v) return res.status(404).send('Версия не найдена');
  const previous=versionSnapshotEntity(v);
  const fields=[['status','Статус'],['seo_title','SEO title'],['seo_description','SEO description'],['preloader_title','Preloader'],['hero_title','Hero заголовок'],['hero_subtitle','Hero подзаголовок'],['hero_primary_label','Главная кнопка'],['hero_secondary_label','Вторая кнопка'],['nav_json','Меню'],['contacts_json','Контакты'],['faq_json','FAQ'],['blocks_json','Блоки']];
  res.send(layout(req,'Версия лендинга',`<div class="top"><h1>Версия лендинга</h1><div><a class="btn muted" href="/admin/versions">Назад</a><a class="btn muted" target="_blank" href="/admin/landing/versions/${v.id}/preview">Открыть снимок</a></div></div>
    <section class="panel"><div class="version-head"><div><b>${h(v.created_at)}</b><span>${h(versionLabel(v))}</span><small>${h(versionSummaryText(v))}</small></div><form method="post" action="/admin/landing/versions/${v.id}/restore" onsubmit="return confirm('Восстановить эту версию лендинга? Текущее состояние будет сохранено в историю.')"><button class="btn danger">Восстановить версию</button></form></div>${versionStatsHtml(v)}</section>
    ${versionPreviewCard('Ключевые поля снимка', [['Hero',previous?.hero_title],['Подзаголовок',previous?.hero_subtitle],['Кнопка',previous?.hero_primary_label],['Статус',previous?.status]])}
    <section class="panel"><h2>Сравнение</h2><table class="diff-table"><tr><th>Поле</th><th>В версии</th><th>Сейчас</th></tr>${diffRows(landing, previous, fields)}</table></section>`));
});

app.get('/admin/landing/versions/:versionId/preview', requireAuth, (req,res)=>{
  const company=currentCompany(req);
  const landing=db.prepare('SELECT * FROM landing_pages WHERE company_id=?').get(company.id);
  const v=db.prepare("SELECT * FROM page_versions WHERE id=? AND object_type='landing' AND object_id=?").get(req.params.versionId, landing?.id || 0);
  if(!v) return res.status(404).send('Версия не найдена');
  res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  res.send(renderLanding(company, versionSnapshotEntity(v)));
});

app.post('/admin/landing/versions/:versionId/restore', requireAuth, (req,res)=>{
  const company=currentCompany(req);
  const landing=db.prepare('SELECT * FROM landing_pages WHERE company_id=?').get(company.id);
  const v=db.prepare("SELECT * FROM page_versions WHERE id=? AND object_type='landing' AND object_id=?").get(req.params.versionId, landing?.id || 0);
  if(!v) return res.status(404).send('Версия не найдена');
  savePageVersion(req,'landing',landing.id,landingSnapshot(landing.id),'restore');
  restoreLandingFromSnapshot(landing.id, versionSnapshot(v));
  audit(req,'restore_landing_version','landing',landing.id,company.name,{version_id:v.id});
  systemEvent(company.id,'landing_version_restored','Версия лендинга восстановлена',`Восстановлена версия от ${v.created_at}.`,{relatedType:'landing',relatedId:landing.id,actionUrl:'/admin/versions',actorManagerId:req.session.manager.id,priority:'high'});
  res.redirect('/admin/landing');
});

app.get('/admin/memorials/:id/versions', requireAuth, (req,res)=>{
  const { company, memorial } = requireCompanyMemorial(req, req.params.id);
  if(!memorial) return res.status(404).send('Страница не найдена');
  const versions=db.prepare("SELECT * FROM page_versions WHERE object_type='memorial' AND object_id=? ORDER BY created_at DESC LIMIT 50").all(memorial.id);
  res.send(layout(req,'История страницы',`<div class="top"><h1>История: ${h(memorial.full_name)}</h1><div><a class="btn muted" href="/admin/memorials/${memorial.id}">К редактору</a><a class="btn muted" target="_blank" href="/admin/memorials/${memorial.id}/preview">Текущий предпросмотр</a></div></div><section class="panel version-dashboard"><h2>История изменений страницы</h2><p class="muted-text">Сравнивайте снимки и восстанавливайте нужную версию без потери текущего состояния.</p><div class="cards small-cards"><div><b>${versions.length}</b><span>версий</span></div><div><b>${versions.filter(v=>versionReasonClass(v)==='manual_save').length}</b><span>сохранений</span></div><div><b>${versions.filter(v=>versionReasonClass(v)==='publish').length}</b><span>публикаций</span></div><div><b>${versions.filter(v=>versionReasonClass(v)==='restore').length}</b><span>откатов</span></div></div></section><section class="panel"><table><tr><th>Дата</th><th>Причина</th><th>Снимок</th><th></th></tr>${versions.map(v=>versionRow(v,memorial.full_name,`/admin/memorials/${memorial.id}/versions/${v.id}`)).join('') || '<tr><td colspan="4">Пока нет версий</td></tr>'}</table></section>`));
});

app.get('/admin/memorials/:id/versions/:versionId', requireAuth, (req,res)=>{
  const { memorial } = requireCompanyMemorial(req, req.params.id);
  if(!memorial) return res.status(404).send('Страница не найдена');
  const v=db.prepare("SELECT * FROM page_versions WHERE id=? AND object_type='memorial' AND object_id=?").get(req.params.versionId, memorial.id);
  if(!v) return res.status(404).send('Версия не найдена');
  const snap=versionSnapshot(v);
  const previous=snap.memorial || snap;
  const fields=[['status','Статус'],['privacy_status','Приватность'],['full_name','ФИО'],['slug','Slug'],['birth_date','Дата рождения'],['death_date','Дата смерти'],['quote','Цитата'],['epitaph','Эпитафия'],['biography','История'],['main_photo','Главное фото'],['footer_text','Финал'],['section_order_json','Порядок блоков'],['hidden_sections_json','Скрытые секции']];
  res.send(layout(req,'Версия страницы',`<div class="top"><h1>Версия: ${h(memorial.full_name)}</h1><a class="btn muted" href="/admin/memorials/${memorial.id}/versions">Назад</a></div><section class="panel"><div class="version-head"><div><b>${h(v.created_at)}</b><span>${h(versionLabel(v))}</span><small>${h(versionSummaryText(v))}</small></div><form method="post" action="/admin/memorials/${memorial.id}/versions/${v.id}/restore" onsubmit="return confirm('Восстановить эту версию страницы памяти? Текущее состояние будет сохранено в историю.')"><button class="btn danger">Восстановить версию</button></form></div>${versionStatsHtml(v)}</section>${versionPreviewCard('Ключевые поля снимка', [['ФИО',previous?.full_name],['Цитата',previous?.quote],['Статус',previous?.status],['Финал',previous?.footer_text]])}<section class="panel"><h2>Сравнение</h2><table class="diff-table"><tr><th>Поле</th><th>В версии</th><th>Сейчас</th></tr>${diffRows(memorial, previous, fields)}</table></section></section>`));
});

app.post('/admin/memorials/:id/versions/:versionId/restore', requireAuth, (req,res)=>{
  const { company, memorial } = requireCompanyMemorial(req, req.params.id);
  if(!memorial) return res.status(404).send('Страница не найдена');
  const v=db.prepare("SELECT * FROM page_versions WHERE id=? AND object_type='memorial' AND object_id=?").get(req.params.versionId, memorial.id);
  if(!v) return res.status(404).send('Версия не найдена');
  savePageVersion(req,'memorial',memorial.id,memorialSnapshot(memorial.id),'restore');
  restoreMemorialFromSnapshot(memorial.id, versionSnapshot(v));
  audit(req,'restore_memorial_version','memorial',memorial.id,memorial.full_name,{version_id:v.id});
  systemEvent(company.id,'memorial_version_restored','Версия страницы восстановлена',`Страница «${memorial.full_name}» восстановлена к версии от ${v.created_at}.`,{relatedType:'memorial',relatedId:memorial.id,actionUrl:`/admin/memorials/${memorial.id}/versions`,actorManagerId:req.session.manager.id,priority:'high'});
  res.redirect(`/admin/memorials/${memorial.id}`);
});

function publicationGuardMemorial(m){
  const missing=[];
  if(!m.full_name) missing.push('ФИО');
  if(!m.birth_date) missing.push('дата рождения');
  if(!m.death_date) missing.push('дата смерти');
  if(!m.main_photo) missing.push('главное фото');
  if(!m.epitaph) missing.push('эпитафия');
  if(!m.biography) missing.push('история жизни');
  if(!m.consent_confirmed) missing.push('согласие');
  return missing;
}
app.get('/admin/memorials/:id/publish', requireAuth, (req,res)=>{
  const { company, memorial } = requireCompanyMemorial(req, req.params.id);
  if(!memorial) return res.status(404).send('Страница не найдена');
  const missing=publicationGuardMemorial(memorial);
  const url=publicMemorialUrl(company, memorial);
  res.send(layout(req,'Публикация страницы',`<div class="top"><h1>Публикация</h1><a class="btn muted" href="/admin/memorials/${memorial.id}">Назад</a></div><section class="panel publish-panel"><h2>${h(memorial.full_name)}</h2><p class="muted-text">Перед публикацией проверьте данные, согласие, QR и предпросмотр.</p><div class="publish-checks">${missing.length?missing.map(x=>`<span class="bad">Не заполнено: ${h(x)}</span>`).join(''):'<span class="ok">Все обязательные поля заполнены</span>'}<span>Публичная ссылка: <code>${h(url)}</code></span></div><div class="actions"><a class="btn muted" target="_blank" href="/admin/memorials/${memorial.id}/preview">Предпросмотр</a><a class="btn muted" href="/admin/memorials/${memorial.id}/qr">QR-центр</a><form method="post" action="/admin/memorials/${memorial.id}/publish" onsubmit="return confirm('Опубликовать страницу памяти?')"><button class="btn" ${missing.length?'disabled':''}>Опубликовать</button></form><form method="post" action="/admin/memorials/${memorial.id}/hide" onsubmit="return confirm('Скрыть страницу?')"><button class="btn muted">Скрыть</button></form><form method="post" action="/admin/memorials/${memorial.id}/archive" onsubmit="return confirm('Архивировать страницу?')"><button class="btn danger">В архив</button></form></div></section>`));
});
app.post('/admin/memorials/:id/publish', requireAuth, (req,res)=>{
  const { company, memorial } = requireCompanyMemorial(req, req.params.id);
  if(!memorial) return res.status(404).send('Страница не найдена');
  const missing=publicationGuardMemorial(memorial);
  if(missing.length) return res.status(400).send(layout(req,'Нельзя опубликовать',`<section class="panel"><h1>Нельзя опубликовать</h1><p>Не заполнено: ${h(missing.join(', '))}</p><a class="btn" href="/admin/memorials/${memorial.id}/publish">Назад</a></section>`));
  savePageVersion(req,'memorial',memorial.id,memorialSnapshot(memorial.id),'publish');
  db.prepare("UPDATE memorials SET status='published', privacy_status=CASE WHEN privacy_status='draft' THEN 'unlisted' ELSE privacy_status END, updated_at=CURRENT_TIMESTAMP WHERE id=? AND company_id=?").run(memorial.id, req.session.manager.company_id);
  audit(req,'publish_memorial','memorial',memorial.id,memorial.full_name);
  notifyPublished(company, memorial);
  res.redirect(`/admin/memorials/${memorial.id}/publish`);
});
app.post('/admin/memorials/:id/hide', requireAuth, (req,res)=>{
  const { memorial } = requireCompanyMemorial(req, req.params.id);
  if(!memorial) return res.status(404).send('Страница не найдена');
  savePageVersion(req,'memorial',memorial.id,memorialSnapshot(memorial.id),'hide');
  db.prepare("UPDATE memorials SET status='hidden', updated_at=CURRENT_TIMESTAMP WHERE id=? AND company_id=?").run(memorial.id, req.session.manager.company_id);
  audit(req,'hide_memorial','memorial',memorial.id,memorial.full_name);
  res.redirect(`/admin/memorials/${memorial.id}/publish`);
});
app.post('/admin/memorials/:id/archive', requireAuth, (req,res)=>{
  const { memorial } = requireCompanyMemorial(req, req.params.id);
  if(!memorial) return res.status(404).send('Страница не найдена');
  savePageVersion(req,'memorial',memorial.id,memorialSnapshot(memorial.id),'archive');
  db.prepare("UPDATE memorials SET status='archived', updated_at=CURRENT_TIMESTAMP WHERE id=? AND company_id=?").run(memorial.id, req.session.manager.company_id);
  audit(req,'archive_memorial','memorial',memorial.id,memorial.full_name);
  res.redirect(`/admin/memorials/${memorial.id}/publish`);
});
app.post('/admin/landing/publish', requireAuth, (req,res)=>{
  const company=currentCompany(req);
  const landing=db.prepare('SELECT * FROM landing_pages WHERE company_id=?').get(company.id);
  savePageVersion(req,'landing',landing.id,landingSnapshot(landing.id),'publish');
  db.prepare("UPDATE landing_pages SET status='published', updated_at=CURRENT_TIMESTAMP WHERE id=? AND company_id=?").run(landing.id, company.id);
  audit(req,'publish_landing','landing',landing.id,company.name);
  res.redirect('/admin/landing');
});
app.post('/admin/landing/hide', requireAuth, (req,res)=>{
  const company=currentCompany(req);
  const landing=db.prepare('SELECT * FROM landing_pages WHERE company_id=?').get(company.id);
  savePageVersion(req,'landing',landing.id,landingSnapshot(landing.id),'hide');
  db.prepare("UPDATE landing_pages SET status='hidden', updated_at=CURRENT_TIMESTAMP WHERE id=? AND company_id=?").run(landing.id, company.id);
  audit(req,'hide_landing','landing',landing.id,company.name);
  res.redirect('/admin/landing');
});


app.get('/admin/deploy', requireAuth, (req,res)=>{
  const c=currentCompany(req);
  const slug = c.slug || 'company';
  const address = `${BASE_URL}/l/${slug}`;
  const publishedCount = db.prepare("SELECT COUNT(*) c FROM memorials WHERE company_id=? AND status='published'").get(c.id).c;
  res.send(layout(req,'Адрес сайта',`<div class="top"><h1>Адрес сайта</h1><div><a class="btn" target="_blank" href="${h(address)}">Открыть лендинг</a></div></div>
    ${stepGuideHtml('deploy', c)}
    <section class="panel simple-address-card"><h2>Адрес для семей</h2><p>Это ссылка, которую можно отправлять семьям.</p><div class="address-big">${h(address)}</div></section>
    <section class="panel"><h2>Короткая ссылка</h2><form method="post" action="/admin/deploy/slug" class="slug-form"><label class="field"><span>Что будет после /l/</span><div class="slug-input-row visual-url-input"><b>${h(BASE_URL)}/l/</b><input name="slug" value="${h(slug)}" placeholder="svetlaya-pamyat"></div></label><button class="btn">Сохранить ссылку</button></form></section>
    <section class="panel"><h2>Бренд компании</h2><p class="muted-text">Так компания будет называться на публичных страницах для семей.</p><form method="post" action="/admin/deploy/white-label"><div class="checks">${checkbox('white_label_enabled','Показывать бренд компании на публичных страницах',c.white_label_enabled)}${checkbox('hide_platform_branding','Не показывать подпись Память QR внизу страницы',c.hide_platform_branding)}</div><div class="grid2">${input('brand_display_name','Название для семей',c.brand_display_name||c.name)}${input('public_footer_brand','Подпись внизу страниц',c.public_footer_brand||c.name)}${input('accent_color','Фирменный цвет',c.accent_color||'#A9824A','color')}</div><button class="btn">Сохранить бренд компании</button></form></section>
    <details class="panel technical-details"><summary>Показать технические настройки</summary><p class="muted-text">Этот блок нужен только администратору или специалисту поддержки. Менеджеру для ежедневной работы он не нужен.</p><form method="post" action="/admin/deploy/domain"><div class="grid2">${select('robots_policy','Показ в поисковых системах',c.robots_policy||'default', [['default','По умолчанию'],['noindex_all','Не показывать в поиске'],['allow_public','Разрешить показ публичных страниц']])}${input('privacy_url','Ссылка на политику конфиденциальности',c.privacy_url||'')}</div>${textarea('domain_notes','Заметки для специалиста',c.domain_notes||'',4)}<button class="btn">Сохранить технические настройки</button></form></details>
    <section class="panel"><h2>Публичные ссылки</h2><div class="cards small-cards"><div><b>${h(address)}</b><span>Лендинг для семей</span></div><div><b>${publishedCount}</b><span>Опубликованных страниц памяти</span></div></div><div class="actions"><a class="btn muted" target="_blank" href="${h(address)}">Открыть лендинг</a></div></section>`));
});

app.post('/admin/deploy/slug', requireAuth, (req,res)=>{
  const c=currentCompany(req);
  const slug = safeSlug(req.body.slug || c.slug || c.name || 'company');
  db.prepare('UPDATE companies SET slug=@slug, updated_at=CURRENT_TIMESTAMP WHERE id=@id').run({slug, id:c.id});
  audit(req,'update_public_slug','company',c.id,c.name,{slug});
  res.redirect('/admin/deploy');
});

app.post('/admin/deploy/domain', requireAuth, (req,res)=>{
  const c=currentCompany(req);
  db.prepare('UPDATE companies SET custom_domain=@custom_domain,domain_status=@domain_status,robots_policy=@robots_policy,privacy_url=@privacy_url,domain_notes=@domain_notes,updated_at=CURRENT_TIMESTAMP WHERE id=@id').run({
    custom_domain:normalizeDomain(req.body.custom_domain), domain_status:req.body.domain_status||'not_connected', robots_policy:req.body.robots_policy||'default', privacy_url:req.body.privacy_url||'', domain_notes:req.body.domain_notes||'', id:c.id
  });
  audit(req,'update_domain_settings','company',c.id,c.name,{ custom_domain:req.body.custom_domain, domain_status:req.body.domain_status });
  res.redirect('/admin/deploy');
});
app.post('/admin/deploy/white-label', requireAuth, (req,res)=>{
  const c=currentCompany(req);
  db.prepare(`UPDATE companies SET white_label_enabled=@white_label_enabled, hide_platform_branding=@hide_platform_branding, brand_display_name=@brand_display_name, public_footer_brand=@public_footer_brand, accent_color=@accent_color, updated_at=CURRENT_TIMESTAMP WHERE id=@id`).run({
    id:c.id,
    white_label_enabled:req.body.white_label_enabled?1:0,
    hide_platform_branding:req.body.hide_platform_branding?1:0,
    brand_display_name:req.body.brand_display_name||c.name,
    public_footer_brand:req.body.public_footer_brand||req.body.brand_display_name||c.name,
    accent_color:req.body.accent_color||c.accent_color||'#B47A3D'
  });
  audit(req,'update_white_label','company',c.id,c.name,{ brand_display_name:req.body.brand_display_name, white_label_enabled:Boolean(req.body.white_label_enabled) });
  systemEvent(c.id,'white_label_updated','White-label обновлён',`Публичный бренд: ${req.body.brand_display_name || c.name}`,{ relatedType:'company', relatedId:c.id, priority:'normal', actionUrl:'/admin/deploy' });
  res.redirect('/admin/deploy');
});
app.post('/admin/deploy/landing-seo', requireAuth, (req,res)=>{
  const c=currentCompany(req); const l=db.prepare('SELECT * FROM landing_pages WHERE company_id=?').get(c.id);
  savePageVersion(req,'landing',l.id,landingSnapshot(l.id),'seo_update');
  db.prepare('UPDATE landing_pages SET seo_title=@seo_title,seo_description=@seo_description,canonical_url=@canonical_url,og_title=@og_title,og_description=@og_description,noindex=@noindex,updated_at=CURRENT_TIMESTAMP WHERE id=@id AND company_id=@company_id').run({
    seo_title:req.body.seo_title||'', seo_description:req.body.seo_description||'', canonical_url:req.body.canonical_url||'', og_title:req.body.og_title||'', og_description:req.body.og_description||'', noindex:req.body.noindex?1:0, id:l.id, company_id:c.id
  });
  audit(req,'update_landing_seo','landing',l.id,c.name);
  res.redirect('/admin/deploy');
});
app.get('/robots.txt',(req,res)=>{
  const c=companyByHost(req) || db.prepare('SELECT * FROM companies WHERE slug=?').get(String(req.query.company||''));
  const policy = c?.robots_policy || 'default';
  res.type('text/plain');
  if(policy==='noindex_all') return res.send('User-agent: *\nDisallow: /\n');
  res.send(`User-agent: *\nDisallow: /admin/\nDisallow: /family/\nDisallow: /uploads/tmp/\nSitemap: ${publicBaseUrl(c)}/sitemap.xml\n`);
});
app.get('/sitemap.xml',(req,res)=>{
  const c=companyByHost(req) || db.prepare('SELECT * FROM companies WHERE slug=?').get(String(req.query.company||'')) || db.prepare('SELECT * FROM companies WHERE is_active=1 ORDER BY id LIMIT 1').get();
  if(!c) return res.status(404).type('xml').send('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
  const l=db.prepare("SELECT * FROM landing_pages WHERE company_id=? AND status='published' AND noindex=0").get(c.id);
  const pages=db.prepare("SELECT * FROM memorials WHERE company_id=? AND status='published' AND privacy_status='public' AND noindex=0").all(c.id);
  const urls=[];
  if(l) urls.push(`<url><loc>${h(canonicalForLanding(c,l))}</loc><changefreq>weekly</changefreq></url>`);
  for(const m of pages) urls.push(`<url><loc>${h(canonicalForMemorial(c,m))}</loc><changefreq>monthly</changefreq></url>`);
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`);
});
app.get('/.well-known/pamyat-domain-check',(req,res)=>{ const c=companyByHost(req); res.type('text/plain').send(c ? `pamyat-domain-ok:${c.slug}:${c.domain_check_token||''}` : 'pamyat-domain-not-configured'); });

app.get('/admin/analytics', requireAuth, (req,res)=>{
  const cid=req.session.manager.company_id;
  const period = Number(req.query.days || 30);
  const days = [1,7,30,90].includes(period) ? period : 30;
  const viewsTypes = ['memorial_view','landing_view'];
  const cards = [
    ['Просмотры', analyticsCount(cid, viewsTypes, days)],
    ['Уникальные посетители', analyticsUnique(cid, viewsTypes, days)],
    ['Зажжения свечи', analyticsCount(cid, ['candle_click'], days)],
    ['Открытия альбома', analyticsCount(cid, ['album_open'], days)],
    ['CTA / контакты', analyticsCount(cid, ['landing_cta_click','landing_contact_click','memory_submit_click'], days)],
    ['Заявки семьи', db.prepare("SELECT COUNT(*) c FROM memorial_submissions WHERE company_id=? AND created_at >= datetime('now', ?)").get(cid, `-${days} days`).c]
  ];
  const rows=db.prepare("SELECT event_type, COUNT(*) count, COUNT(DISTINCT COALESCE(visitor_key, ip_hash, id)) unique_count FROM analytics_events WHERE company_id=? AND created_at >= datetime('now', ?) GROUP BY event_type ORDER BY count DESC").all(cid, `-${days} days`);
  const daily=db.prepare("SELECT substr(created_at,1,10) day, COUNT(*) count FROM analytics_events WHERE company_id=? AND created_at >= datetime('now', ?) GROUP BY day ORDER BY day DESC LIMIT 14").all(cid, `-${days} days`);
  const memorials=db.prepare(`SELECT m.id,m.full_name,m.slug,m.public_token,
      SUM(CASE WHEN a.event_type='memorial_view' THEN 1 ELSE 0 END) views,
      COUNT(DISTINCT CASE WHEN a.event_type='memorial_view' THEN COALESCE(a.visitor_key,a.ip_hash,a.id) END) unique_views,
      SUM(CASE WHEN a.event_type='candle_click' THEN 1 ELSE 0 END) candle_clicks,
      SUM(CASE WHEN a.event_type='album_open' THEN 1 ELSE 0 END) album_opens
    FROM memorials m
    LEFT JOIN analytics_events a ON a.memorial_id=m.id AND a.created_at >= datetime('now', ?)
    WHERE m.company_id=?
    GROUP BY m.id
    ORDER BY views DESC, m.updated_at DESC
    LIMIT 12`).all(`-${days} days`, cid);
  const submissions=db.prepare('SELECT status, COUNT(*) count FROM memorial_submissions WHERE company_id=? GROUP BY status').all(cid);
  const eventsLabels={landing_view:'Просмотр лендинга',memorial_view:'Просмотр страницы памяти',landing_cta_click:'Клик CTA лендинга',landing_contact_click:'Клик контактов',landing_example_click:'Открытие примера',candle_click:'Клик свечи',album_open:'Открытие альбома',album_next:'Следующее фото',album_prev:'Предыдущее фото',memory_submit_click:'Клик отправки слов',qr_click:'Клик QR',submit_view:'Отправка формы семьи'};
  res.send(layout(req,'Аналитика',`<div class="top"><h1>Аналитика</h1><div class="period-tabs"><a class="${days===1?'active':''}" href="?days=1">День</a><a class="${days===7?'active':''}" href="?days=7">Неделя</a><a class="${days===30?'active':''}" href="?days=30">Месяц</a><a class="${days===90?'active':''}" href="?days=90">90 дней</a></div></div>
    <div class="cards analytics-cards">${cards.map(c=>`<div><b>${c[1]}</b><span>${h(c[0])}</span></div>`).join('')}</div>
    <section class="panel"><h2>События за период</h2><table><tr><th>Событие</th><th>Всего</th><th>Уникальных</th></tr>${rows.map(r=>`<tr><td>${h(eventsLabels[r.event_type]||r.event_type)}</td><td>${r.count}</td><td>${r.unique_count}</td></tr>`).join('') || '<tr><td colspan="3">Пока нет событий</td></tr>'}</table></section>
    <section class="panel"><h2>Страницы памяти</h2><table><tr><th>Страница</th><th>Просмотры</th><th>Уникальные</th><th>Свеча</th><th>Альбом</th><th></th></tr>${memorials.map(m=>`<tr><td>${h(m.full_name)}</td><td>${m.views||0}</td><td>${m.unique_views||0}</td><td>${m.candle_clicks||0}</td><td>${m.album_opens||0}</td><td><a href="/admin/memorials/${m.id}">открыть</a></td></tr>`).join('') || '<tr><td colspan="6">Пока нет страниц</td></tr>'}</table></section>
    <div class="grid2"><section class="panel"><h2>Дни</h2><table><tr><th>Дата</th><th>Событий</th></tr>${daily.map(d=>`<tr><td>${h(d.day)}</td><td>${d.count}</td></tr>`).join('') || '<tr><td colspan="2">Нет данных</td></tr>'}</table></section><section class="panel"><h2>Заявки</h2><table><tr><th>Статус</th><th>Количество</th></tr>${submissions.map(s=>`<tr><td>${h(statusLabel(s.status))}</td><td>${s.count}</td></tr>`).join('') || '<tr><td colspan="2">Нет заявок</td></tr>'}</table></section></div>`));
});


function parseAuditMeta(meta){ try { return JSON.parse(meta || '{}'); } catch { return {}; } }
function auditMetaSummary(meta){
  const m = parseAuditMeta(meta);
  const parts = [];
  if(m.scope) parts.push(`scope: ${m.scope}`);
  if(m.status) parts.push(`status: ${m.status}`);
  if(m.plan) parts.push(`plan: ${m.plan}`);
  if(m.partner_id) parts.push(`partner_id: ${m.partner_id}`);
  if(m.impersonation){
    parts.push(`real_user_id: ${m.impersonation.real_user_id || ''}`.trim());
    parts.push(`real_role: ${m.impersonation.real_role || ''}`.trim());
    parts.push(`acting_business_id: ${m.impersonation.acting_business_id || ''}`.trim());
  }
  return parts.filter(Boolean).join(' · ');
}
function auditRowsHtml(rows){
  return `<table><tr><th>Дата</th><th>Актор</th><th>Бизнес</th><th>Партнёр</th><th>Действие</th><th>Объект</th><th>Контекст</th></tr>${rows.map(a=>{
    const meta = parseAuditMeta(a.meta);
    const isImpersonated = Boolean(meta.impersonation);
    const actor = a.manager_name || a.manager_login || (a.manager_id ? `#${a.manager_id}` : 'system');
    const ctx = auditMetaSummary(a.meta);
    return `<tr><td>${h(a.created_at)}</td><td>${h(actor)}${isImpersonated?'<br><span class="audit-impersonation">impersonation</span>':''}</td><td>${h(a.company_name||'')}</td><td>${h(a.partner_name||'')}</td><td>${h(a.action)}</td><td>${h(a.object_type||'')} ${a.object_id?`#${h(a.object_id)}`:''}<br><small>${h(a.object_name||'')}</small></td><td class="audit-meta">${h(ctx||'')}</td></tr>`;
  }).join('') || '<tr><td colspan="7">Записей пока нет</td></tr>'}</table>`;
}
function auditDashboardHtml(req, scope='platform'){
  const isPartnerScope = scope === 'partner';
  let rows;
  if(isPartnerScope){
    const partner = currentPartner(req);
    if(!partner) return layout(req,'Audit log',`<div class="top"><h1>Audit log</h1></div><section class="panel">Партнёр не найден</section>`);
    rows = db.prepare(`SELECT a.*, m.login AS manager_login, m.name AS manager_name, c.name AS company_name, p.name AS partner_name
      FROM audit_log a
      LEFT JOIN managers m ON m.id=a.manager_id
      LEFT JOIN companies c ON c.id=a.company_id
      LEFT JOIN partners p ON p.id=a.partner_id
      WHERE a.partner_id=? OR a.company_id IN (SELECT id FROM companies WHERE partner_id=?)
      ORDER BY a.created_at DESC, a.id DESC LIMIT 200`).all(partner.id, partner.id);
    return layout(req,'Audit log партнёра',`<div class="top"><h1>Audit log партнёра</h1><a class="btn muted" href="/admin/partner/analytics">Аналитика партнёра</a></div><section class="panel"><h2>${h(partner.name)}</h2>${auditRowsHtml(rows)}</section>`);
  }
  rows = db.prepare(`SELECT a.*, m.login AS manager_login, m.name AS manager_name, c.name AS company_name, p.name AS partner_name
    FROM audit_log a
    LEFT JOIN managers m ON m.id=a.manager_id
    LEFT JOIN companies c ON c.id=a.company_id
    LEFT JOIN partners p ON p.id=a.partner_id
    ORDER BY a.created_at DESC, a.id DESC LIMIT 250`).all();
  return layout(req,'Audit log платформы',`<div class="top"><h1>Audit log платформы</h1><a class="btn muted" href="/admin/platform/analytics">Аналитика платформы</a></div><section class="panel"><h2>Последние действия</h2>${auditRowsHtml(rows)}</section>`);
}
app.get('/admin/platform/audit', requireAuth, requireRoles('super_admin'), (req,res)=>res.send(auditDashboardHtml(req,'platform')));
app.get('/admin/partner/audit', requireAuth, requireRoles('partner_admin'), (req,res)=>res.send(auditDashboardHtml(req,'partner')));


app.get('/admin/security', requireAuth, (req,res)=>{
  const cid = req.session.manager.company_id;
  const events = db.prepare('SELECT * FROM security_events WHERE company_id IS NULL OR company_id=? ORDER BY created_at DESC LIMIT 120').all(cid);
  const audits = db.prepare('SELECT * FROM audit_log WHERE company_id=? ORDER BY created_at DESC LIMIT 120').all(cid);
  res.send(layout(req,'Безопасность',`<div class="top"><h1>Безопасность</h1><a class="btn muted" href="/admin/backups/full.zip">Скачать backup</a></div>
    ${technicalPageNotice('Этот раздел обычно нужен администратору', 'Менеджеру каждый день достаточно работать со страницами памяти, CRM и QR. Здесь можно проверить входы, ошибки и журнал безопасности.')}
    <section class="panel"><h2>Статус защиты</h2><div class="cards small-cards"><div><b>CSRF</b><span>токены форм и Origin-check</span></div><div><b>Rate limit</b><span>логин, форма семьи, трекинг</span></div><div><b>Uploads</b><span>MIME + сигнатура + WebP без EXIF</span></div><div><b>Headers</b><span>CSP, nosniff, frame protection</span></div></div></section>
    <section class="panel"><h2>Security events</h2><table><tr><th>Дата</th><th>Событие</th><th>Путь</th><th>IP hash</th></tr>${events.map(e=>`<tr><td>${h(e.created_at)}</td><td>${h(e.event_type)}</td><td>${h(e.path||'')}</td><td><code>${h(e.ip_hash||'')}</code></td></tr>`).join('')}</table></section>
    <section class="panel"><h2>Audit log</h2><table><tr><th>Дата</th><th>Действие</th><th>Объект</th><th>Название</th></tr>${audits.map(a=>`<tr><td>${h(a.created_at)}</td><td>${h(a.action)}</td><td>${h(a.object_type||'')} #${h(a.object_id||'')}</td><td>${h(a.object_name||'')}</td></tr>`).join('')}</table></section>`));
});


function csvEscape(value){
  const s = String(value ?? '');
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
}
function csvBuffer(headers, rows){
  const lines = [headers.map(csvEscape).join(';')].concat(rows.map(r => headers.map(hd => csvEscape(r[hd])).join(';')));
  return Buffer.from('\ufeff' + lines.join('\n'), 'utf8');
}
function exportScope(req){
  if(isSuper(req) && !req.session.manager.company_id) return 'platform';
  if(isPartner(req) && !req.session.manager.company_id) return 'partner';
  return 'business';
}
function currentExportCompanyIds(req){
  const c = currentCompany(req);
  if(c) return [c.id];
  if(isPartner(req)) return scopedCompanyIdsForPartner(req.session.manager.partner_id);
  if(isSuper(req)) return db.prepare('SELECT id FROM companies WHERE is_active=1').all().map(x=>x.id);
  return [];
}
function rememberExport(req, type, format, fileName, size){
  const company = currentCompany(req);
  const partnerId = company?.partner_id || req.session.manager?.partner_id || null;
  try{
    db.prepare(`INSERT INTO export_jobs (company_id, partner_id, created_by, type, scope, format, file_name, file_size, status)
      VALUES (@company_id,@partner_id,@created_by,@type,@scope,@format,@file_name,@file_size,'ready')`).run({
        company_id: company?.id || null,
        partner_id: partnerId,
        created_by: req.session.manager?.id || null,
        type, scope: exportScope(req), format, file_name: fileName, file_size: Number(size||0)
      });
  }catch(e){}
}
function sendDataExport(req, res, type, format){
  const ids = currentExportCompanyIds(req);
  if(!ids.length) return res.status(403).send('Нет данных для экспорта.');
  const ph = ids.map(()=>'?').join(',');
  let headers, rows, label;
  if(type === 'crm'){
    label = 'crm';
    headers = ['created_at','full_name','contact_phone','notify_email','status','priority','assigned_manager','next_contact_at','comment'];
    rows = db.prepare(`SELECT s.created_at,s.full_name,s.contact_phone,s.notify_email,s.status,s.priority,COALESCE(m.name,m.login,'') assigned_manager,s.next_contact_at,s.comment
      FROM memorial_submissions s LEFT JOIN managers m ON m.id=s.assigned_manager_id
      WHERE s.company_id IN (${ph}) ORDER BY s.created_at DESC, s.id DESC`).all(...ids);
  } else {
    label = 'memorials';
    headers = ['id','full_name','slug','status','created_at','updated_at','memories_count','candles_count'];
    rows = db.prepare(`SELECT m.id,m.full_name,m.slug,m.status,m.created_at,m.updated_at,
      (SELECT COUNT(*) FROM memorial_memories mm WHERE mm.memorial_id=m.id) memories_count,
      m.candles_count
      FROM memorials m WHERE m.company_id IN (${ph}) ORDER BY m.updated_at DESC, m.id DESC`).all(...ids);
  }
  const ext = format === 'xlsx' ? 'xlsx' : 'csv';
  const fileName = `pamyat-qr-${label}-${nowStamp()}.${ext}`;
  const buf = csvBuffer(headers, rows);
  rememberExport(req, type === 'crm' ? 'crm_export' : 'memorial_export', ext, fileName, buf.length);
  audit(req, type === 'crm' ? 'crm_export_created' : 'memorial_export_created', 'export', null, fileName, { format: ext, rows: rows.length });
  const company = currentCompany(req);
  if(company) systemEvent(company.id, 'export_created', 'Экспорт создан', `Сформирован файл ${fileName}.`, { relatedType:'export', actionUrl:'/admin/backups', actorManagerId:req.session.manager.id });
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type', format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; charset=utf-8' : 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  return res.send(buf);
}
function backupBusinessPayload(company){
  const memorials = db.prepare('SELECT * FROM memorials WHERE company_id=? ORDER BY id').all(company.id);
  const crm = db.prepare('SELECT * FROM memorial_submissions WHERE company_id=? ORDER BY id').all(company.id);
  const landing = db.prepare('SELECT * FROM landing_pages WHERE company_id=?').get(company.id) || null;
  const photos = memorials.length ? db.prepare(`SELECT * FROM memorial_photos WHERE memorial_id IN (${memorials.map(()=>'?').join(',')}) ORDER BY memorial_id, sort_order`).all(...memorials.map(m=>m.id)) : [];
  const memories = memorials.length ? db.prepare(`SELECT * FROM memorial_memories WHERE memorial_id IN (${memorials.map(()=>'?').join(',')}) ORDER BY memorial_id, sort_order`).all(...memorials.map(m=>m.id)) : [];
  return { business: company, memorials, crm, settings: { landing, photos, memories, exported_at: new Date().toISOString(), format_version: 1 } };
}

function readZipEntries(buffer){
  const sig = 0x06054b50;
  let eocd = -1;
  for(let i = buffer.length - 22; i >= Math.max(0, buffer.length - 70000); i--){
    if(buffer.readUInt32LE(i) === sig){ eocd = i; break; }
  }
  if(eocd < 0) throw new Error('Архив повреждён: не найден центральный каталог ZIP.');
  const total = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const out = {};
  let ptr = cdOffset;
  for(let i=0; i<total; i++){
    if(buffer.readUInt32LE(ptr) !== 0x02014b50) throw new Error('Архив повреждён: ошибка структуры ZIP.');
    const method = buffer.readUInt16LE(ptr + 10);
    const compSize = buffer.readUInt32LE(ptr + 20);
    const nameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const localOffset = buffer.readUInt32LE(ptr + 42);
    const name = buffer.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    ptr += 46 + nameLen + extraLen + commentLen;
    if(name.endsWith('/')) continue;
    if(!/^(business|memorials|crm|settings)\.json$/.test(name)) continue;
    if(buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Архив повреждён: ошибка локального файла ZIP.');
    const lfNameLen = buffer.readUInt16LE(localOffset + 26);
    const lfExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lfNameLen + lfExtraLen;
    const compressed = buffer.slice(dataStart, dataStart + compSize);
    let raw;
    if(method === 0) raw = compressed;
    else if(method === 8) raw = zlib.inflateRawSync(compressed);
    else throw new Error('Архив использует неподдерживаемый метод сжатия.');
    out[name] = raw.toString('utf8');
  }
  return out;
}
function parseBackupBuffer(buffer){
  const entries = readZipEntries(buffer);
  const required = ['business.json','memorials.json','crm.json','settings.json'];
  const missing = required.filter(name => !entries[name]);
  if(missing.length) throw new Error(`Архив повреждён: отсутствуют ${missing.join(', ')}.`);
  const parsed = {
    business: JSON.parse(entries['business.json']),
    memorials: JSON.parse(entries['memorials.json']),
    crm: JSON.parse(entries['crm.json']),
    settings: JSON.parse(entries['settings.json'])
  };
  if(!parsed.business || !Array.isArray(parsed.memorials) || !Array.isArray(parsed.crm) || !parsed.settings) throw new Error('Архив повреждён: неверный формат JSON.');
  return parsed;
}
function backupPreviewInfo(payload){
  const photos = Array.isArray(payload.settings?.photos) ? payload.settings.photos : [];
  const memories = Array.isArray(payload.settings?.memories) ? payload.settings.memories : [];
  const media = photos.filter(p => p.preview_path || p.large_path || p.thumb_path || p.original_path).length;
  return {
    business_name: payload.business?.name || '',
    memorials: payload.memorials.length,
    crm: payload.crm.length,
    settings: Boolean(payload.settings?.landing),
    photos: photos.length,
    memories: memories.length,
    media
  };
}
function restoreTokenPath(token){ return path.join(UPLOAD_ROOT, 'tmp', `restore-${token}.json`); }
function saveRestorePayload(payload){
  fs.mkdirSync(path.join(UPLOAD_ROOT,'tmp'), { recursive:true });
  const token = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(restoreTokenPath(token), JSON.stringify({ payload, created_at: Date.now() }), 'utf8');
  return token;
}
function loadRestorePayload(token){
  if(!/^[a-f0-9]{32}$/.test(String(token||''))) throw new Error('Restore token invalid.');
  const p = restoreTokenPath(token);
  if(!fs.existsSync(p)) throw new Error('Предпросмотр восстановления устарел. Загрузите архив ещё раз.');
  const data = JSON.parse(fs.readFileSync(p,'utf8'));
  if(Date.now() - Number(data.created_at || 0) > 1000*60*30) throw new Error('Предпросмотр восстановления устарел. Загрузите архив ещё раз.');
  return data.payload;
}
function tableColumns(table){ return db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name); }
function insertRows(table, rows, overrides={}){
  const cols = tableColumns(table);
  const insertable = cols.filter(c => c !== 'created_at' || rows.some(r => r.created_at));
  const placeholders = insertable.map(c => '@' + c).join(',');
  const stmt = db.prepare(`INSERT INTO ${table} (${insertable.join(',')}) VALUES (${placeholders})`);
  let count = 0;
  for(const raw of rows || []){
    const row = { ...raw, ...overrides };
    const data = {};
    for(const c of insertable) data[c] = row[c] === undefined ? null : row[c];
    stmt.run(data);
    count++;
  }
  return count;
}
function restoreBackupForCompany(req, company, payload, opts){
  const report = { memorials:0, crm:0, settings:0, errors:[] };
  const tx = db.transaction(()=>{
    if(opts.restore_settings && payload.settings?.landing){
      const cols = tableColumns('landing_pages').filter(c => c !== 'id');
      const landing = { ...payload.settings.landing, company_id: company.id };
      const setCols = cols.filter(c => c !== 'company_id');
      const data = {};
      for(const c of cols) data[c] = landing[c] === undefined ? null : landing[c];
      const existing = db.prepare('SELECT id FROM landing_pages WHERE company_id=?').get(company.id);
      if(existing){
        const setSql = setCols.map(c=>`${c}=@${c}`).join(',');
        db.prepare(`UPDATE landing_pages SET ${setSql}, updated_at=CURRENT_TIMESTAMP WHERE company_id=@company_id`).run(data);
      } else {
        db.prepare(`INSERT INTO landing_pages (${cols.join(',')}) VALUES (${cols.map(c=>'@'+c).join(',')})`).run(data);
      }
      report.settings = 1;
    }
    if(opts.restore_memorials){
      const ids = db.prepare('SELECT id FROM memorials WHERE company_id=?').all(company.id).map(r=>r.id);
      if(ids.length){
        const ph = ids.map(()=>'?').join(',');
        db.prepare(`DELETE FROM memorial_memories WHERE memorial_id IN (${ph})`).run(...ids);
        db.prepare(`DELETE FROM memorial_qualities WHERE memorial_id IN (${ph})`).run(...ids);
        db.prepare(`DELETE FROM memorial_milestones WHERE memorial_id IN (${ph})`).run(...ids);
        db.prepare(`DELETE FROM memorial_photos WHERE memorial_id IN (${ph})`).run(...ids);
      }
      db.prepare('DELETE FROM memorials WHERE company_id=?').run(company.id);
      const restoredMemorials = (payload.memorials || []).map(m => ({...m, company_id: company.id}));
      report.memorials = insertRows('memorials', restoredMemorials);
      insertRows('memorial_photos', payload.settings?.photos || []);
      insertRows('memorial_memories', payload.settings?.memories || []);
    }
    if(opts.restore_crm){
      db.prepare('DELETE FROM memorial_submissions WHERE company_id=?').run(company.id);
      const restoredCrm = (payload.crm || []).map(s => ({...s, company_id: company.id}));
      report.crm = insertRows('memorial_submissions', restoredCrm);
    }
  });
  tx();
  audit(req,'backup_restored','backup',company.id,company.name,{ report, restore_memorials:!!opts.restore_memorials, restore_crm:!!opts.restore_crm, restore_settings:!!opts.restore_settings });
  systemEvent(company.id, 'backup_restored', 'Резервная копия восстановлена', `Восстановлено: страниц ${report.memorials}, CRM ${report.crm}, настройки ${report.settings}.`, { relatedType:'backup', relatedId:company.id, actionUrl:'/admin/backups', actorManagerId:req.session.manager.id, priority:'high' });
  return report;
}
function restoreReportHtml(report){
  return `<div class="grid3"><div class="stat"><b>${report.memorials}</b><span>Страницы памяти</span></div><div class="stat"><b>${report.crm}</b><span>CRM-заявки</span></div><div class="stat"><b>${report.settings}</b><span>Настройки</span></div></div><p class="muted-text">Ошибок: ${report.errors?.length || 0}</p>`;
}

function exportHistoryHtml(req){
  const company = currentCompany(req);
  const rows = company ? db.prepare('SELECT e.*, m.login creator_login, m.name creator_name FROM export_jobs e LEFT JOIN managers m ON m.id=e.created_by WHERE e.company_id=? ORDER BY e.created_at DESC, e.id DESC LIMIT 30').all(company.id) : [];
  const typeLabel = { crm_export:'CRM', memorial_export:'Страницы памяти', business_backup:'Backup бизнеса' };
  return `<table><tr><th>Дата</th><th>Тип</th><th>Формат</th><th>Создал</th><th>Размер</th><th>Файл</th></tr>${rows.map(r=>`<tr><td>${h(r.created_at)}</td><td>${h(typeLabel[r.type]||r.type)}</td><td>${h(r.format)}</td><td>${h(r.creator_name||r.creator_login||'system')}</td><td>${r.file_size ? Math.ceil(r.file_size/1024)+' КБ' : 'stream'}</td><td><code>${h(r.file_name)}</code></td></tr>`).join('') || '<tr><td colspan="6">История экспортов пока пустая</td></tr>'}</table>`;
}
app.get('/admin/backups', requireAuth, (req,res)=>{
  const c = currentCompany(req);
  res.send(layout(req,'Экспорт и резервные копии',`<div class="top"><h1>Экспорт и резервные копии</h1></div>
    ${technicalPageNotice('Резервные копии — на случай проверки или восстановления', 'Если вы просто создаёте страницы памяти, этот раздел можно не открывать. Он нужен для выгрузок и восстановления данных.')}
    <section class="panel"><h2>Выгрузки</h2><p class="muted-text">Экспортируются только данные текущего бизнеса: CRM-заявки, страницы памяти и настройки.</p><div class="actions"><a class="btn" href="/admin/backups/crm.csv">Экспорт CRM CSV</a><a class="btn muted" href="/admin/backups/crm.xlsx">Экспорт CRM XLSX</a><a class="btn" href="/admin/backups/memorials.csv">Экспорт страниц CSV</a><a class="btn muted" href="/admin/backups/memorials.xlsx">Экспорт страниц XLSX</a></div></section>
    <section class="panel"><h2>Резервная копия бизнеса</h2><p class="muted-text">ZIP содержит business.json, memorials.json, crm.json и settings.json. Структура подготовлена под безопасное восстановление.</p><a class="btn" href="/admin/backups/business.zip">Создать резервную копию</a></section>
    <section class="panel form"><h2>Восстановление из backup</h2><p class="muted-text">Сначала загрузите архив для предпросмотра. Данные не меняются до финального подтверждения названием бизнеса.</p><form method="post" enctype="multipart/form-data" action="/admin/backups/restore/preview"><label class="field"><span>backup.zip</span><input type="file" name="backup_zip" accept=".zip,application/zip" required></label><button class="btn">Предпросмотр восстановления</button></form></section>
    <section class="panel"><h2>История экспортов</h2>${exportHistoryHtml(req)}</section>
    <section class="panel actions"><h2>Технический backup</h2><a class="btn muted" href="/admin/backups/full.zip">Скачать архив проекта</a><a class="btn muted" href="/admin/backups/database.sqlite">Скачать базу</a></section>`));
});

app.post('/api/backups/preview', requireAuth, requireCompanyContext, backupUpload.single('backup_zip'), (req,res)=>{
  try{
    if(!req.file?.buffer) return res.status(400).json({ ok:false, error:'Файл не загружен.' });
    const payload = parseBackupBuffer(req.file.buffer);
    const preview = backupPreviewInfo(payload);
    audit(req,'backup_restore_preview','backup',req.company.id,req.company.name,preview);
    systemEvent(req.company.id, 'backup_restore_preview', 'Предпросмотр восстановления backup', `Проверен архив: страниц ${preview.memorials}, CRM ${preview.crm}.`, { relatedType:'backup', relatedId:req.company.id, actionUrl:'/admin/backups', actorManagerId:req.session.manager.id });
    res.json({ ok:true, preview });
  }catch(e){
    const c = currentCompany(req);
    if(c) systemEvent(c.id, 'backup_restore_failed', 'Ошибка восстановления backup', e.message, { relatedType:'backup', relatedId:c.id, actionUrl:'/admin/backups', actorManagerId:req.session.manager.id, priority:'high' });
    res.status(400).json({ ok:false, error:e.message });
  }
});
app.post('/api/backups/restore', requireAuth, requireCompanyContext, backupUpload.single('backup_zip'), (req,res)=>{
  try{
    if(!req.file?.buffer) return res.status(400).json({ ok:false, error:'Файл не загружен.' });
    const payload = parseBackupBuffer(req.file.buffer);
    if(String(req.body.confirm_business_name || '').trim() !== req.company.name) return res.status(400).json({ ok:false, error:'Restore confirmation mismatch' });
    const report = restoreBackupForCompany(req, req.company, payload, {
      restore_memorials: req.body.restore_memorials !== '0',
      restore_crm: req.body.restore_crm !== '0',
      restore_settings: req.body.restore_settings !== '0'
    });
    res.json({ ok:true, report });
  }catch(e){
    const c = currentCompany(req);
    audit(req,'backup_restore_failed','backup',c?.id||null,c?.name||'',{ error:e.message });
    if(c) systemEvent(c.id, 'backup_restore_failed', 'Ошибка восстановления backup', e.message, { relatedType:'backup', relatedId:c.id, actionUrl:'/admin/backups', actorManagerId:req.session.manager.id, priority:'high' });
    res.status(400).json({ ok:false, error:e.message });
  }
});
app.post('/admin/backups/restore/preview', requireAuth, backupUpload.single('backup_zip'), (req,res)=>{
  const c = currentCompany(req);
  try{
    if(!c) return res.status(403).send('Нет выбранного бизнеса.');
    if(!req.file?.buffer) return res.status(400).send('Файл не загружен.');
    const payload = parseBackupBuffer(req.file.buffer);
    const preview = backupPreviewInfo(payload);
    const token = saveRestorePayload(payload);
    audit(req,'backup_restore_preview','backup',c.id,c.name,preview);
    systemEvent(c.id, 'backup_restore_preview', 'Предпросмотр восстановления backup', `Проверен архив: страниц ${preview.memorials}, CRM ${preview.crm}.`, { relatedType:'backup', relatedId:c.id, actionUrl:'/admin/backups', actorManagerId:req.session.manager.id });
    res.send(layout(req,'Предпросмотр восстановления',`<div class="top"><h1>Предпросмотр восстановления</h1><a class="btn muted" href="/admin/backups">Назад</a></div>
      <section class="panel"><h2>Будет обновлено</h2><div class="grid3"><div class="stat"><b>${preview.memorials}</b><span>Страницы памяти</span></div><div class="stat"><b>${preview.crm}</b><span>CRM-заявки</span></div><div class="stat"><b>${preview.settings ? 'да' : 'нет'}</b><span>Настройки бизнеса</span></div></div><p class="muted-text">Фото: ${preview.photos}. Воспоминания: ${preview.memories}. Медиа-ссылки: ${preview.media}.</p></section>
      <form class="panel form" method="post" action="/admin/backups/restore"><h2>Подтверждение</h2><input type="hidden" name="restore_token" value="${h(token)}"><label><input type="checkbox" name="restore_memorials" checked> Страницы памяти</label><label><input type="checkbox" name="restore_crm" checked> CRM</label><label><input type="checkbox" name="restore_settings" checked> Настройки</label><label class="field"><span>Введите название бизнеса: ${h(c.name)}</span><input name="confirm_business_name" required></label><button class="btn danger">Восстановить</button></form>`));
  }catch(e){
    if(c) systemEvent(c.id, 'backup_restore_failed', 'Ошибка восстановления backup', e.message, { relatedType:'backup', relatedId:c.id, actionUrl:'/admin/backups', actorManagerId:req.session.manager.id, priority:'high' });
    res.status(400).send(layout(req,'Архив повреждён',`<section class="panel"><h1>Архив повреждён</h1><p>${h(e.message)}</p><a class="btn" href="/admin/backups">Назад</a></section>`));
  }
});
app.post('/admin/backups/restore', requireAuth, (req,res)=>{
  const c = currentCompany(req);
  try{
    if(!c) return res.status(403).send('Нет выбранного бизнеса.');
    if(String(req.body.confirm_business_name || '').trim() !== c.name) throw new Error('Restore confirmation mismatch');
    const payload = loadRestorePayload(req.body.restore_token);
    const report = restoreBackupForCompany(req, c, payload, {
      restore_memorials: !!req.body.restore_memorials,
      restore_crm: !!req.body.restore_crm,
      restore_settings: !!req.body.restore_settings
    });
    res.send(layout(req,'Backup восстановлен',`<div class="top"><h1>Backup восстановлен</h1><a class="btn" href="/admin/backups">К экспортам</a></div><section class="panel"><h2>Restore report</h2>${restoreReportHtml(report)}</section>`));
  }catch(e){
    audit(req,'backup_restore_failed','backup',c?.id||null,c?.name||'',{ error:e.message });
    if(c) systemEvent(c.id, 'backup_restore_failed', 'Ошибка восстановления backup', e.message, { relatedType:'backup', relatedId:c.id, actionUrl:'/admin/backups', actorManagerId:req.session.manager.id, priority:'high' });
    res.status(400).send(layout(req,'Восстановление не выполнено',`<section class="panel"><h1>Восстановление не выполнено</h1><p>${h(e.message)}</p><a class="btn" href="/admin/backups">Назад</a></section>`));
  }
});

app.get('/api/export/crm.csv', requireAuth, requireCompanyContext, (req,res)=>sendDataExport(req,res,'crm','csv'));
app.get('/api/export/crm.xlsx', requireAuth, requireCompanyContext, (req,res)=>sendDataExport(req,res,'crm','xlsx'));
app.get('/api/export/memorials.csv', requireAuth, requireCompanyContext, (req,res)=>sendDataExport(req,res,'memorials','csv'));
app.get('/api/export/memorials.xlsx', requireAuth, requireCompanyContext, (req,res)=>sendDataExport(req,res,'memorials','xlsx'));
app.get('/admin/backups/crm.csv', requireAuth, (req,res)=>sendDataExport(req,res,'crm','csv'));
app.get('/admin/backups/crm.xlsx', requireAuth, (req,res)=>sendDataExport(req,res,'crm','xlsx'));
app.get('/admin/backups/memorials.csv', requireAuth, (req,res)=>sendDataExport(req,res,'memorials','csv'));
app.get('/admin/backups/memorials.xlsx', requireAuth, (req,res)=>sendDataExport(req,res,'memorials','xlsx'));
app.get('/admin/backups/business.zip', requireAuth, (req,res)=>{
  const c = currentCompany(req);
  if(!c) return res.status(403).send('Нет выбранного бизнеса.');
  const fileName = `pamyat-qr-business-${c.slug}-${nowStamp()}.zip`;
  rememberExport(req, 'business_backup', 'zip', fileName, 0);
  audit(req,'business_backup_created','backup',c.id,c.name,{ format:'zip' });
  systemEvent(c.id, 'backup_created', 'Резервная копия создана', `Создан архив ${fileName}.`, { relatedType:'backup', relatedId:c.id, actionUrl:'/admin/backups', actorManagerId:req.session.manager.id, priority:'high' });
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type','application/zip');
  res.setHeader('Content-Disposition',`attachment; filename="${fileName}"`);
  const payload = backupBusinessPayload(c);
  const archive=archiver('zip');
  archive.on('error', err => { throw err; });
  archive.pipe(res);
  archive.append(JSON.stringify(payload.business,null,2), { name:'business.json' });
  archive.append(JSON.stringify(payload.memorials,null,2), { name:'memorials.json' });
  archive.append(JSON.stringify(payload.crm,null,2), { name:'crm.json' });
  archive.append(JSON.stringify(payload.settings,null,2), { name:'settings.json' });
  archive.finalize();
});
app.get('/admin/backups/database.sqlite', requireAuth, (req,res)=>{ audit(req,'download_database_backup','backup',null,'database.sqlite'); res.setHeader('Cache-Control','no-store'); res.download(path.join(ROOT,'database.sqlite')); });
app.get('/admin/backups/full.zip', requireAuth, (req,res)=>{ audit(req,'download_full_backup','backup',null,'full.zip'); res.setHeader('Cache-Control','no-store'); res.setHeader('Content-Type','application/zip'); res.setHeader('Content-Disposition',`attachment; filename="pamyat-backup-${nowStamp()}.zip"`); const archive=archiver('zip'); archive.pipe(res); for(const f of ['database.sqlite','database.sqlite-wal','database.sqlite-shm']){ const p=path.join(ROOT,f); if(fs.existsSync(p)) archive.file(p,{name:f}); } archive.directory(UPLOAD_ROOT,'uploads'); archive.finalize(); });

app.get('/healthz',(req,res)=>res.json({ok:true,service:'pamyat-qr-admin'}));
app.use((err,req,res,next)=>{ console.error(err); securityLog(req,'server_error',{message:err.message}); const detail = IS_PROD ? 'Произошла ошибка. Детали записаны в журнал.' : h(err.stack||err.message); res.status(500).send(layout(req,'Ошибка',`<section class="panel"><h1>Ошибка</h1><pre>${detail}</pre></section>`)); });
app.listen(PORT,()=>console.log(`Pamyat admin listening on ${BASE_URL}`));
