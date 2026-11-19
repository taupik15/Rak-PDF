const el = id => document.getElementById(id);
const normalize = value => value.toLowerCase().normalize('NFKD').replace(/\p{M}/gu,'').replace(/\s+/g,' ');
const dialog = el('reader');
let book, task, pdf, drawing, current=1, session=0, paint=0, searching=0;
let textCache = new Map();
let embedUrl = null;
let progressKey = null;

function resetEmbed() {
  el('embedded-reader').hidden=true;
  el('source-frame').removeAttribute('src');
  el('try-embed').hidden=true;
  embedUrl=null;
}
function offerEmbed(url, label='Tampilkan di Rak PDF') {
  if(!url) return;
  embedUrl=url;
  el('try-embed').textContent=label;
  el('try-embed').hidden=false;
}
function showEmbed(url, detail=false) {
  if(!url || !dialog.open) return;
  el('embedded-reader').hidden=false;
  el('source-frame').src=url;
  el('embed-note').textContent=detail
    ? 'Jika halaman tampil, pilih Baca di dalamnya. Situs sumber dapat memblokir penyematan.'
    : 'Pembaca sumber tertanam. Jika kosong atau diblokir, gunakan tautan sumber atau PDF dari HP.';
  el('try-embed').hidden=true;
  status('');
}
el('try-embed').onclick=()=>showEmbed(embedUrl,embedUrl===book?.source&&!book?.reader&&!book?.pdf);
function status(message) {el('reader-status').textContent=message}
function clearDocument() {
  ++session; ++paint; ++searching;
  resetEmbed();
  progressKey=null;
  drawing?.cancel();
  task?.destroy().catch(()=>{});
  drawing=task=pdf=null;
  textCache=new Map();
  el('paper').hidden=el('reader-tools').hidden=el('find-results').hidden=true;
  el('pdf-search').value='';
  el('find-form').querySelector('button').disabled=false;
  el('find-results').replaceChildren();
  el('local-file').value='';
  const canvas=el('pdf-canvas');
  canvas.width=canvas.height=1;
  return session;
}
export function openReader(entry) {
  book=entry;
  clearDocument();
  el('reader-title').textContent=entry.title;
  el('reader-label').textContent=entry.categories.join(' · ');
  el('official').href=entry.source;
  el('official').textContent='Buka halaman resmi ↗';
  if (!dialog.open) dialog.showModal();
  if (entry.pdf) loadDocument({url:entry.pdf}, entry.reader || entry.pdf, entry.source);
  else if (entry.reader) showEmbed(entry.reader);
  else {
    status('Tautan baca buku ini belum ditemukan saat sinkronisasi. Coba tampilkan halaman sumber di dalam Rak PDF, atau buka PDF dari HP.');
    offerEmbed(entry.source, 'Coba baca di dalam Rak PDF');
  }
}
async function loadDocument(source, fallback=null, key=null) {
  const operation=clearDocument();
  progressKey=key;
  status('Membuka PDF…');
  try {
    const engine=await import('./vendor/legacy/build/pdf.min.mjs');
    if(operation!==session) return;
    engine.GlobalWorkerOptions.workerSrc=new URL('./vendor/legacy/build/pdf.worker.min.mjs',import.meta.url).href;
    task=engine.getDocument({...source,
      cMapUrl:new URL('./vendor/cmaps/',import.meta.url).href,cMapPacked:true,
      standardFontDataUrl:new URL('./vendor/standard_fonts/',import.meta.url).href,
      wasmUrl:new URL('./vendor/wasm/',import.meta.url).href,
      isEvalSupported:false,withCredentials:false
    });
    const opened=await task.promise;
    if(operation!==session) return;
    pdf=opened;
    el('reader-tools').hidden=false;
    el('pdf-pages').textContent='/ '+pdf.numPages;
    el('pdf-page').max=pdf.numPages;
    let saved=1;
    if(progressKey) try {saved=Number(localStorage.getItem('rak-pdf-progress:'+progressKey))||1;} catch {}
    await showPage(saved);
  } catch {
    if (operation===session) {
      status('PDF tidak dapat dimuat langsung. Server mungkin membatasi akses lintas situs.');
      if(fallback) offerEmbed(fallback, 'Coba pembaca sumber di Rak PDF');
    }
  }
}
async function showPage(number) {
  const active=pdf;
  if(!active) return;
  current=Math.max(1,Math.min(active.numPages,Math.floor(number)||1));
  const position=++paint;
  el('pdf-page').value=current;
  el('pdf-prev').disabled=current===1;
  el('pdf-next').disabled=current===active.numPages;
  if(drawing) {
    drawing.cancel();
    await drawing.promise.catch(()=>{});
  }
  try {
    const page=await active.getPage(current);
    if(position!==paint) return;
    const natural=page.getViewport({scale:1});
    el('paper').hidden=false;
    const width=Math.min(1250,Math.max(180,el('paper').clientWidth-20));
    const viewport=page.getViewport({scale:width/natural.width});
    const ratio=Math.min(window.devicePixelRatio||1,2);
    const canvas=el('pdf-canvas');
    canvas.width=Math.floor(viewport.width*ratio);
    canvas.height=Math.floor(viewport.height*ratio);
    canvas.style.width=viewport.width+'px';
    canvas.style.height='auto';
    canvas.setAttribute('aria-label','Halaman '+current);
    drawing=page.render({canvas,viewport,transform:ratio===1?null:[ratio,0,0,ratio,0,0]});
    await drawing.promise;
    if(position===paint) {
      status('');
      if(progressKey) try {localStorage.setItem('rak-pdf-progress:'+progressKey,String(current));} catch {}
    }
  } catch(error) {
    if(position===paint && error.name!=='RenderingCancelledException') status('Halaman PDF ini gagal ditampilkan.');
  }
}
el('pdf-prev').onclick=()=>showPage(current-1);
el('pdf-next').onclick=()=>showPage(current+1);
el('pdf-page').onchange=event=>showPage(Number(event.target.value)||1);
el('reader-close').onclick=()=>dialog.close();
dialog.addEventListener('close',clearDocument);
el('open-local').onclick=()=>el('local-file').click();
el('local-file').onchange=async event=>{
  const file=event.target.files[0];
  if(!file || !book) return;
  const operation=session;
  try {
    const data=new Uint8Array(await file.arrayBuffer());
    if(operation!==session) return;
    el('reader-title').textContent=file.name;
    loadDocument({data});
  } catch {
    if(operation===session) status('File PDF dari HP gagal dibaca.');
  }
};

el('find-form').onsubmit=async event=>{
  event.preventDefault();
  const doc=pdf, query=normalize(el('pdf-search').value.trim());
  if(!doc || !query) return;
  const operation=++searching;
  const cache=textCache;
  const results=el('find-results');
  results.hidden=false;
  const progress=document.createElement('p');
  const matches=document.createElement('div');
  results.replaceChildren(progress,matches);
  const submit=el('find-form').querySelector('button');
  submit.disabled=true;
  let count=0, readable=false, skipped=0;
  try {
    for(let i=1;i<=doc.numPages;i++){
      if(operation!==searching) return;
      if(i===1 || i%10===0) progress.textContent='Mencari · halaman '+i+' / '+doc.numPages;
      let content=cache.get(i);
      if(content===undefined){
        try {
          const {items}=await (await doc.getPage(i)).getTextContent();
          content=items.filter(item=>typeof item.str==='string').map(item=>item.str+(item.hasEOL?'\n':' ')).join('');
          cache.set(i,content);
        } catch {skipped++;continue;}
      }
      if(operation!==searching) return;
      readable ||= Boolean(content.trim());
      const at=normalize(content).indexOf(query);
      if(at<0) continue;
      count++;
      const item=document.createElement('button');
      item.type='button';
      item.textContent='Halaman '+i+' · '+normalize(content).slice(Math.max(0,at-35),at+query.length+55);
      item.onclick=async()=>{await showPage(i);el('paper').scrollIntoView({block:'start'})};
      matches.append(item);
    }
    progress.textContent=count?count+' halaman cocok'
      : readable?'Kata itu tidak ditemukan.':'PDF ini tidak memiliki teks yang bisa dicari. PDF hasil scan perlu OCR.';
    if(skipped) progress.textContent+=' · '+skipped+' halaman gagal dibaca';
  } finally {
    if(operation===searching) submit.disabled=false;
  }
};
