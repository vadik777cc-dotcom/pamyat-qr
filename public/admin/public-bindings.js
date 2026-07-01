(function(){
  function $(sel, root=document){ return root.querySelector(sel); }
  function $all(sel, root=document){ return Array.from(root.querySelectorAll(sel)); }

  function formatDateRu(value){
    const v = String(value || '').trim();
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(m) return `${m[3]}.${m[2]}.${m[1]}`;
    return v;
  }

  function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function text(sel,value){ $all(sel).forEach(el=>{ if(value !== undefined && value !== null && String(value).trim() !== '') el.textContent=value; }); }
  function hrefFor(c){
    const type = String(c && c.type || 'link').toLowerCase();
    const label = String(c && c.label || '').trim();
    const url = String(c && c.url || '').trim();
    if(url) return url;
    if(type === 'phone') return 'tel:' + label.replace(/[^+\d]/g,'');
    if(type === 'email') return 'mailto:' + label;
    return '#';
  }
  function isExternal(url){ return /^https?:\/\//i.test(String(url||'')); }

  const landingData = window.PAMYAT_PUBLIC_LANDING_DATA;
  if(landingData && landingData.landing){
    const l = landingData.landing;
    const company = landingData.company || {};
    text('.preloader-title', l.preloaderTitle || company.name);
    text('.brand-title,.brand b,.brand__title', company.name || l.preloaderTitle);
    $all('.brand-title').forEach(el=>{ el.setAttribute('data-brand-short', company.name || l.preloaderTitle || ''); });
    if(company.logo){ $all('.brand-logo,img.logo').forEach(img=>{ img.src = company.logo; }); }
    text('.hero h1', l.heroTitle);
    text('.hero-lead', l.heroSubtitle);
    $all('[data-open-contact], .hero-actions .btn.primary').forEach(el=>{ if(l.primaryLabel) el.textContent = l.primaryLabel; });
    const secondary = $('.hero-actions .btn.secondary');
    if(secondary){ if(l.secondaryLabel) secondary.textContent = l.secondaryLabel; if(l.secondaryUrl) secondary.href = l.secondaryUrl; }
    if(l.heroImage){
      $all('.hero-photo-card img').forEach(img=>{ img.src = l.heroImage; });
      $all('.hero').forEach(hero=>{
        hero.style.backgroundImage = `linear-gradient(90deg, rgba(247,242,234,.98) 0%, rgba(247,242,234,.92) 28%, rgba(247,242,234,.56) 48%, rgba(247,242,234,.10) 67%, rgba(247,242,234,0) 100%), url("${l.heroImage}")`;
      });
    }
    function initLandingNav(){
      const nav = $('.nav.island');
      if(!nav) return;
      const links = $all('a[href^="#"]', nav);
      const pairs = links.map(a => ({ a, id: decodeURIComponent((a.getAttribute('href')||'').slice(1)) }))
        .map(x => ({...x, section: x.id ? document.getElementById(x.id) : null}))
        .filter(x => x.section);
      if(!pairs.length) return;
      let manualUntil = 0;
      function setActive(link){ links.forEach(a=>a.classList.remove('active')); if(link) link.classList.add('active'); }
      function update(){
        if(Date.now() < manualUntil) return;
        const marker = window.scrollY + Math.min(180, window.innerHeight * 0.28);
        let current = pairs[0];
        for(const pair of pairs){
          const top = pair.section.getBoundingClientRect().top + window.scrollY;
          if(top <= marker) current = pair;
        }
        if(window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80) current = pairs[pairs.length - 1];
        setActive(current && current.a);
      }
      pairs.forEach(pair=>{
        pair.a.addEventListener('click', e=>{
          e.preventDefault();
          manualUntil = Date.now() + 700;
          setActive(pair.a);
          const header = $('.topbar');
          const offset = (header ? header.getBoundingClientRect().height : 0) + (window.innerWidth <= 720 ? 16 : 30);
          const y = pair.section.getBoundingClientRect().top + window.scrollY - offset;
          window.scrollTo({top:Math.max(0, y), behavior:'smooth'});
          setTimeout(()=>{ manualUntil = 0; update(); }, 760);
        });
      });
      window.addEventListener('scroll', update, {passive:true});
      window.addEventListener('resize', update);
      update();
    }
    if(Array.isArray(l.nav)){
      const nav = $('.nav.island');
      if(nav){
        nav.innerHTML = l.nav.filter(x=>x && x.visible !== false).map((n,i)=>`<a class="${i===0?'active':''}" href="${escapeHtml(n.url || '#')}">${escapeHtml(n.label || '')}</a>`).join('');
      }
    }
    initLandingNav();
    const contacts = Array.isArray(l.contacts) ? l.contacts.filter(x=>x && x.visible !== false) : [];
    const linksHtml = contacts.map(c=>`<a href="${escapeHtml(hrefFor(c))}" ${isExternal(hrefFor(c))?'target="_blank" rel="noopener"':''}>${escapeHtml(c.label || c.type || 'Контакт')}</a>`).join('');
    const notice = $('.notice');
    if(notice) notice.innerHTML = contacts.length ? 'Написать удобным способом: ' + linksHtml : 'Контакты пока не добавлены';
    const btns = $('.contact-buttons');
    if(btns) btns.innerHTML = linksHtml;
    const grid = $('.contact-choice-grid');
    if(grid) grid.innerHTML = linksHtml || '<span>Контакты пока не добавлены</span>';
    if(Array.isArray(l.faq)){
      const faq = $('.faq');
      const items = l.faq.filter(x=>x && x.visible !== false && x.q);
      if(faq && items.length){
        const head = faq.querySelector('div')?.outerHTML || '<div style="padding:42px 42px 22px"><h2>Вопросы, которые часто задают семьи</h2></div>';
        faq.innerHTML = head + items.map((f,i)=>`<div class="faq-item ${i===0?'open':''}"><button class="faq-q"><span>${escapeHtml(f.q)}</span><span>+</span></button><div class="faq-a"><p>${escapeHtml(f.a || '')}</p></div></div>`).join('');
      }
    }
  }

  const data = window.PAMYAT_ADMIN_DATA;
  if(!data) return;
  text('.story-title,.person__name,.memory-person-name', data.fullName);
  text('.quote__main,.hero-quote,.memory-quote', data.quote);
  text('.quote__sub,.epitaph,.memory-epitaph', data.epitaph);
  text('.person__dates', [formatDateRu(data.birthDate), formatDateRu(data.deathDate)].filter(Boolean).join(' — '));
  if(data.mainPhoto){
    $all('.hero-photo img, img[src*="hero-portrait-bg"]').forEach(img=>{ img.src=data.mainPhoto; });
  }
  if(data.biography){
    const paras=String(data.biography).split(/\n+/).map(s=>s.trim()).filter(Boolean);
    const nodes=$all('.story-text p, .biography p, .life-story p, .life-body p');
    nodes.forEach((n,i)=>{ if(paras[i]) n.textContent=paras[i]; });
  }
  if(Array.isArray(data.memories) && data.memories.length){
    const cards = $all('.note-main, .note-side, .memory-note-card').filter((card, index, arr) => !arr.some(other => other !== card && other.contains(card)));
    data.memories.slice(0, cards.length).forEach((m,i)=>{
      const card = cards[i];
      const quote = card.querySelector('.note-text') || card.querySelector('p:not(.note-quote)');
      if(quote) quote.textContent = m.text || m.memory || '';
      const author = card.querySelector('.note-author span') || card.querySelector('.note-author') || card.querySelector('.note-sign') || card.querySelector('small');
      if(author && (m.author || m.relation)) author.textContent = m.author || m.relation;
    });
  }
  if(Array.isArray(data.qualities) && data.qualities.length){
    const rows = $all('.trait-row');
    data.qualities.slice(0, rows.length).forEach((q,i)=>{
      const row=rows[i]; const b=row.querySelector('strong'); const s=row.querySelector('span:last-child');
      if(b) b.textContent=q.title||''; if(s) s.textContent=q.description||'';
    });
  }
  if(Array.isArray(data.milestones) && data.milestones.length){
    const rows = $all('.moment');
    data.milestones.slice(0, rows.length).forEach((m,i)=>{
      const row=rows[i]; const b=row.querySelector('strong'); const s=row.querySelector('span');
      if(b) b.textContent=m.year||''; if(s) s.textContent=m.text||'';
    });
  }
  if(data.company){
    text('.brand__title,.footer-brand__title,.final-brand-title', data.company.name);
    if(data.company.logo){ $all('.brand-logo,img.logo').forEach(img=>img.src=data.company.logo); }
  }

  if(Array.isArray(data.photos) && data.photos.length){
    const photos = data.photos.map(p => ({
      src: p.src || p.large || p.large_path || p.preview || p.preview_path || '',
      thumb: p.thumb || p.thumb_path || p.preview || p.preview_path || p.src || '',
      caption: [p.title, p.date || p.photo_date].filter(Boolean).join('. ') || p.caption || 'Семейное фото',
      alt: p.alt || p.title || p.caption || 'Семейное фото'
    })).filter(p => p.src);
    if(photos.length){
      window.albumPhotos = photos;
      const first = photos[0];
      const setSrc = (id, src) => { const el = document.getElementById(id); if(el) el.src = src; };
      setSrc('albumSlideImage', first.src); setSrc('albumSlideBg', first.src);
      setSrc('albumFullscreenImage', first.src); setSrc('albumFullscreenBg', first.src);
      const cap = document.getElementById('albumSlideCaption'); if(cap) cap.textContent = first.caption;
      const counter = document.getElementById('albumCounter'); if(counter) counter.textContent = `1 / ${photos.length}`;
      const fsCounter = document.getElementById('albumFullscreenCounter'); if(fsCounter) fsCounter.textContent = `1 / ${photos.length}`;
      const thumbs = document.getElementById('albumThumbs');
      if(thumbs) thumbs.innerHTML = photos.map((p,i)=>`<button class="album-thumb ${i===0?'is-active':''}" type="button" data-index="${i}"><img src="${escapeHtml(p.thumb || p.src)}" alt="${escapeHtml(p.alt)}"></button>`).join('');
    }
  }

  if(data.footer){ text('.footer-title,.final-footer__text,.memory-final-text', data.footer); }
})();
