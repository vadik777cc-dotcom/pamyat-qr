'use strict';
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');

function shortToken(){ return require('crypto').randomBytes(5).toString('hex'); }

function ensureDemo(){
  let company = db.prepare('SELECT * FROM companies ORDER BY id LIMIT 1').get();
  if(!company){
    const info = db.prepare(`INSERT INTO companies (name,slug,city,phone,email,telegram_url,whatsapp_url,contact_label,footer_text,legal_name,data_contact,data_email,privacy_url,accent_color)
      VALUES ('Память QR','pamyat-qr','Москва','+7 000 000-00-00','hello@example.ru','https://t.me/pamyat_qr','https://wa.me/70000000000','Связаться','Страница создана при поддержке Память QR','ООО Память QR','Администратор','privacy@example.ru','', '#B47A3D')`).run();
    company = db.prepare('SELECT * FROM companies WHERE id=?').get(info.lastInsertRowid);
  }
  // Reset demo mutable white-label/domain state on each seed run so full regression starts deterministic.
  db.prepare(`UPDATE companies SET
    name='Память QR',
    slug='pamyat-qr',
    custom_domain=NULL,
    domain_status='not_connected',
    white_label_enabled=0,
    hide_platform_branding=0,
    brand_display_name=NULL,
    public_footer_brand=NULL,
    robots_policy='default',
    accent_color='#B47A3D',
    updated_at=CURRENT_TIMESTAMP
    WHERE id=?`).run(company.id);
  company = db.prepare('SELECT * FROM companies WHERE id=?').get(company.id);

  if(!db.prepare('SELECT id FROM managers WHERE company_id=? LIMIT 1').get(company.id)){
    db.prepare('INSERT INTO managers (company_id,login,password_hash,role,name) VALUES (?,?,?,?,?)').run(company.id, process.env.ADMIN_LOGIN || 'manager', bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'change-me', 10), 'business_owner', company.name);
  }

  // Session 27 demo access model: super admin, partner admin and business owner.
  if(!db.prepare("SELECT id FROM managers WHERE login='admin'").get()){
    db.prepare('INSERT INTO managers (login,password_hash,role,name,is_active) VALUES (?,?,?,?,1)').run('admin', bcrypt.hashSync('change-me', 10), 'super_admin', 'Главный администратор');
  }
  let partner = db.prepare("SELECT * FROM partners WHERE slug='demo-partner'").get();
  if(!partner){
    const pinfo = db.prepare("INSERT INTO partners (name,slug,contact_name,phone,email,status) VALUES ('Демо-партнёр','demo-partner','Партнёр','+7 111 111-11-11','partner@example.ru','active')").run();
    partner = db.prepare('SELECT * FROM partners WHERE id=?').get(pinfo.lastInsertRowid);
  }
  if(!db.prepare("SELECT id FROM managers WHERE login='partner'").get()){
    db.prepare('INSERT INTO managers (partner_id,login,password_hash,role,name,email,is_active) VALUES (?,?,?,?,?,?,1)').run(partner.id, 'partner', bcrypt.hashSync('change-me', 10), 'partner_admin', 'Демо-партнёр', 'partner@example.ru');
  } else {
    db.prepare("UPDATE managers SET partner_id=?, role='partner_admin', is_active=1 WHERE login='partner'").run(partner.id);
  }
  if(!company.partner_id && !company.created_by_manager_id){
    db.prepare("UPDATE companies SET account_status='active', plan='standard' WHERE id=?").run(company.id);
  }

  if(!db.prepare('SELECT id FROM landing_pages WHERE company_id=?').get(company.id)){
    db.prepare(`INSERT INTO landing_pages (company_id,status,seo_title,seo_description,preloader_title,hero_title,hero_subtitle,hero_primary_label,hero_primary_url,hero_secondary_label,hero_secondary_url,hero_image,nav_json,contacts_json,faq_json,blocks_json)
      VALUES (@company_id,'published',@seo_title,@seo_description,@preloader_title,@hero_title,@hero_subtitle,@hero_primary_label,@hero_primary_url,@hero_secondary_label,@hero_secondary_url,@hero_image,@nav_json,@contacts_json,@faq_json,@blocks_json)`).run({
        company_id: company.id,
        seo_title:'Сохраните память о близком человеке',
        seo_description:'Страница памяти с фотографиями, историей жизни и воспоминаниями семьи, которую можно открыть по QR-коду.',
        preloader_title: company.name || 'Память QR',
        hero_title:'Сохраните память о близком человеке',
        hero_subtitle:'После сканирования QR-кода откроется страница с фотографиями, историей жизни и воспоминаниями семьи.',
        hero_primary_label:'Посмотреть пример страницы', hero_primary_url:'#example', hero_secondary_label:'Как это работает', hero_secondary_url:'#how-create',
        hero_image:'/static/assets/landing/hero-b2c.webp',
        nav_json: JSON.stringify([{label:'Как работает',url:'#how',visible:true},{label:'Что внутри',url:'#features',visible:true},{label:'QR-код',url:'#qr',visible:true},{label:'Вопросы',url:'#faq',visible:true}]),
        contacts_json: JSON.stringify([{type:'phone',label:'+7 000 000-00-00',url:'tel:+70000000000',visible:true},{type:'telegram',label:'Telegram',url:'https://t.me/pamyat_qr',visible:true},{type:'whatsapp',label:'WhatsApp',url:'https://wa.me/70000000000',visible:true}]),
        faq_json: JSON.stringify([{q:'Нужно ли устанавливать приложение?',a:'Нет. Страница открывается в обычном браузере телефона после сканирования QR-кода камерой.',visible:true},{q:'Можно ли добавить фотографии позже?',a:'Да. Фотографии, историю и воспоминания можно дополнять после публикации.',visible:true},{q:'Кто может просматривать страницу?',a:'Любой человек, получивший ссылку или отсканировавший QR-код.',visible:true}]),
        blocks_json: JSON.stringify({featuresVisible:true,qrVisible:true,faqVisible:true,contactsVisible:true})
      });
    console.log('Создан пример B2C-лендинга.');
  } else {
    console.log('B2C-лендинг уже есть.');
  }
  let memorial = db.prepare('SELECT * FROM memorials WHERE company_id=? AND slug=?').get(company.id, 'aleksey-orlov');
  if(!memorial){
    const info = db.prepare(`INSERT INTO memorials (uuid,company_id,full_name,slug,public_token,birth_date,death_date,quote,epitaph,biography,main_photo,status,privacy_status,noindex,consent_confirmed,footer_text,section_order_json,hidden_sections_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        uuidv4(), company.id, 'Алексей Николаевич Орлов', 'aleksey-orlov', shortToken(), '1951-03-14', '2023-08-22', 'Главное — держаться вместе.',
        'Любящий муж, отец и человек, который всегда держал слово.',
        'Алексей Николаевич родился в семье, где с детства ценили труд, честность и уважение к людям. Он умел работать руками, не боялся сложных дел и всегда доводил начатое до конца.\n\nДля родных он был человеком спокойной силы: рядом с ним было надёжно, понятно и тепло. Он любил семейные вечера, разговоры за столом, поездки на природу и особенно гордился детьми.\n\nЕго помнят как человека, который не любил громких слов, но всегда помогал делом. Его забота, чувство юмора и умение поддержать останутся в памяти семьи, друзей и всех, кто был рядом.',
        '/static/assets/memory/hero-portrait-bg.webp', 'published', 'unlisted', 1, 1, 'Пусть тёплые слова и фотографии остаются здесь рядом.', JSON.stringify(['hero','words','story','album','footer']), JSON.stringify([])
      );
    const mid = info.lastInsertRowid;
    [['approved',1,'От супруги','Он всегда говорил: «Главное — держаться вместе». Для нашей семьи эти слова остались правилом.'],['approved',1,'От дочери','Папа умел успокоить одним взглядом. Рядом с ним всегда казалось, что всё будет хорошо.'],['approved',0,'От сына','Он научил меня не обещать лишнего и отвечать за свои слова. Это останется со мной на всю жизнь.'],['approved',0,'От друзей','Алексей был человеком, на которого можно было положиться. Если он сказал, что поможет, значит поможет.']].forEach((m,i)=>db.prepare('INSERT INTO memorial_memories (memorial_id,status,is_featured,author,text,sort_order) VALUES (?,?,?,?,?,?)').run(mid,m[0],m[1],m[2],m[3],i));
    [['Надёжный','Всегда держал слово и помогал делом.'],['Семейный','Больше всего ценил близких и домашнее тепло.'],['Спокойный','Умел поддержать без лишних слов.'],['Добрый','Помнил о людях и замечал, когда нужна помощь.']].forEach((q,i)=>db.prepare('INSERT INTO memorial_qualities (memorial_id,title,description,sort_order) VALUES (?,?,?,?)').run(mid,q[0],q[1],i));
    [['1951','Родился и вырос в семье, где ценили труд и честность.'],['1974','Создал семью и построил дом, куда всегда хотелось возвращаться.'],['1988','Семейные поездки и фотографии, которые теперь стали частью архива.'],['2023','Тёплая память о нём осталась с близкими.']].forEach((x,i)=>db.prepare('INSERT INTO memorial_milestones (memorial_id,year,text,sort_order) VALUES (?,?,?,?)').run(mid,x[0],x[1],i));
    const photoStmt = db.prepare('INSERT INTO memorial_photos (memorial_id,original_path,preview_path,large_path,thumb_path,title,caption,photo_date,place,focus_x,focus_y,is_visible,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    [1,2,3,4,5,6].forEach((n,i)=>{ const p=`/static/assets/memory/album-${n}.jpg`; const titles=['Семейное фото','Студенческие годы','На отдыхе с сыном','С друзьями','Прогулка в парке','Старые фотографии']; const dates=['1988','1970-е','1995','1980-е','1992','']; photoStmt.run(mid,p,p,p,p,titles[i],titles[i],dates[i],'Семейный архив',0.5,0.5,1,i*10); });
    const cover = db.prepare('SELECT id FROM memorial_photos WHERE memorial_id=? ORDER BY sort_order LIMIT 1').get(mid);
    if(cover) db.prepare('UPDATE memorials SET album_cover_photo_id=? WHERE id=?').run(cover.id, mid);
    console.log('Создан пример страницы памяти: Алексей Орлов.');
  } else {
    console.log('Пример страницы памяти уже есть: Алексей Орлов.');
  }
  db.prepare("UPDATE managers SET role='business_owner', name=COALESCE(name,(SELECT name FROM companies WHERE companies.id=managers.company_id)) WHERE login=? AND role IN ('manager','')").run(process.env.ADMIN_LOGIN || 'manager');
  // Нормализация старых demo-дат из формата dd.mm.yyyy в формат input[type=date].
  db.prepare("UPDATE memorials SET birth_date='1951-03-14' WHERE company_id=? AND slug='aleksey-orlov' AND birth_date='14.03.1951'").run(company.id);
  db.prepare("UPDATE memorials SET death_date='2023-08-22' WHERE company_id=? AND slug='aleksey-orlov' AND death_date='22.08.2023'").run(company.id);
  console.log('Готово. Откройте /admin, /admin/landing и /admin/memorials.');
}

ensureDemo();
