const ebookSunnah = new Set(['ebooksunnah.com', 'www.ebooksunnah.com']);
const maxPages = 25;
const maxCatalogBytes = 8_000_000;

export function publicUrl(value, base) {
  try {
    if (typeof value !== 'string' || !value.trim()) return null;
    const url = new URL(value, base);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}
function text(value) { return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''; }
function labels(values) {
  return [...new Set(values.map(text).filter(Boolean))];
}
function book(item, base) {
  const pdf = publicUrl(item.pdf, base);
  const reader = publicUrl(item.reader, base);
  const source = publicUrl(item.source, base) || pdf || reader;
  if (!source || !text(item.title)) return null;
  return {title: text(item.title), categories: labels(Array.isArray(item.categories) ? item.categories : []),
    pdf: pdf?.href || '', reader: reader?.href || '', source: source.href};
}
function pdfLink(a, base) {
  const href = publicUrl(a.href, base);
  return href && (/\.pdf$/i.test(href.pathname) || a.type?.toLowerCase().split(';')[0] === 'application/pdf') ? href.href : '';
}
function fromHTML(body, base) {
  // Template content stays inert. Only plain text and vetted URLs enter the UI.
  const template = document.createElement('template');
  template.innerHTML = body;
  const doc = template.content;
  for (const node of doc.querySelectorAll('script,style,header,footer,nav,aside,iframe')) {
    if (!node.querySelector('[rel~="next"]')) node.remove();
  }
  const list = [];
  let category = '';
  const headingsAndLinks = doc.querySelectorAll('h2,h3,h4,a[href],link[rel~="next"]');
  for (const node of headingsAndLinks) {
    if (node.matches('h2,h3,h4')) {
      category = text(node.textContent);
      continue;
    }
    const pdf = pdfLink({href:node.getAttribute('href'), type:node.getAttribute('type')},base);
    if (!pdf) continue;
    const enclosingCategory = node.closest('[data-category]')?.getAttribute('data-category');
    const title = text(node.textContent) || node.getAttribute('title') || new URL(pdf).pathname.split('/').pop();
    list.push({title, pdf, categories: [enclosingCategory || category]});
  }
  return {name:text(doc.querySelector('title,h1')?.textContent), books:list,
    next:doc.querySelector('[rel~="next"][href]')?.getAttribute('href')};
}
function fromAtom(body, base) {
  const feed = new DOMParser().parseFromString(body, 'application/xml');
  const root = feed.documentElement;
  if (root.localName !== 'feed') throw Error('Feed XML ini bukan katalog OPDS.');
  const child = (element, name) => [...element.children].filter(node => node.localName === name);
  const books = child(root, 'entry').map(entry => {
    const link = child(entry, 'link').find(node => node.getAttribute('rel')?.includes('/acquisition') &&
      pdfLink({href:node.getAttribute('href'),type:node.getAttribute('type')},base));
    if (!link) return null;
    return {title:child(entry,'title')[0]?.textContent,
      pdf:link.getAttribute('href'),
      categories:child(entry,'category').map(node => node.getAttribute('label') || node.getAttribute('term'))};
  }).filter(Boolean);
  return {name:child(root,'title')[0]?.textContent, books,
    next:child(root,'link').find(node => node.getAttribute('rel')==='next')?.getAttribute('href')};
}
function fromJSON(data, base) {
  if (Array.isArray(data.books)) return data;
  const mapPublication = (record, groupName) => {
    const pdf = record.links?.find(a => pdfLink(a,base) && String(a.rel || '').includes('acquisition'));
    if (!pdf) return null;
    const categories = Array.isArray(record.metadata?.subject) ? record.metadata.subject.map(s => typeof s==='string' ? s : s.name) : [];
    return {title:record.metadata?.title,pdf:pdf.href,categories:[groupName,...categories]};
  };
  if (!data.publications && !data.groups) throw Error('Format JSON katalog ini belum didukung.');
  const books = (data.publications || []).map(p => mapPublication(p,''));
  for (const group of data.groups || []) {
    for (const publication of group.publications || []) books.push(mapPublication(publication,group.metadata?.title));
  }
  return {name:data.metadata?.title,books:books.filter(Boolean),
    next:data.links?.find(link => String(link.rel).split(/[, ]/).includes('next'))?.href};
}
async function fetchCatalog(url, signal) {
  const response = await fetch(url,{signal,credentials:'omit'});
  if (!response.ok) throw Error('Situs mengembalikan HTTP ' + response.status + '.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size=0, body='';
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxCatalogBytes) throw Error('Halaman katalognya terlalu besar untuk dibaca.');
      body += decoder.decode(value,{stream:true});
    }
    body += decoder.decode();
  } catch (error) {
    await reader.cancel().catch(()=>{});
    throw error;
  }
  return {body, type:response.headers.get('content-type') || '', base:response.url || url.href};
}
function merge(target, items, base) {
  for (const item of items) {
    const result = book(item,base);
    if (!result) continue;
    const key = result.source;
    const previous = target.get(key);
    if (previous) {
      previous.categories = labels([...previous.categories,...result.categories]);
      previous.pdf ||= result.pdf; previous.reader ||= result.reader;
    }
    else target.set(key,result);
  }
}
export async function loadCatalog(address, signal, progress) {
  const url = publicUrl(address.includes('://') ? address : 'https://' + address);
  if (!url) throw Error('Masukkan alamat situs HTTPS yang valid.');
  if (ebookSunnah.has(url.hostname)) {
    const response = await fetch('./data/ebooksunnah.json',{signal});
    if (!response.ok) throw Error('Salinan katalog Ebook Sunnah gagal dimuat.');
    const data = await response.json(), books = new Map();
    merge(books,data.books,url);
    return {...data,books:[...books.values()]};
  }
  const books = new Map(), visited = new Set();
  let current = url, name='', page=0;
  while (current && current.origin === url.origin && !visited.has(current.href) && page < maxPages) {
    visited.add(current.href);
    progress(++page);
    let response;
    try {
      response = await fetchCatalog(current,signal);
    } catch (error) {
      if (error instanceof TypeError) throw Error('Situs ini tidak bisa dibaca langsung dari browser. Coba alamat katalog publik yang mengizinkan akses lintas situs (CORS).');
      throw error;
    }
    if (response.type.startsWith('application/pdf')) throw Error('Masukkan alamat halaman katalog agar daftar bukunya tampil.');
    const prefix = response.body.trimStart();
    const data = response.type.includes('json') || prefix.startsWith('{')
      ? fromJSON(JSON.parse(response.body),response.base)
      : (response.type.includes('xml') || /^<\?xml|^<feed\b/i.test(prefix))
        ? fromAtom(response.body,response.base)
        : fromHTML(response.body,response.base);
    name ||= text(data.name);
    merge(books,data.books,response.base);
    current = publicUrl(data.next,response.base);
  }
  if (!books.size) throw Error('Belum ada tautan PDF yang ditemukan. Buka alamat katalog yang menampilkan link PDF atau feed OPDS.');
  return {name:name || url.hostname, books:[...books.values()], limited:page===maxPages && !!current};
}
