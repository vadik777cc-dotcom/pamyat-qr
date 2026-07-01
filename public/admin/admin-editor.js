(function(){
  function $(sel, root=document){ return root.querySelector(sel); }
  function $all(sel, root=document){ return Array.from(root.querySelectorAll(sel)); }
  function textToParas(value){ return String(value || '').split(/\n+/).map(s=>s.trim()).filter(Boolean); }
  function formatDateRu(value){ const v=String(value||'').trim(); const m=v.match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[3]}.${m[2]}.${m[1]}` : v; }

  function setText(doc, selectors, value){
    if(!value) return;
    selectors.forEach(sel => $all(sel, doc).forEach(el => { el.textContent = value; }));
  }
  function setFirstText(doc, selectors, value){
    if(!value) return;
    for(const sel of selectors){ const el=$(sel, doc); if(el){ el.textContent=value; return; } }
  }
  function applyLivePreview(form, iframe){
    if(!iframe || !iframe.contentDocument) return;
    const doc = iframe.contentDocument;
    const kind = form.dataset.editorKind;
    const get = name => (form.elements[name] && form.elements[name].value) || '';
    try{
      if(kind === 'landing'){
        setFirstText(doc, ['.hero h1','h1'], get('hero_title'));
        setFirstText(doc, ['.hero-lead','p'], get('hero_subtitle'));
        setText(doc, ['.brand-title','.brand b','.brand__title'], get('preloader_title'));
        setText(doc, ['.btn.primary','.hero-actions .btn:first-child'], get('hero_primary_label'));
      }
      if(kind === 'memorial'){
        const full = get('full_name');
        setText(doc, ['.story-title','.person__name','.memory-person-name'], full);
        setFirstText(doc, ['.quote__main','.hero-quote','.memory-quote'], get('quote'));
        setFirstText(doc, ['.quote__sub','.epitaph','.memory-epitaph'], get('epitaph'));
        setText(doc, ['.person__dates'], [formatDateRu(get('birth_date')), formatDateRu(get('death_date'))].filter(Boolean).join(' — '));
        const bio = textToParas(get('biography'));
        const targets = $all('.story-text p, .biography p, .life-story p', doc);
        targets.forEach((el,i)=>{ if(bio[i]) el.textContent=bio[i]; });
        setFirstText(doc, ['.final-footer__text','.memory-final-text'], get('footer_text'));
      }
    }catch(e){ /* preview may be cross-state while loading */ }
  }

  function initDraft(form){
    const key = 'pamyatqr-admin-draft:' + (form.dataset.draftKey || location.pathname);
    const signature = form.dataset.draftSignature || '';
    const saved = localStorage.getItem(key);
    if(saved){
      try{
        const parsed = JSON.parse(saved);
        const data = parsed && parsed.data ? parsed.data : parsed;
        const savedSignature = parsed && parsed.data ? (parsed.signature || '') : '';
        if(signature && savedSignature !== signature){
          localStorage.removeItem(key);
        } else {
          Object.keys(data || {}).forEach(name => {
            const field = form.elements[name];
            if(!field || field.type === 'file') return;
            if(name === 'existing_photo_id' || name === 'album_cover_photo_id' || /^photo_/.test(name)) return;
            if(field instanceof RadioNodeList || Array.isArray(field)) return;
            if(field.type === 'hidden') return;
            if(field.type === 'checkbox') field.checked = !!data[name];
            else field.value = data[name];
          });
          form.classList.add('draft-restored');
        }
      }catch{ localStorage.removeItem(key); }
    }
    const save = () => {
      const data = {};
      $all('input, textarea, select', form).forEach(el => {
        if(!el.name || el.type === 'file' || el.type === 'hidden') return;
        if(el.name === 'existing_photo_id' || el.name === 'album_cover_photo_id' || /^photo_/.test(el.name)) return;
        data[el.name] = el.type === 'checkbox' ? el.checked : el.value;
      });
      localStorage.setItem(key, JSON.stringify({ signature, data }));
    };
    form.addEventListener('input', save);
    form.addEventListener('change', save);
    form.addEventListener('submit', () => localStorage.removeItem(key));
  }

  function initCounters(form){
    const limits = { biography: 7000, epitaph: 700, hero_title: 110, hero_subtitle: 320, seo_title: 80, seo_description: 180 };
    Object.entries(limits).forEach(([name, limit]) => {
      const el = form.elements[name];
      if(!el) return;
      const badge = document.createElement('small');
      badge.className = 'char-counter';
      el.closest('.field')?.appendChild(badge);
      const update = () => {
        const n = String(el.value || '').length;
        badge.textContent = `${n}/${limit}`;
        badge.classList.toggle('danger', n > limit);
        el.classList.toggle('too-long', n > limit);
      };
      el.addEventListener('input', update); update();
    });
  }

  function initDeviceSwitch(root){
    $all('[data-device]', root).forEach(btn => btn.addEventListener('click', () => {
      const shell = btn.closest('.editor-shell');
      $all('[data-device]', shell).forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const frame = $('[data-live-preview]', shell);
      if(frame) frame.classList.toggle('is-mobile', btn.dataset.device === 'mobile');
    }));
  }



  // Session 19: tabbed editors to remove endless vertical forms.
  function titleForTab(form, raw){
    const kind = form.dataset.editorKind || '';
    const s = String(raw || '').trim();
    if(kind === 'landing'){
      if(/hero|seo/i.test(s)) return 'Hero / SEO';
      if(/показывать|блоки/i.test(s)) return 'Блоки';
      if(/навигац/i.test(s)) return 'Навигация';
      if(/контакт/i.test(s)) return 'Контакты';
      if(/faq|вопрос/i.test(s)) return 'FAQ';
    }
    if(kind === 'memorial'){
      if(/основ/i.test(s)) return 'Основное';
      if(/блоки/i.test(s)) return 'Секции';
      if(/т[ёе]плые|слова/i.test(s)) return 'Слова';
      if(/каким|помнят/i.test(s)) return 'Качества';
      if(/важные|моменты/i.test(s)) return 'Моменты';
      if(/альбом/i.test(s)) return 'Альбом';
      if(/финал/i.test(s)) return 'Финал';
    }
    return s || 'Раздел';
  }

  function initEditorTabs(form){
    if(form.dataset.tabsReady) return;
    const headings = $all(':scope > h2', form);
    if(headings.length < 3) return;
    form.dataset.tabsReady = '1';
    form.classList.add('tabbed-editor-form');

    const nav = document.createElement('div');
    nav.className = 'editor-tabs';
    const sections = [];

    headings.forEach((h2, index) => {
      const section = document.createElement('section');
      section.className = 'editor-tab-section';
      section.dataset.tabIndex = String(index);
      const label = titleForTab(form, h2.textContent);
      section.dataset.tabLabel = label;
      h2.parentNode.insertBefore(section, h2);
      section.appendChild(h2);

      let node = section.nextSibling;
      while(node){
        const next = node.nextSibling;
        if(node.nodeType === 1){
          if(node.matches('h2') || node.classList.contains('sticky-save')) break;
        }
        section.appendChild(node);
        node = next;
      }
      sections.push(section);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'editor-tab-btn';
      btn.dataset.tabTarget = String(index);
      btn.textContent = label;
      nav.appendChild(btn);
    });

    const first = sections[0];
    if(first) first.parentNode.insertBefore(nav, first);

    function activate(index){
      sections.forEach((section, i) => section.classList.toggle('is-active', i === index));
      $all('.editor-tab-btn', nav).forEach((btn, i) => btn.classList.toggle('is-active', i === index));
      form.dataset.activeTab = String(index);
      const shell = form.closest('.editor-shell');
      if(shell) shell.dataset.activeEditorTab = sections[index]?.dataset.tabLabel || '';
    }

    nav.addEventListener('click', e => {
      const btn = e.target.closest('[data-tab-target]');
      if(!btn) return;
      activate(Number(btn.dataset.tabTarget || 0));
    });

    form.addEventListener('focusin', e => {
      const section = e.target.closest('.editor-tab-section');
      if(section) activate(Number(section.dataset.tabIndex || 0));
    });

    activate(0);
  }

  function initEditor(){
    $all('.live-form').forEach(form => {
      initEditorTabs(form); initDraft(form); initCounters(form);
      const shell = form.closest('.editor-shell');
      const iframe = shell && $('[data-live-preview]', shell);
      const refresh = () => { if(iframe && form.dataset.previewUrl) iframe.src = form.dataset.previewUrl + '?t=' + Date.now(); };
      let timer;
      form.addEventListener('input', () => { clearTimeout(timer); timer=setTimeout(()=>applyLivePreview(form, iframe), 120); });
      iframe && iframe.addEventListener('load', () => applyLivePreview(form, iframe));
      $all('[data-refresh-preview]', shell || document).forEach(btn => btn.addEventListener('click', refresh));
      $all('[data-focus-field]', shell || document).forEach(btn => btn.addEventListener('click', () => {
        const name = btn.dataset.focusField;
        const el = form.elements[name];
        if(el){
          const section = el.closest('.editor-tab-section');
          if(section){
            const target = section.dataset.tabIndex || '0';
            const tab = form.querySelector(`.editor-tab-btn[data-tab-target="${target}"]`);
            if(tab) tab.click();
          }
          el.scrollIntoView({behavior:'smooth', block:'center'});
          setTimeout(()=>el.focus(), 260);
          el.closest('.field, .panel, .repeater-box')?.classList.add('pulse');
          setTimeout(()=>el.closest('.field, .panel, .repeater-box')?.classList.remove('pulse'), 1200);
        }
      }));
    });
    initDeviceSwitch(document);
  }

  document.addEventListener('DOMContentLoaded', () => { initEditor(); initRepeaters(document); initPhotoManagers(document); });


  // Session 3: card repeaters for manager-friendly editing.
  const REPEATER_CONFIGS = {
    nav_lines: {
      title: 'Пункты меню', add: 'Добавить пункт меню', empty: 'Пока нет пунктов меню',
      fields: [
        {key:'label', label:'Название', placeholder:'Что внутри'},
        {key:'url', label:'Ссылка', placeholder:'#features'}
      ],
      parse(line){ const [label='', url=''] = splitPipe(line); return {label,url}; },
      serialize(item){ return [item.label, item.url].join(' | '); }
    },
    contact_lines: {
      title: 'Контакты и мессенджеры', add: 'Добавить контакт', empty: 'Добавьте телефон, Telegram, WhatsApp или другую ссылку',
      fields: [
        {key:'type', label:'Тип', type:'select', options:[['phone','Телефон'],['telegram','Telegram'],['whatsapp','WhatsApp'],['max','MAX'],['vk','VK'],['email','Email'],['link','Ссылка']]},
        {key:'label', label:'Название', placeholder:'+7 000 000-00-00'},
        {key:'url', label:'Ссылка', placeholder:'tel:+70000000000'}
      ],
      parse(line){ const [type='link', label='', url=''] = splitPipe(line); return {type,label,url}; },
      serialize(item){ return [item.type||'link', item.label, item.url].join(' | '); }
    },
    faq_lines: {
      title: 'FAQ', add: 'Добавить вопрос', empty: 'Добавьте частые вопросы и ответы',
      fields: [
        {key:'q', label:'Вопрос', placeholder:'Можно ли менять страницу после публикации?'},
        {key:'a', label:'Ответ', type:'textarea', placeholder:'Да, менеджер может редактировать страницу в любой момент.'}
      ],
      parse(line){ const [q='', ...rest] = splitPipe(line); return {q, a:rest.join(' | ')}; },
      serialize(item){ return [item.q, item.a].join(' | '); }
    },
    memories_lines: {
      title: 'Тёплые слова', add: 'Добавить воспоминание', empty: 'Добавьте слова близких',
      fields: [
        {key:'status', label:'Статус', type:'select', options:[['approved','Одобрено'],['new','Новое'],['hidden','Скрыто'],['deleted','Удалено']]},
        {key:'is_featured', label:'Главное', type:'select', options:[['0','Обычное'],['1','Главное на странице']]},
        {key:'author', label:'Автор / родство', placeholder:'От дочери'},
        {key:'text', label:'Текст воспоминания', type:'textarea', placeholder:'Тёплые слова близких...'}
      ],
      parse(line){ const [status='approved', is_featured='0', author='', ...rest] = splitPipe(line); return {status,is_featured,author,text:rest.join(' | ')}; },
      serialize(item){ return [item.status||'approved', item.is_featured||'0', item.author, item.text].join(' | '); }
    },
    qualities_lines: {
      title: 'Каким его помнят', add: 'Добавить качество', empty: 'До 4 качеств, остальные не попадут в публичный блок', max: 4,
      fields: [
        {key:'title', label:'Качество', placeholder:'Надёжный'},
        {key:'description', label:'Описание', type:'textarea', placeholder:'Всегда держал слово и помогал делом.'}
      ],
      parse(line){ const [title='', ...rest] = splitPipe(line); return {title,description:rest.join(' | ')}; },
      serialize(item){ return [item.title, item.description].join(' | '); }
    },
    milestones_lines: {
      title: 'Важные моменты', add: 'Добавить момент', empty: 'До 4 моментов, остальные не попадут в публичный блок', max: 4,
      fields: [
        {key:'year', label:'Год / дата', placeholder:'1988'},
        {key:'text', label:'Событие', type:'textarea', placeholder:'Важный семейный момент'}
      ],
      parse(line){ const [year='', ...rest] = splitPipe(line); return {year,text:rest.join(' | ')}; },
      serialize(item){ return [item.year, item.text].join(' | '); }
    },
    photos_meta: {
      title: 'Подписи к новым фото', add: 'Добавить подпись', empty: 'Одна карточка подписи на каждое новое фото',
      fields: [
        {key:'title', label:'Название', placeholder:'Прогулка в парке'},
        {key:'photo_date', label:'Год / дата', placeholder:'1992'},
        {key:'place', label:'Место', placeholder:'Семейный архив'},
        {key:'caption', label:'Подпись', type:'textarea', placeholder:'Короткое описание фотографии'}
      ],
      parse(line){ const [title='', photo_date='', place='', ...rest] = splitPipe(line); return {title,photo_date,place,caption:rest.join(' | ')}; },
      serialize(item){ return [item.title,item.photo_date,item.place,item.caption].join(' | '); }
    }
  };

  function splitPipe(line){ return String(line || '').split('|').map(s => s.trim()); }
  function linesFromTextarea(textarea){ return String(textarea.value || '').split('\n').map(s=>s.trim()).filter(Boolean); }
  function uid(){ return 'r' + Math.random().toString(36).slice(2,8); }

  function createInput(field, value){
    const wrap = document.createElement('label');
    wrap.className = 'repeater-field';
    const span = document.createElement('span'); span.textContent = field.label;
    wrap.appendChild(span);
    let input;
    if(field.type === 'select'){
      input = document.createElement('select');
      (field.options || []).forEach(([val, label]) => {
        const opt = document.createElement('option'); opt.value = val; opt.textContent = label; if(String(value || '') === String(val)) opt.selected = true; input.appendChild(opt);
      });
    } else if(field.type === 'textarea'){
      input = document.createElement('textarea'); input.rows = 3; input.value = value || '';
    } else {
      input = document.createElement('input'); input.type = field.inputType || 'text'; input.value = value || ''; input.placeholder = field.placeholder || '';
    }
    input.dataset.repeaterKey = field.key;
    if(field.placeholder && input.tagName === 'TEXTAREA') input.placeholder = field.placeholder;
    wrap.appendChild(input);
    return wrap;
  }

  function syncRepeater(textarea, box, config){
    const lines = [];
    $all('.repeater-card', box).forEach(card => {
      const item = {};
      $all('[data-repeater-key]', card).forEach(input => { item[input.dataset.repeaterKey] = input.value.trim(); });
      const line = config.serialize(item).trim();
      if(line.replace(/[|\s]/g,'')) lines.push(line);
    });
    textarea.value = lines.join('\n');
    textarea.dispatchEvent(new Event('input', { bubbles:true }));
    const count = $('.repeater-count', box); if(count) count.textContent = `${lines.length}${config.max ? ' / ' + config.max : ''}`;
    const empty = $('.repeater-empty', box); if(empty) empty.hidden = lines.length > 0;
    const add = $('[data-repeater-add]', box); if(add && config.max) add.disabled = lines.length >= config.max;
  }

  function addRepeaterCard(textarea, box, config, item={}){
    const list = $('.repeater-list', box);
    const card = document.createElement('div'); card.className = 'repeater-card'; card.dataset.cardId = uid();
    const head = document.createElement('div'); head.className = 'repeater-card-head';
    const drag = document.createElement('button'); drag.type = 'button'; drag.className = 'repeater-drag'; drag.textContent = '↕'; drag.title = 'Перетащить';
    const title = document.createElement('strong'); title.textContent = config.title;
    const actions = document.createElement('div'); actions.className = 'repeater-actions';
    const up = document.createElement('button'); up.type = 'button'; up.textContent = '↑'; up.title = 'Выше';
    const down = document.createElement('button'); down.type = 'button'; down.textContent = '↓'; down.title = 'Ниже';
    const del = document.createElement('button'); del.type = 'button'; del.textContent = 'Удалить'; del.className = 'danger';
    actions.append(up,down,del); head.append(drag,title,actions); card.appendChild(head);
    const grid = document.createElement('div'); grid.className = 'repeater-fields';
    config.fields.forEach(field => grid.appendChild(createInput(field, item[field.key])));
    card.appendChild(grid);
    list.appendChild(card);

    card.addEventListener('input', () => syncRepeater(textarea, box, config));
    card.addEventListener('change', () => syncRepeater(textarea, box, config));
    del.addEventListener('click', () => { card.remove(); syncRepeater(textarea, box, config); });
    up.addEventListener('click', () => { const prev = card.previousElementSibling; if(prev) list.insertBefore(card, prev); syncRepeater(textarea, box, config); });
    down.addEventListener('click', () => { const next = card.nextElementSibling; if(next) list.insertBefore(next, card); syncRepeater(textarea, box, config); });
    card.draggable = true;
    card.addEventListener('dragstart', e => { card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    card.addEventListener('dragend', () => { card.classList.remove('dragging'); syncRepeater(textarea, box, config); });
    list.addEventListener('dragover', e => {
      e.preventDefault();
      const after = $all('.repeater-card:not(.dragging)', list).find(el => e.clientY <= el.getBoundingClientRect().top + el.offsetHeight / 2);
      const dragging = $('.repeater-card.dragging', list);
      if(dragging) after ? list.insertBefore(dragging, after) : list.appendChild(dragging);
    });
    syncRepeater(textarea, box, config);
  }

  function initRepeaters(root=document){
    Object.entries(REPEATER_CONFIGS).forEach(([name, config]) => {
      $all(`textarea[name="${name}"]`, root).forEach(textarea => {
        if(textarea.dataset.repeaterReady) return;
        textarea.dataset.repeaterReady = '1';
        const field = textarea.closest('.field');
        if(field) field.classList.add('repeater-source-field');
        const box = document.createElement('section');
        box.className = 'repeater-box';
        box.innerHTML = `<div class="repeater-box-head"><div><b>${config.title}</b><span>${config.empty}</span></div><small class="repeater-count">0</small></div><div class="repeater-list"></div><p class="repeater-empty">${config.empty}</p><button type="button" class="btn muted repeater-add" data-repeater-add>${config.add}</button>`;
        (field || textarea).insertAdjacentElement('afterend', box);
        linesFromTextarea(textarea).forEach(line => addRepeaterCard(textarea, box, config, config.parse(line)));
        $('[data-repeater-add]', box).addEventListener('click', () => addRepeaterCard(textarea, box, config, {}));
        syncRepeater(textarea, box, config);
      });
    });
  }


  // Session 4: manager for already uploaded album photos.
  function initPhotoManagers(root=document){
    $all('[data-photo-manager]', root).forEach(manager => {
      const list = $('.album-photo-list', manager);
      if(!list || manager.dataset.photoManagerReady) return;
      manager.dataset.photoManagerReady = '1';

      function updateSort(){
        $all('[data-photo-card]', list).forEach((card, index) => {
          const input = $('[data-photo-sort]', card);
          if(input) input.value = index * 10;
        });
      }
      function move(card, direction){
        if(direction < 0 && card.previousElementSibling) list.insertBefore(card, card.previousElementSibling);
        if(direction > 0 && card.nextElementSibling) list.insertBefore(card.nextElementSibling, card);
        updateSort();
      }

      $all('[data-photo-card]', list).forEach(card => {
        const del = card.querySelector('input[name^="photo_delete_"]');
        if(del){
          del.addEventListener('change', () => card.classList.toggle('marked-delete', del.checked));
        }
        const up = $('[data-photo-up]', card);
        const down = $('[data-photo-down]', card);
        up && up.addEventListener('click', () => move(card, -1));
        down && down.addEventListener('click', () => move(card, 1));
        card.addEventListener('dragstart', e => { card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
        card.addEventListener('dragend', () => { card.classList.remove('dragging'); updateSort(); });
      });

      list.addEventListener('dragover', e => {
        e.preventDefault();
        const dragging = $('.album-photo-card.dragging', list);
        if(!dragging) return;
        const after = $all('.album-photo-card:not(.dragging)', list).find(el => e.clientY <= el.getBoundingClientRect().top + el.offsetHeight / 2);
        after ? list.insertBefore(dragging, after) : list.appendChild(dragging);
      });
      updateSort();
    });
  }

})();
