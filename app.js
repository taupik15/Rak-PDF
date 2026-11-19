import {loadCatalog} from './catalog.js';
import {openReader} from './reader.js';
const el = id => document.getElementById(id);
const normalize = value => value.toLowerCase().normalize('NFKD').replace(/\p{M}/gu,'');
const pageSize = 24;
let entries = [], page = 1, request;
function render() {
  const choice = el('category').value;
  const words = normalize(el('book-search').value.trim()).split(/\s+/).filter(Boolean);
  const results = entries.filter(b => (!choice || b.categories.includes(choice)) && words.every(w=>b.search.includes(w)));
  const pages = Math.max(1, Math.ceil(results.length/pageSize));
  page = Math.min(pages,Math.max(1,page));
  el('results-count').textContent = results.length ? results.length.toLocaleString('id-ID') + ' buku' : 'Tidak ada buku yang cocok.';
  el('books').replaceChildren(...results.slice((page-1)*pageSize,page*pageSize).map(book=>{
    const button=document.createElement('button');
    button.className='book';
    button.type='button';
    if (book.categories.length) {
      const tag=document.createElement('span');
      tag.className='book-tag';
      tag.textContent=choice || book.categories[0];
      button.append(tag);
    }
    const title=document.createElement('strong');
    title.textContent=book.title;
    const action=document.createElement('small');
    action.textContent=book.pdf || book.reader ? 'Baca' : 'Baca · tautan belum sinkron';
    button.append(title,action);
    button.onclick=()=>openReader(book);
    return button;
  }));
  el('pagination').hidden=pages===1;
  el('page-count').textContent=page+' / '+pages;
  el('prev').disabled=page===1;
  el('next').disabled=page===pages;
}
function announce(message,isError=false) {
  const status=el('import-status');
  status.hidden=!message;
  status.dataset.error=String(isError);
  status.textContent=message;
}
async function importBooks(scroll=true) {
  request?.abort();
  const operation=new AbortController();
  request=operation;
  const submit=el('import-form').querySelector('[type=submit]');
  submit.disabled=true;
  announce('Memuat katalog…');
  try {
    const data=await loadCatalog(el('source').value.trim(),operation.signal,
      step=>announce('Membaca halaman katalog '+step+'…'));
    if (operation.signal.aborted) return;
    entries=data.books.map(b=>({...b,search:normalize([b.title,...b.categories].join(' '))}));
    el('library-title').textContent=data.name;
    const ready=data.books.filter(b=>b.pdf||b.reader).length;
    el('library-meta').textContent=data.snapshot ? 'Katalog publik · '+(data.last_catalog_check||data.snapshot)+' · '+ready.toLocaleString('id-ID')+' / '+data.books.length.toLocaleString('id-ID')+' tautan baca tersedia'
      : data.limited ? 'Menampilkan 25 halaman pertama katalog.' : 'Katalog publik';
    const options=[...new Set(entries.flatMap(b=>b.categories))].sort((a,b)=>a.localeCompare(b,'id'));
    el('category').replaceChildren(new Option('Semua kategori',''),...options.map(c=>new Option(c,c)));
    el('book-search').value='';
    el('library').hidden=false;
    announce('');
    page=1;
    render();
    try {localStorage.setItem('rak-pdf-source',el('source').value.trim());} catch {}
    if (scroll) el('library').scrollIntoView({block:'start'});
  } catch(error) {
    if (!operation.signal.aborted) announce(error.message || 'Katalog gagal dimuat.',true);
  } finally {
    if (request===operation) submit.disabled=false;
  }
}
el('import-form').onsubmit=event=>{event.preventDefault();importBooks()};
el('example').onclick=()=>{el('source').value='https://ebooksunnah.com/';importBooks()};
el('book-search').oninput=el('category').onchange=()=>{page=1;render()};
for(const [name,change] of [['prev',-1],['next',1]]) el(name).onclick=()=>{
  page+=change;render();el('library').scrollIntoView({block:'start'});
};

try {
  const last = localStorage.getItem('rak-pdf-source');
  if (last) {
    el('source').value=last;
    importBooks(false);
  }
} catch {}
