'use strict';
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const child = require('child_process');
const root = path.resolve(__dirname, '..');
let bad = false;
function ok(s){ console.log('✅ '+s); }
function fail(s){ bad=true; console.log('❌ '+s); }
for (const f of ['package.json','server.js','db.js','templates/landing.template.html','templates/memorial.template.html']) fs.existsSync(path.join(root,f)) ? ok(`${f} найден`) : fail(`${f} отсутствует`);
for (const d of ['uploads','sessions','logs','public/admin']) fs.existsSync(path.join(root,d)) ? ok(`${d} найден`) : fail(`${d} отсутствует`);
if(!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'dev-secret-change-me') fail('SESSION_SECRET не задан или небезопасный');
if(!process.env.ANALYTICS_SALT) fail('ANALYTICS_SALT не задан');
if(process.env.NODE_ENV === 'production' && !process.env.APP_BASE_URL) fail('APP_BASE_URL обязателен в production');
for (const f of ['server.js','db.js','scripts/seed.js']) {
  try { child.execFileSync(process.execPath, ['--check', path.join(root,f)], {stdio:'pipe'}); ok(`${f}: синтаксис корректный`); }
  catch(e){ fail(`${f}: ошибка синтаксиса`); process.stderr.write(e.stderr||''); }
}
console.log('\nПосле установки: npm install && npm run seed && npm start');
console.log('Вход: http://localhost:3001/admin/login');
console.log('Безопасность: http://localhost:3001/admin/security');
process.exit(bad?1:0);
