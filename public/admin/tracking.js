(function(){
  const cfg = window.PAMYAT_TRACK || {};
  if(!cfg.companyId) return;
  function vid(){
    try{
      let id = localStorage.getItem('pamyatqr_visitor_id');
      if(!id){ id = (crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^a-z0-9-]/gi,''); localStorage.setItem('pamyatqr_visitor_id', id); }
      return id;
    }catch(e){ return ''; }
  }
  function send(event_type, meta){
    const payload = {
      event_type,
      company_id: cfg.companyId,
      landing_id: cfg.landingId || null,
      memorial_id: cfg.memorialId || null,
      visitor_key: vid(),
      path: location.pathname,
      meta: meta || {}
    };
    try{
      const body = JSON.stringify(payload);
      if(navigator.sendBeacon){
        navigator.sendBeacon('/track', new Blob([body], {type:'application/json'}));
      }else{
        fetch('/track', {method:'POST',headers:{'Content-Type':'application/json'},body,keepalive:true});
      }
    }catch(e){}
  }
  const once = new WeakSet();
  document.addEventListener('click', function(e){
    const target = e.target.closest('a,button,[role="button"]');
    if(!target) return;
    const txt = (target.textContent || '').trim().toLowerCase();
    const href = target.getAttribute('href') || '';
    if(target.matches('[data-open-contact]') || txt.includes('связаться') || txt.includes('задать вопрос')) send('landing_contact_click', {label:txt,href});
    else if(txt.includes('спросить') || txt.includes('начать')) send('landing_cta_click', {label:txt,href});
    else if(txt.includes('пример')) send('landing_example_click', {label:txt,href});
    else if(target.matches('.candle-btn') || txt.includes('зажечь свечу')) send('candle_click', {label:txt});
    else if(txt.includes('открыть весь альбом') || target.matches('[data-album-open],.album-open,.album-open-button')) send('album_open', {label:txt});
    else if(txt === '←' || txt.includes('назад')) send('album_prev', {label:txt});
    else if(txt === '→' || txt.includes('вперёд') || txt.includes('далее')) send('album_next', {label:txt});
    else if(txt.includes('отправить слова') || txt.includes('слова семье')) send('memory_submit_click', {label:txt});
    else if(txt.includes('qr') || href.includes('/qr')) send('qr_click', {label:txt,href});
  }, true);
  window.PamyatTrack = send;
})();
