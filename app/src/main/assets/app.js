'use strict';
/* Kitap Okuyucu — EPUB okuma, sayfalama, sayfa çevirme ve işaretleme */

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const GAP = 60;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('Kayıt alanı dolu'); } }
};

let meta = store.get('books', {});      // id -> {title, author, cover, pos, pct}
let marks = store.get('marks', []);     // {id, book, bookTitle, ch, chTitle, start, end, text, color, ts}
let bms = store.get('bms', []);         // yer imleri {id, book, bookTitle, ch, chTitle, off, text, ts}
let prefs = Object.assign({ font: 20, line: 1.65, theme: 'paper', flip: 'on', margin: 'dar', tr: 'tr' }, store.get('prefs', {}));

const native = window.Android || null;
const bridge = {
  list() { try { return JSON.parse(native ? native.listBooks() : JSON.stringify(window.__mockBooks || [])); } catch (e) { return []; } },
  pick() { if (native) native.pickBook(); else toast('Dosya seçici yalnızca tablette çalışır'); },
  remove(id) { if (native) native.deleteBook(id); else window.__mockBooks = (window.__mockBooks || []).filter(b => b.id !== id); },
  share(text) { if (native) native.share(text); else console.log(text); },
  url(id) { return native ? 'https://appassets.androidplatform.net/books/' + encodeURIComponent(id) : 'books/' + id; }
};

/* ---------------- EPUB ---------------- */

const dirOf = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
function resolvePath(base, rel) {
  rel = (rel || '').split('#')[0];
  try { rel = decodeURIComponent(rel); } catch (e) {}
  const parts = (rel.startsWith('/') ? rel : base + rel).split('/');
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.' && p !== '') out.push(p); }
  return out.join('/');
}
const els = (doc, name) => Array.from(doc.getElementsByTagNameNS('*', name));
const parseXml = s => new DOMParser().parseFromString(s, 'application/xml');
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };

class Epub {
  static async open(buf) {
    const b = new Epub();
    b.zip = await JSZip.loadAsync(buf);
    b.lower = {};
    Object.keys(b.zip.files).forEach(k => { b.lower[k.toLowerCase()] = k; });
    const cont = b.file('META-INF/container.xml');
    if (!cont) throw new Error('Geçerli bir EPUB değil');
    const rootfile = els(parseXml(await cont.async('string')), 'rootfile')[0];
    const opfPath = rootfile.getAttribute('full-path');
    const opf = parseXml(await b.file(opfPath).async('string'));
    const base = dirOf(opfPath);

    const items = {};
    els(opf, 'item').forEach(it => {
      items[it.getAttribute('id')] = {
        href: resolvePath(base, it.getAttribute('href')),
        type: it.getAttribute('media-type') || '',
        props: it.getAttribute('properties') || ''
      };
    });
    b.spine = els(opf, 'itemref').map(r => items[r.getAttribute('idref')])
      .filter(x => x && b.file(x.href)).map(x => x.href);
    if (!b.spine.length) throw new Error('Kitapta okunacak bölüm bulunamadı');

    const txt = n => { const e = els(opf, n)[0]; return e ? e.textContent.trim() : ''; };
    b.title = txt('title');
    b.author = txt('creator');
    b.lang = txt('language') || 'tr';

    const all = Object.values(items);
    const coverMeta = els(opf, 'meta').find(m => m.getAttribute('name') === 'cover');
    let cover = coverMeta && items[coverMeta.getAttribute('content')];
    if (!cover) cover = all.find(i => /cover-image/.test(i.props));
    if (!cover) cover = all.find(i => /^image\//.test(i.type) && /cover|kapak/i.test(i.href));
    b.coverPath = cover && /^image\//.test(cover.type) ? cover.href : null;

    b.toc = [];
    try {
      const nav = all.find(i => /\bnav\b/.test(i.props));
      const ncx = all.find(i => i.type === 'application/x-dtbncx+xml');
      if (nav && b.file(nav.href)) {
        const d = parseXml(await b.file(nav.href).async('string'));
        const navs = els(d, 'nav');
        const el = navs.find(n => /toc/.test(n.getAttribute('epub:type') || '')) || navs[0];
        if (el) els(el, 'a').forEach(a => {
          const href = a.getAttribute('href') || '';
          let depth = 0; for (let p = a.parentNode; p && p !== el; p = p.parentNode) if (p.localName === 'ol') depth++;
          b.toc.push({ label: a.textContent.trim().replace(/\s+/g, ' '), path: resolvePath(dirOf(nav.href), href), frag: href.split('#')[1] || '', depth: Math.max(0, depth - 1) });
        });
      }
      if (!b.toc.length && ncx && b.file(ncx.href)) {
        const d = parseXml(await b.file(ncx.href).async('string'));
        els(d, 'navPoint').forEach(np => {
          const lab = els(np, 'text')[0], c = els(np, 'content')[0];
          if (!lab || !c) return;
          const src = c.getAttribute('src') || '';
          let depth = 0; for (let p = np.parentNode; p; p = p.parentNode) if (p.localName === 'navPoint') depth++;
          b.toc.push({ label: lab.textContent.trim().replace(/\s+/g, ' '), path: resolvePath(dirOf(ncx.href), src), frag: src.split('#')[1] || '', depth });
        });
      }
    } catch (e) {}
    b.toc.forEach(t => { t.ch = b.spine.indexOf(t.path); });
    b.toc = b.toc.filter(t => t.ch >= 0 && t.label);

    b.cache = new Map();
    b.urls = new Map();
    return b;
  }

  file(path) { return this.zip.file(path) || (this.lower[path.toLowerCase()] ? this.zip.file(this.lower[path.toLowerCase()]) : null); }

  async blobUrl(path) {
    if (this.urls.has(path)) return this.urls.get(path);
    const f = this.file(path);
    let url = '';
    if (f) {
      const ext = path.split('.').pop().toLowerCase();
      url = URL.createObjectURL(new Blob([await f.async('arraybuffer')], { type: MIME[ext] || 'application/octet-stream' }));
    }
    this.urls.set(path, url);
    return url;
  }

  chapterTitle(ch) {
    let best = '';
    for (const t of this.toc) if (t.ch <= ch) best = t.label; else break;
    return best || ('Bölüm ' + (ch + 1));
  }

  async fragment(i) {
    if (this.cache.has(i)) return this.cache.get(i);
    const path = this.spine[i], f = this.file(path), base = dirOf(path);
    const str = f ? await f.async('string') : '';
    let doc = new DOMParser().parseFromString(str, 'application/xhtml+xml');
    if (doc.getElementsByTagName('parsererror').length || !doc.querySelector('body'))
      doc = new DOMParser().parseFromString(str, 'text/html');
    const body = doc.querySelector('body');
    const frag = document.createDocumentFragment();
    if (body) {
      body.querySelectorAll('script,style,link,iframe,object,embed,audio,video,form,input,button,textarea,select,meta,title').forEach(n => n.remove());
      for (const svg of Array.from(body.querySelectorAll('svg'))) {
        const im = svg.querySelector('image');
        if (!im) continue;
        const href = im.getAttribute('xlink:href') || im.getAttribute('href') || '';
        const img = doc.createElementNS('http://www.w3.org/1999/xhtml', 'img');
        img.setAttribute('src', href);
        svg.parentNode.replaceChild(img, svg);
      }
      for (const el of Array.from(body.querySelectorAll('*'))) {
        for (const a of Array.from(el.attributes)) {
          const n = a.name.toLowerCase();
          if (n.startsWith('on') || n === 'style' || n === 'width' || n === 'height' || n === 'srcset') el.removeAttribute(a.name);
        }
        const tag = el.localName;
        if (tag === 'img') {
          const src = el.getAttribute('src') || '';
          el.setAttribute('src', /^data:/.test(src) ? src : await this.blobUrl(resolvePath(base, src)));
        } else if (tag === 'a') {
          const href = el.getAttribute('href');
          if (href != null) {
            el.removeAttribute('href');
            if (!/^[a-z]+:/i.test(href)) el.setAttribute('data-href', resolvePath(base, href.startsWith('#') ? path.split('/').pop() + href : href) + '#' + (href.split('#')[1] || ''));
          }
        }
      }
      if (body.textContent.trim().length < 40) body.querySelectorAll('img').forEach(im => im.setAttribute('class', 'full'));
      for (const n of Array.from(body.childNodes)) frag.appendChild(document.importNode(n, true));
    }
    this.cache.set(i, frag);
    if (this.cache.size > 14) this.cache.delete(this.cache.keys().next().value);
    return frag;
  }

  async text(i) { return (await this.fragment(i)).textContent; }

  async coverThumb() {
    if (!this.coverPath || !this.file(this.coverPath)) return '';
    try {
      const url = await this.blobUrl(this.coverPath);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const w = 240, h = Math.round(w * img.naturalHeight / img.naturalWidth) || 360;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      return c.toDataURL('image/jpeg', 0.72);
    } catch (e) { return ''; }
  }

  dispose() { this.urls.forEach(u => u && URL.revokeObjectURL(u)); }
}


/* ---------------- PDF ---------------- */

/** PDF sayfasındaki yazı parçalarının metni (arama ve işaret konumları bununla sayılır) */
const pdfStr = it => it.str + (it.hasEOL ? ' ' : '');

class PdfBook {
  static async open(url) {
    const b = new PdfBook();
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';
    b.doc = await pdfjsLib.getDocument({ url, standardFontDataUrl: 'standard_fonts/' }).promise;
    b.isPdf = true;
    b.spine = Array.from({ length: b.doc.numPages }, (_, i) => 'sayfa' + i);
    b.title = ''; b.author = ''; b.lang = ''; b.toc = [];
    try {
      const md = await b.doc.getMetadata();
      b.title = ((md.info && md.info.Title) || '').trim();
      b.author = ((md.info && md.info.Author) || '').trim();
    } catch (e) {}
    try {
      const walk = async (items, depth) => {
        for (const it of items || []) {
          if (b.toc.length > 400) return;
          try {
            let dest = it.dest;
            if (typeof dest === 'string') dest = await b.doc.getDestination(dest);
            if (Array.isArray(dest)) {
              const ch = typeof dest[0] === 'object' ? await b.doc.getPageIndex(dest[0]) : dest[0];
              if (it.title && ch >= 0) b.toc.push({ label: it.title.trim(), ch, depth, frag: '' });
            }
          } catch (e) {}
          await walk(it.items, depth + 1);
        }
      };
      await walk(await b.doc.getOutline(), 0);
    } catch (e) {}
    b.cache = new Map(); b.texts = new Map();
    return b;
  }

  chapterTitle(ch) {
    let best = '';
    for (const t of this.toc) if (t.ch <= ch) best = t.label;
    return best || ('Sayfa ' + (ch + 1));
  }

  async text(i) {
    if (this.texts.has(i)) return this.texts.get(i);
    const tc = await (await this.doc.getPage(i + 1)).getTextContent();
    const t = tc.items.filter(it => it.str != null).map(pdfStr).join('');
    this.texts.set(i, t);
    if (this.texts.size > 600) this.texts.delete(this.texts.keys().next().value);
    return t;
  }

  /** Sayfayı ekrana sığacak boyutta resme çevirir, üstüne seçilebilir görünmez yazı katmanı koyar. */
  async fragment(i) {
    if (this.cache.has(i)) { const hit = this.cache.get(i); this.cache.delete(i); this.cache.set(i, hit); return hit.frag; }
    const page = await this.doc.getPage(i + 1);
    const boxW = sheetA.clip.clientWidth, boxH = sheetA.clip.clientHeight - 2;
    const v1 = page.getViewport({ scale: 1 });
    const s = Math.min(boxW / v1.width, boxH / v1.height);
    let rs = s * Math.min(window.devicePixelRatio || 1, 2);
    rs = Math.min(rs, Math.sqrt(6e6 / (v1.width * v1.height)));          // en çok ~6 megapiksel
    const vp = page.getViewport({ scale: rs });
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.92));
    const url = URL.createObjectURL(blob);
    cv.width = cv.height = 0;

    const cssVp = page.getViewport({ scale: s });
    const wrap = document.createElement('div'); wrap.className = 'pdfwrap';
    const pg = document.createElement('div'); pg.className = 'pdfpage';
    pg.style.width = Math.floor(cssVp.width) + 'px'; pg.style.height = Math.floor(cssVp.height) + 'px';
    const img = document.createElement('img'); img.src = url; img.alt = '';
    const layer = document.createElement('div'); layer.className = 'pdftext';
    try {
      const tc = await page.getTextContent();
      const m = document.createElement('canvas').getContext('2d');
      for (const it of tc.items) {
        if (it.str == null) continue;
        const tx = pdfjsLib.Util.transform(cssVp.transform, it.transform);
        const fh = Math.hypot(tx[2], tx[3]) || 10;
        const sp = document.createElement('span');
        sp.textContent = pdfStr(it);
        sp.style.left = tx[4].toFixed(1) + 'px';
        sp.style.top = (tx[5] - fh * 0.82).toFixed(1) + 'px';
        sp.style.fontSize = fh.toFixed(1) + 'px';
        m.font = fh.toFixed(1) + 'px sans-serif';
        const w = m.measureText(it.str).width, target = it.width * s;
        if (w > 0 && target > 0) sp.style.transform = 'scaleX(' + (target / w).toFixed(4) + ')';
        layer.append(sp);
      }
    } catch (e) {}
    pg.append(img, layer); wrap.append(pg);
    const frag = document.createDocumentFragment(); frag.append(wrap);
    this.cache.set(i, { frag, url });
    if (this.cache.size > 8) { const k = this.cache.keys().next().value; URL.revokeObjectURL(this.cache.get(k).url); this.cache.delete(k); }
    return frag;
  }

  clearPages() { this.cache.forEach(v => URL.revokeObjectURL(v.url)); this.cache.clear(); }

  async coverThumb() {
    try {
      const page = await this.doc.getPage(1), v1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 240 / v1.width });
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: g, viewport: vp }).promise;
      return c.toDataURL('image/jpeg', 0.72);
    } catch (e) { return ''; }
  }

  dispose() { this.clearPages(); try { this.doc.destroy(); } catch (e) {} }
}

/* ---------------- Sayfa katmanı ---------------- */

function imagesReady(root) {
  return Promise.all(Array.from(root.querySelectorAll('img')).map(img => img.complete ? null :
    new Promise(r => { img.onload = img.onerror = r; setTimeout(r, 1500); })));
}

class Sheet {
  constructor(el) {
    this.el = el; this.clip = el.querySelector('.clip'); this.flow = el.querySelector('.flow');
    this.footCh = el.querySelector('.foot-ch'); this.footPg = el.querySelector('.foot-pg');
    this.ch = -1; this.page = 0; this.pages = 1; this.q = Promise.resolve();
    this.clip.addEventListener('scroll', () => { this.clip.scrollLeft = 0; this.clip.scrollTop = 0; });
  }
  get step() { return this.clip.clientWidth + GAP; }
  load(ch) {
    this.q = this.q.then(() => this._load(ch)).catch(e => console.error(e));
    return this.q;
  }
  async _load(ch) {
    if (this.ch === ch || !R.book) return;
    const frag = await R.book.fragment(ch);
    this.flow.replaceChildren(frag.cloneNode(true));
    this.flow.lang = R.book.lang;
    this.ch = ch;
    paintMarks(this);
    await imagesReady(this.flow);
    // küçük resimler (süs, baş harf) satır içinde kalsın
    this.flow.querySelectorAll('img:not(.full)').forEach(im => { if (im.naturalWidth && im.naturalWidth < 70 && im.naturalHeight < 70) im.classList.add('inl'); });
    this.layout();
  }
  layout() {
    this.flow.style.columnWidth = this.clip.clientWidth + 'px';
    this.flow.style.setProperty('--page-h', (this.clip.clientHeight - 2) + 'px');
    this.pages = Math.max(1, Math.round((this.flow.scrollWidth + GAP) / this.step));
    if (this.page > this.pages - 1) this.page = this.pages - 1;
    this.show(this.page);
  }
  show(p) {
    this.page = clamp(p, 0, this.pages - 1);
    this.flow.style.transform = 'translateX(' + (-this.page * this.step) + 'px)';
    this.foot();
  }
  foot() {
    if (!R.book || this.ch < 0) return;
    this.footCh.textContent = R.book.chapterTitle(this.ch);
    this.footPg.textContent = P.done ? (P.starts[this.ch] + this.page + 1) + ' / ' + P.total : (this.page + 1) + ' / ' + this.pages;
  }
  pageOfRect(rect) {
    const x = rect.left - this.flow.getBoundingClientRect().left;
    return clamp(Math.floor((x + 2) / this.step), 0, this.pages - 1);
  }
  /** off konumundaki (ya da hemen sonrasındaki) görünür karakterin kutusu */
  rectAt(off) {
    const nodes = textNodes(this.flow), r = document.createRange();
    let pos = 0, tries = 0;
    for (const n of nodes) {
      const e = pos + n.data.length;
      if (off < e) {
        let i = Math.max(0, off - pos);
        while (i < n.data.length && /\s/.test(n.data[i])) i++;
        if (i < n.data.length) {
          r.setStart(n, i); r.setEnd(n, i + 1);
          const rect = r.getClientRects()[0];
          if (rect) return rect;
        }
        if (++tries > 8) break;
      }
      pos = e;
    }
    return null;
  }
  pageOfOffset(off) { const rect = this.rectAt(off); return rect ? this.pageOfRect(rect) : this.pages - 1; }
  /** bu sayfadaki ilk karakterin bölüm içindeki sırası */
  firstOffset() {
    if (this.page === 0) return 0;
    let lo = 0, hi = this.flow.textContent.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.pageOfOffset(mid) < this.page) lo = mid + 1; else hi = mid; }
    return lo;
  }
  pageOfAnchor(id) {
    let el = null;
    try { el = this.flow.querySelector('#' + CSS.escape(id)) || this.flow.querySelector('[name="' + CSS.escape(id) + '"]'); } catch (e) {}
    return el ? this.pageOfRect(el.getBoundingClientRect()) : 0;
  }
}

const P = { sig: '', counts: [], starts: [], total: 0, done: false, job: 0 };   // kitap geneli sayfa numaraları
const sheetA = new Sheet($('#sheetA')), sheetB = new Sheet($('#sheetB')), sheetM = new Sheet($('#sheetM'));
const R = { id: null, book: null, cur: sheetA, other: sheetB, busy: false };

function setTop(s) {
  const o = s === sheetA ? sheetB : sheetA;
  s.el.className = 'sheet top';
  o.el.className = 'sheet under rest';
}

/* ---------------- Sayfa numaraları ---------------- */

const layoutSig = () => [R.id, innerWidth, innerHeight, prefs.font, prefs.line, prefs.margin].join('|');
function setCounts(counts) {
  P.counts = counts; P.starts = []; let t = 0;
  for (const c of counts) { P.starts.push(t); t += c; }
  P.total = t; P.done = true;
}
async function countPages() {
  if (!R.book) return;
  const sig = layoutSig();
  if (P.sig === sig) return;
  P.sig = sig; P.done = false; const job = ++P.job, book = R.book, n = book.spine.length;
  if (book.isPdf) { setCounts(new Array(n).fill(1)); return refreshPages(); }
  const m = meta[R.id] || {};
  if (m.pc && m.pc.sig === sig && m.pc.counts.length === n) { setCounts(m.pc.counts); return refreshPages(); }
  refreshPages();
  const counts = [];
  sheetM.ch = -1; sheetM.page = 0;
  for (let i = 0; i < n; i++) {
    await new Promise(r => setTimeout(r, 25));
    if (job !== P.job || R.book !== book) return;
    await sheetM.load(i);
    if (job !== P.job || R.book !== book) return;
    counts.push(sheetM.pages);
    $('#gotoInfo').textContent = 'Sayfalar sayılıyor… %' + Math.round((i + 1) / n * 100);
  }
  sheetM.flow.replaceChildren(); sheetM.ch = -1;
  setCounts(counts);
  if (meta[R.id]) { meta[R.id].pc = { sig, counts }; store.set('books', meta); }
  refreshPages();
}
function refreshPages() {
  sheetA.foot(); sheetB.foot();
  const s = R.cur, sl = $('#slider');
  sl.disabled = !P.done;
  if (P.done && s.ch >= 0) {
    const pg = P.starts[s.ch] + s.page + 1;
    sl.max = P.total; sl.value = pg;
    $('#progText').textContent = 'Sayfa ' + pg + ' / ' + P.total;
    $('#gotoInfo').textContent = 'Şu an ' + pg + '. sayfadasın. Kitap ' + P.total + ' sayfa.';
    $('#gotoInput').max = P.total;
  } else if (R.book && s.ch >= 0) {
    $('#progText').textContent = R.book.chapterTitle(s.ch);
  }
}
function goToPage(n) {
  if (!P.done) return toast('Sayfalar hâlâ sayılıyor, birkaç saniye sonra dene');
  n = clamp(Math.round(n) || 1, 1, P.total);
  let ch = 0;
  while (ch < P.counts.length - 1 && P.starts[ch + 1] <= n - 1) ch++;
  return goTo({ ch, page: n - 1 - P.starts[ch] });
}

/* ---------------- Kıvrılan sayfa efekti ---------------- */

const curl = $('#curl'), cx = curl.getContext('2d');
let paper = '#f8f1e3';
function sizeCurl() {
  const d = Math.min(window.devicePixelRatio || 1, 2);
  curl.width = Math.round(innerWidth * d); curl.height = Math.round(innerHeight * d);
  cx.setTransform(d, 0, 0, d, 0, 0);
}
function cutPoly(poly, M, n, sign) {      // yarım düzlemle kes: sign*((p-M)·n) <= 0 olan taraf kalır
  const out = [], f = p => ((p[0] - M[0]) * n[0] + (p[1] - M[1]) * n[1]) * sign;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], fa = f(a), fb = f(b);
    if (fa <= 0) out.push(a);
    if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0)) { const t = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return out;
}
/** Sayfanın köşesi (W,cy) T noktasına çekilmiş gibi katlar: üstteki sayfayı kırpar, kıvrımı ve gölgeleri çizer. */
function drawCurl(topEl, T, cy) {
  const W = innerWidth, H = innerHeight, C = [W, cy];
  // kâğıt sırttan kopmasın: köşe, sırtın iki ucuna sayfa boyundan uzak olamaz
  let dx = T[0], dy = T[1] - cy, d = Math.hypot(dx, dy);
  if (d > W) T = [dx * W / d, cy + dy * W / d];
  const diag = Math.hypot(W, H), oy = H - cy;
  dx = T[0]; dy = T[1] - oy; d = Math.hypot(dx, dy);
  if (d > diag) T = [dx * diag / d, oy + dy * diag / d];

  cx.clearRect(0, 0, W, H);
  const vx = C[0] - T[0], vy = C[1] - T[1], L = Math.hypot(vx, vy);
  if (L < 1) { topEl.style.clipPath = ''; return; }
  const n = [vx / L, vy / L], M = [(C[0] + T[0]) / 2, (C[1] + T[1]) / 2];
  const page = [[0, 0], [W, 0], [W, H], [0, H]];
  const kept = cutPoly(page, M, n, 1), gone = cutPoly(page, M, n, -1);
  topEl.style.clipPath = kept.length > 2 ? 'polygon(' + kept.map(p => p[0].toFixed(1) + 'px ' + p[1].toFixed(1) + 'px').join(',') + ')' : 'polygon(0 0,0 0,0 0)';
  if (gone.length < 3) return;
  const flap = gone.map(p => { const k = (p[0] - M[0]) * n[0] + (p[1] - M[1]) * n[1]; return [p[0] - 2 * k * n[0], p[1] - 2 * k * n[1]]; });
  const path = poly => { cx.beginPath(); poly.forEach((p, i) => i ? cx.lineTo(p[0], p[1]) : cx.moveTo(p[0], p[1])); cx.closePath(); };
  const grad = (len, dir, stops) => {
    const g = cx.createLinearGradient(M[0], M[1], M[0] + n[0] * len * dir, M[1] + n[1] * len * dir);
    stops.forEach(s => g.addColorStop(s[0], s[1])); return g;
  };
  const depth = L / 2;
  // alttaki sayfaya düşen gölge
  cx.save(); path(gone); cx.clip();
  cx.fillStyle = grad(Math.max(40, depth * 0.55), 1, [[0, 'rgba(0,0,0,.42)'], [0.35, 'rgba(0,0,0,.16)'], [1, 'rgba(0,0,0,0)']]);
  cx.fillRect(0, 0, W, H); cx.restore();
  // kıvrılan kâğıdın arkası + okunan sayfaya düşen gölgesi
  cx.save();
  cx.shadowColor = 'rgba(0,0,0,.5)'; cx.shadowBlur = clamp(depth * 0.3, 14, 70);
  cx.shadowOffsetX = -n[0] * 8; cx.shadowOffsetY = -n[1] * 8;
  path(flap); cx.fillStyle = paper; cx.fill(); cx.restore();
  // kâğıdın bombesi: kat yerinde koyu, hemen yanında parlak, uçta yine hafif koyu
  cx.save(); path(flap); cx.clip();
  cx.fillStyle = grad(Math.max(24, depth), -1, [[0, 'rgba(0,0,0,.30)'], [0.07, 'rgba(0,0,0,.10)'], [0.2, 'rgba(255,255,255,.30)'], [0.55, 'rgba(255,255,255,.05)'], [1, 'rgba(0,0,0,.16)']]);
  cx.fillRect(0, 0, W, H); cx.restore();
  // kat çizgisi
  cx.save(); path(flap); cx.clip();
  cx.strokeStyle = 'rgba(0,0,0,.18)'; cx.lineWidth = 1;
  cx.beginPath(); cx.moveTo(M[0] - n[1] * diag, M[1] + n[0] * diag); cx.lineTo(M[0] + n[1] * diag, M[1] - n[0] * diag); cx.stroke();
  cx.restore();
}
function clearCurl() {
  cx.clearRect(0, 0, innerWidth, innerHeight);
  sheetA.el.style.clipPath = ''; sheetB.el.style.clipPath = '';
}

/** Çevirmeyi hazırlar: hedef sayfayı alttaki/üstteki katmana yükler. */
async function beginTurn(dir) {
  if (R.busy || !R.book) return null;
  const cur = R.cur, oth = R.other;
  let ch = cur.ch, pg = cur.page + dir, toLast = false;
  if (pg < 0) { if (ch === 0) { toast('Kitabın başındasın'); return null; } ch--; toLast = true; }
  else if (pg >= cur.pages) { if (ch >= R.book.spine.length - 1) { toast('Kitabın sonu'); return null; } ch++; pg = 0; }
  R.busy = true;
  hideFloating();
  try {
    await oth.load(ch);
    oth.show(toLast ? oth.pages - 1 : pg);
  } catch (e) { R.busy = false; return null; }
  const top = dir > 0 ? cur : oth, under = dir > 0 ? oth : cur;
  if (dir < 0 && prefs.flip !== 'off') drawCurl(top.el, [-innerWidth, innerHeight], innerHeight);
  under.el.className = 'sheet under'; top.el.className = 'sheet top';
  return { dir, cur, oth, top };
}
function endTurn(f, commit) {
  clearCurl();
  if (commit) { setTop(f.oth); R.cur = f.oth; R.other = f.cur; }
  else setTop(f.cur);
  R.busy = false;
  if (commit) afterMove();
}
function animateCurl(f, cy, from, to, ms, arc) {
  return new Promise(res => {
    const t0 = performance.now();
    const step = now => {
      const t = Math.min(1, (now - t0) / ms), e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      drawCurl(f.top.el, [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e + (cy ? -1 : 1) * Math.sin(Math.PI * e) * arc], cy);
      if (t < 1) requestAnimationFrame(step); else res();
    };
    requestAnimationFrame(step);
  });
}
async function turn(dir) {
  const f = await beginTurn(dir);
  if (!f) return;
  if (prefs.flip !== 'off') {
    const W = innerWidth, H = innerHeight;
    await animateCurl(f, H, dir > 0 ? [W, H] : [-W, H], dir > 0 ? [-W, H] : [W, H], 620, H * 0.2);
  }
  endTurn(f, true);
}

async function goTo(pos) {
  if (!R.book) return;
  R.busy = true;
  try {
    const s = R.cur;
    await s.load(clamp(pos.ch || 0, 0, R.book.spine.length - 1));
    let p = 0;
    if (pos.page != null) p = pos.page;
    else if (pos.off != null) p = s.pageOfOffset(pos.off);
    else if (pos.anchor) p = s.pageOfAnchor(pos.anchor);
    else if (pos.frac) p = Math.min(s.pages - 1, Math.floor(pos.frac * s.pages + 1e-4));
    s.show(p); setTop(s); clearCurl();
  } finally { R.busy = false; }
  afterMove();
}

function afterMove() {
  const s = R.cur, n = R.book.spine.length;
  const pct = P.done ? (P.starts[s.ch] + s.page + 1) / P.total : clamp((s.ch + (s.page + 1) / s.pages) / n, 0, 1);
  const m = meta[R.id] || (meta[R.id] = {});
  m.pos = { ch: s.ch, off: s.firstOffset(), frac: s.page / s.pages }; m.pct = pct;
  store.set('books', meta);
  refreshPages();
  const here = pageBookmark();
  $('#ribbon').hidden = !here;
  $('#btnBm').textContent = here ? 'Yer imini kaldır' : 'Yer imi';
  // bir sonraki sayfayı arkada hazırla
  R.other.load(s.page < s.pages - 1 ? s.ch : Math.min(s.ch + 1, n - 1));
  countPages();
}

/* ---------------- İşaretler ve notlar ---------------- */

function textNodes(root) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), a = [];
  let n; while ((n = w.nextNode())) a.push(n);
  return a;
}
function rangeFromOffsets(root, start, end) {
  const r = document.createRange();
  let pos = 0, s = false;
  for (const n of textNodes(root)) {
    const e = pos + n.data.length;
    if (!s && start < e) { r.setStart(n, start - pos); s = true; }
    if (s && end <= e) { r.setEnd(n, Math.max(0, end - pos)); return r; }
    pos = e;
  }
  if (s) { r.setEndAfter(root.lastChild); return r; }
  return null;
}
function paintMarks(sheet) {
  sheet.flow.querySelectorAll('mark.hl').forEach(m => m.replaceWith(...m.childNodes));
  sheet.flow.normalize();
  for (const m of marks) {
    if (m.book !== R.id || m.ch !== sheet.ch) continue;
    let pos = 0;
    for (const n of textNodes(sheet.flow)) {
      const len = n.data.length, s = pos, e = pos + len; pos = e;
      if (e <= m.start) continue;
      if (s >= m.end) break;
      const a = Math.max(m.start, s) - s, b = Math.min(m.end, e) - s;
      let node = n;
      if (b < len) node.splitText(b);
      if (a > 0) node = node.splitText(a);
      if (!node.data.trim()) continue;
      const mk = document.createElement('mark');
      mk.className = 'hl ' + m.color + (m.note ? ' noted' : ''); mk.dataset.id = m.id;
      node.replaceWith(mk); mk.appendChild(node);
    }
  }
}
function repaint() { [sheetA, sheetB].forEach(s => { if (s.ch >= 0) paintMarks(s); }); }

let lastSel = null;
function selRange() {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed || !R.book) return null;
  const r = sel.getRangeAt(0);
  return R.cur.flow.contains(r.commonAncestorContainer) ? r : null;
}
function selOffsets(r) {
  const pre = document.createRange();
  pre.selectNodeContents(R.cur.flow);
  pre.setEnd(r.startContainer, r.startOffset);
  const start = pre.toString().length;
  return { start, end: start + r.toString().length };
}
document.addEventListener('selectionchange', () => {
  const r = selRange();
  if (r) {
    const o = selOffsets(r);
    lastSel = { ch: R.cur.ch, start: o.start, end: o.end, t: Date.now() };
    showBars(false);
    $('#selbar').hidden = false;
  } else if (lastSel) {
    lastSel.t = Date.now();
    setTimeout(() => { if (!selRange()) $('#selbar').hidden = true; }, 400);
  }
});
function activeSel() {
  const r = selRange();
  let s = null;
  if (r) { const o = selOffsets(r); s = { ch: R.cur.ch, start: o.start, end: o.end }; }
  else if (lastSel && Date.now() - lastSel.t < 2500 && lastSel.ch === R.cur.ch) s = { ch: lastSel.ch, start: lastSel.start, end: lastSel.end };
  if (!s) return null;
  const T = R.cur.flow.textContent;
  while (s.start < s.end && /\s/.test(T[s.start])) s.start++;
  while (s.end > s.start && /\s/.test(T[s.end - 1])) s.end--;
  if (s.end <= s.start) return null;
  s.text = T.slice(s.start, s.end).replace(/\s+/g, ' ').trim();
  return s;
}
function clearSel() { getSelection().removeAllRanges(); lastSel = null; $('#selbar').hidden = true; }

function createMark(s, color, note) {
  let a = s.start, b = s.end; const notes = [];
  // üst üste gelen eski işaretleri birleştir (notları korunur)
  marks = marks.filter(m => {
    if (m.book !== R.id || m.ch !== s.ch || m.end <= a || m.start >= b) return true;
    a = Math.min(a, m.start); b = Math.max(b, m.end); if (m.note) notes.push(m.note); return false;
  });
  if (note) notes.push(note);
  const T = R.cur.ch === s.ch ? R.cur.flow.textContent : null;
  const mk = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    book: R.id, bookTitle: (meta[R.id] && meta[R.id].title) || R.book.title || 'Kitap',
    ch: s.ch, chTitle: R.book.chapterTitle(s.ch),
    start: a, end: b, text: T ? T.slice(a, b).replace(/\s+/g, ' ').trim() : s.text, color, note: notes.join('\n'), ts: Date.now()
  };
  marks.push(mk);
  store.set('marks', marks);
  clearSel(); repaint();
  return mk;
}
function addMark(color) {
  const s = activeSel();
  if (!s) return null;
  const mk = createMark(s, color);
  toast('İşaretlendi');
  return mk;
}
function removeMark(id) {
  marks = marks.filter(m => m.id !== id);
  store.set('marks', marks);
  repaint();
}

function expandToSentence() {
  const s = activeSel();
  if (!s) return;
  const flow = R.cur.flow, T = flow.textContent;
  const sr = rangeFromOffsets(flow, s.start, s.end);
  if (!sr) return;
  const block = n => {
    let e = n.nodeType === 1 ? n : n.parentElement;
    while (e && e !== flow && getComputedStyle(e).display.startsWith('inline')) e = e.parentElement;
    return e || flow;
  };
  const span = el => {
    if (el === flow) return [0, T.length];
    const pre = document.createRange(); pre.selectNodeContents(flow); pre.setEndBefore(el);
    const st = pre.toString().length; return [st, st + el.textContent.length];
  };
  const lo = R.book.isPdf ? 0 : span(block(sr.startContainer))[0], hi = R.book.isPdf ? T.length : span(block(sr.endContainer))[1];
  const END = /[.!?…]/, TAIL = /[.!?…"”’'»)\]]/;
  let a = s.start, b = s.end;
  while (a > lo && !(END.test(T[a - 1]) && /\s/.test(T[a] || ' '))) a--;
  while (a < s.start && /\s/.test(T[a])) a++;
  if (!(b > a && END.test(T[b - 1]))) while (b < hi && !END.test(T[b])) b++;
  while (b < hi && TAIL.test(T[b])) b++;
  const r = rangeFromOffsets(flow, a, b);
  if (!r) return;
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  lastSel = { ch: R.cur.ch, start: a, end: b, t: Date.now() };
  $('#selbar').hidden = false;
}

/* ---------------- Çeviri ---------------- */

async function translateText(text) {
  let to = prefs.tr, from = 'autodetect';
  const lang = ((R.book && R.book.lang) || '').slice(0, 2).toLowerCase();
  if (/^[a-z]{2}$/.test(lang)) { from = lang; if (lang === to) to = to === 'tr' ? 'en' : 'tr'; }
  // servis tek seferde ~500 karakter alıyor: cümle cümle böl
  const parts = []; let buf = '';
  for (const piece of text.match(/[^.!?…]+[.!?…]*\s*/g) || [text]) {
    if ((buf + piece).length > 440 && buf) { parts.push(buf); buf = ''; }
    buf += piece;
    while (buf.length > 440) { parts.push(buf.slice(0, 440)); buf = buf.slice(440); }
  }
  if (buf.trim()) parts.push(buf);
  const out = [], dec = document.createElement('textarea');
  for (const q of parts) {
    const res = await fetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q.trim()) + '&langpair=' + from + '|' + to);
    const j = await res.json();
    const t = j && j.responseData && j.responseData.translatedText;
    if (!t || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(t)) throw new Error(/MYMEMORY WARNING/i.test(t || '') ? 'Bugünlük ücretsiz çeviri hakkı doldu, yarın tekrar dene' : 'Çeviri alınamadı');
    if (String(j.responseStatus) !== '200') throw new Error('Çeviri alınamadı');
    dec.innerHTML = t; out.push(dec.value);
  }
  return out.join(' ');
}

/* ---------------- İşaret kartı (not + çeviri) ---------------- */

let pop = null;   // {id} işaretli yer  |  {sel} henüz işaretlenmemiş seçim
function renderPop() {
  const m = pop.id ? marks.find(x => x.id === pop.id) : null;
  if (pop.id && !m) return closePop();
  $('#popText').textContent = m ? m.text : pop.sel.text;
  const nb = $('#popNote'); nb.hidden = !(m && m.note); nb.textContent = m ? m.note || '' : '';
  const tb = $('#popTr'); tb.hidden = pop.tr == null; tb.textContent = pop.tr || '';
  $('#btnPopNote').hidden = !m; $('#btnPopNote').textContent = m && m.note ? 'Notu düzenle' : 'Not ekle';
  $('#btnPopDel').hidden = !m;
  $('#btnPopTr').hidden = pop.tr != null;
  $('#btnPopTrSave').hidden = !pop.trOk;
  $('#btnPopTrSave').textContent = m ? 'Çeviriyi nota ekle' : 'İşaretle ve çeviriyi nota ekle';
  $('#markPop').hidden = false;
}
function openPop(p) { pop = p; $('#noteDlg').hidden = true; renderPop(); }
function closePop() { pop = null; $('#markPop').hidden = true; }
async function popTranslate() {
  if (!pop) return;
  const mine = pop, m = pop.id ? marks.find(x => x.id === pop.id) : null;
  pop.tr = 'Çevriliyor…'; pop.trOk = false; renderPop();
  try { mine.tr = await translateText(m ? m.text : pop.sel.text); mine.trOk = true; }
  catch (e) { mine.tr = (e && /hakkı|alınamadı/.test(e.message)) ? e.message : 'Çeviri için internet bağlantısı gerekiyor'; }
  if (pop === mine) renderPop();
}
$('#btnPopTr').onclick = popTranslate;
$('#btnPopTrSave').onclick = () => {
  if (!pop || !pop.trOk) return;
  let m = pop.id ? marks.find(x => x.id === pop.id) : null;
  if (m) { m.note = (m.note ? m.note + '\n' : '') + pop.tr; store.set('marks', marks); repaint(); }
  else { m = createMark(pop.sel, 'yellow', pop.tr); pop = { id: m.id, tr: pop.tr }; }
  pop.trOk = false;
  renderPop(); toast('Çeviri nota eklendi');
};
$('#btnPopNote').onclick = () => { if (pop && pop.id) openNote(pop.id); };
$('#btnPopDel').onclick = () => { if (pop && pop.id) removeMark(pop.id); closePop(); toast('İşaret kaldırıldı'); };
$('#btnPopClose').onclick = closePop;

let noteId = null;
function openNote(id) {
  const m = marks.find(x => x.id === id);
  if (!m) return;
  noteId = id; closePop(); closePanels();
  $('#noteQuote').textContent = m.text;
  $('#noteText').value = m.note || '';
  $('#noteDlg').hidden = false;
  setTimeout(() => $('#noteText').focus(), 50);
}
$('#btnNoteCancel').onclick = () => { $('#noteDlg').hidden = true; $('#noteText').blur(); };
$('#btnNoteSave').onclick = () => {
  const m = marks.find(x => x.id === noteId);
  if (m) { m.note = $('#noteText').value.trim(); store.set('marks', marks); repaint(); toast(m.note ? 'Not kaydedildi' : 'Not silindi'); }
  $('#noteDlg').hidden = true; $('#noteText').blur();
  if (m && !$('#reader').hidden) openPop({ id: m.id });
};

const press = (el, fn) => el.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); fn(e); });
$$('#selbar .dot').forEach(d => press(d, () => addMark(d.dataset.color)));
press($('#btnSentence'), expandToSentence);
press($('#btnSelTr'), () => { const s = activeSel(); if (!s) return; clearSel(); openPop({ sel: s }); popTranslate(); });
press($('#btnSelNote'), () => { const s = activeSel(); if (!s) return; const m = createMark(s, 'yellow'); openNote(m.id); });

/* ---------------- Yer imleri ---------------- */

function pageBookmark() {
  const s = R.cur;
  return bms.find(b => b.book === R.id && b.ch === s.ch && s.pageOfOffset(b.off) === s.page) || null;
}
function toggleBookmark() {
  const s = R.cur, here = pageBookmark();
  if (here) { bms = bms.filter(b => b !== here); toast('Yer imi kaldırıldı'); }
  else {
    const off = s.firstOffset();
    bms.push({
      id: Date.now().toString(36), book: R.id, bookTitle: meta[R.id].title, ch: s.ch, chTitle: R.book.chapterTitle(s.ch),
      off, text: s.flow.textContent.slice(off, off + 90).replace(/\s+/g, ' ').trim(), ts: Date.now()
    });
    toast('Bu sayfaya yer imi kondu');
  }
  store.set('bms', bms);
  showBars(false); afterMove();
}

/* ---------------- Dokunma ---------------- */

let down = null, drag = null;
const stage = $('#stage');
stage.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  down = { x: e.clientX, y: e.clientY, t: Date.now(), sel: !!selRange(), target: e.target };
  drag = null;
});
stage.addEventListener('pointermove', e => {
  if (!down) return;
  const dx = e.clientX - down.x, dy = e.clientY - down.y, W = innerWidth;
  if (!drag) {
    if (prefs.flip === 'off' || down.sel || selRange() || Math.abs(dx) < 14 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    const d = drag = { dir: dx < 0 ? 1 : -1, cy: down.y < innerHeight / 2 ? 0 : innerHeight, f: null, T: null, dead: false, released: false, commit: false };
    stage.classList.add('dragging');
    beginTurn(d.dir).then(f => {
      if (!f) { d.dead = true; return; }
      d.f = f;
      if (d.released) finishDrag(d); else if (d.T) drawCurl(f.top.el, d.T, d.cy);
    });
  }
  if (drag.dead) return;
  // köşe parmağı takip eder (2.2 kat hızla: ekranın yarısı kadar sürüklemek sayfayı çevirir)
  drag.T = [clamp((drag.dir > 0 ? W : -W) + dx * 2.2, -W, W), drag.cy + dy * 0.6];
  if (drag.f) drawCurl(drag.f.top.el, drag.T, drag.cy);
});
function finishDrag(d) {
  const W = innerWidth, fwdEnd = d.commit === (d.dir > 0);          // köşe sola mı gidecek?
  const from = d.T || [(d.dir > 0 ? W : -W), d.cy], to = [fwdEnd ? -W : W, d.cy];
  const ms = 160 + 420 * Math.abs(to[0] - from[0]) / (2 * W);
  animateCurl(d.f, d.cy, from, to, ms, 0).then(() => endTurn(d.f, d.commit));
}
function releaseDrag(e, cancelled) {
  const d = drag, W = innerWidth; drag = null;
  stage.classList.remove('dragging');
  const dx = e.clientX - down.x, dt = Date.now() - down.t; down = null;
  if (d.dead) return;
  const prog = d.T ? (d.dir > 0 ? (W - d.T[0]) : (d.T[0] + W)) / (2 * W) : 0;
  d.commit = !cancelled && (prog > 0.28 || (dt < 350 && Math.abs(dx) > 40 && (dx < 0) === (d.dir > 0)));
  d.released = true;
  if (d.f) finishDrag(d);
}
stage.addEventListener('pointerup', e => {
  if (!down) return;
  if (drag) return releaseDrag(e, false);
  const d = down; down = null;
  const dx = e.clientX - d.x, dy = e.clientY - d.y, dt = Date.now() - d.t;
  if (d.sel || selRange()) return;
  if (Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy) && dt < 800) return void turn(dx < 0 ? 1 : -1);
  if (Math.abs(dx) > 12 || Math.abs(dy) > 12 || dt > 350) return;
  // dokunuş
  if (!$('#noteDlg').hidden) return;
  if (!$('#markPop').hidden) return closePop();
  if (!$('#topbar').hidden) return showBars(false);
  const mk = d.target.closest && d.target.closest('mark.hl');
  if (mk) return openPop({ id: mk.dataset.id });
  const link = d.target.closest && d.target.closest('a[data-href]');
  if (link) {
    const [p, frag] = link.dataset.href.split('#');
    const ch = R.book.spine.indexOf(p);
    if (ch >= 0) return void goTo({ ch, anchor: frag });
  }
  const x = e.clientX / innerWidth;
  if (x < 0.28) turn(-1); else if (x > 0.72) turn(1); else showBars(true);
});
stage.addEventListener('pointercancel', e => { if (down && drag) releaseDrag(e, true); else down = null; });
document.addEventListener('keydown', e => {
  if ($('#reader').hidden || /INPUT|TEXTAREA/.test(e.target.tagName) || !$('#scrim').hidden) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') turn(1);
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') turn(-1);
});

function showBars(on) { $('#topbar').hidden = !on; $('#bottombar').hidden = !on; }
function hideFloating() { showBars(false); closePop(); }

$('#slider').oninput = e => { $('#progText').textContent = 'Sayfa ' + e.target.value + ' / ' + P.total; };
$('#slider').onchange = e => { goToPage(+e.target.value); };

/* ---------------- Kitaplık ---------------- */

function renderLibrary() {
  const books = bridge.list();
  const grid = $('#bookGrid');
  grid.replaceChildren();
  $('#libEmpty').hidden = books.length > 0;
  $('#libCount').textContent = books.length ? books.length + ' kitap · ' + marks.length + ' işaret' : '';
  for (const b of books) {
    const m = meta[b.id] || {};
    const title = m.title || b.name.replace(/\.(epub|pdf)$/i, '');
    const card = document.createElement('div'); card.className = 'book';
    const cover = document.createElement('div'); cover.className = 'cover';
    if (m.cover) cover.style.backgroundImage = 'url(' + m.cover + ')'; else cover.textContent = title;
    const h = document.createElement('h3'); h.textContent = title;
    const p = document.createElement('p');
    p.textContent = (m.author ? m.author + ' · ' : '') + (m.pct ? '%' + Math.round(m.pct * 100) : 'Yeni');
    const del = document.createElement('button'); del.className = 'del'; del.textContent = '×'; del.setAttribute('aria-label', 'Kitabı sil');
    del.onclick = e => {
      e.stopPropagation();
      if (del.dataset.arm) { bridge.remove(b.id); delete meta[b.id]; store.set('books', meta); renderLibrary(); toast('Kitap silindi (işaretlerin duruyor)'); }
      else { del.dataset.arm = '1'; del.style.background = '#b3392b'; toast('Silmek için × işaretine tekrar dokun'); setTimeout(() => { delete del.dataset.arm; del.style.background = ''; }, 3000); }
    };
    card.append(cover, h, p, del);
    card.onclick = () => openBook(b.id);
    grid.append(card);
  }
}

async function openBook(id, jump) {
  closePanels();
  $('#library').hidden = true; $('#reader').hidden = false; $('#loading').hidden = false;
  showBars(false);
  try {
    if (R.id !== id || !R.book) {
      if (R.book) R.book.dispose();
      R.book = null; P.sig = ''; P.done = false; P.job++;
      [sheetA, sheetB, sheetM].forEach(s => { s.ch = -1; s.page = 0; });
      let book;
      if (/\.pdf$/i.test(id)) book = await PdfBook.open(bridge.url(id));
      else {
        const res = await fetch(bridge.url(id));
        if (!res.ok) throw new Error('Dosya okunamadı');
        book = await Epub.open(await res.arrayBuffer());
      }
      R.book = book; R.id = id;
      const m = meta[id] || (meta[id] = {});
      m.title = book.title || m.title || (bridge.list().find(b => b.id === id) || { name: id }).name.replace(/\.(epub|pdf)$/i, '');
      m.author = book.author || '';
      if (!m.cover) m.cover = await book.coverThumb();
      store.set('books', meta);
    }
    $('#barTitle').textContent = meta[id].title;
    applyPrefs();
    await goTo(jump || meta[id].pos || { ch: 0 });
    if (jump && jump.flash) flashMark(jump.flash);
  } catch (e) {
    console.error(e);
    toast('Kitap açılamadı: ' + (e.message || e));
    closeReader();
  }
  $('#loading').hidden = true;
}
function closeReader() {
  clearSel(); closePop(); $('#noteDlg').hidden = true;
  $('#reader').hidden = true; $('#library').hidden = false;
  renderLibrary();
}
function flashMark(id) {
  R.cur.flow.querySelectorAll('mark.hl[data-id="' + id + '"]').forEach(m => {
    m.classList.add('flash'); setTimeout(() => m.classList.remove('flash'), 2600);
  });
}

window.onBookImported = id => { renderLibrary(); openBook(id); };
window.onImportError = msg => toast(msg || 'Dosya eklenemedi');
window.handleBack = () => {
  if (!$('#scrim').hidden) { closePanels(); return true; }
  if (!$('#reader').hidden) {
    if (!$('#noteDlg').hidden) { $('#noteDlg').hidden = true; return true; }
    if (!$('#markPop').hidden) { closePop(); return true; }
    if (selRange()) { clearSel(); return true; }
    if (!$('#topbar').hidden) { showBars(false); return true; }
    closeReader(); return true;
  }
  return false;
};

/* ---------------- Paneller ---------------- */

function openPanel(id) { closePanels(); closePop(); $('#scrim').hidden = false; $(id).hidden = false; showBars(false); }
function closePanels() { $('#scrim').hidden = true; $$('.panel').forEach(p => { p.hidden = true; }); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }
$('#scrim').onclick = closePanels;
$$('.panel .close').forEach(b => { b.onclick = closePanels; });

function renderToc() {
  const list = $('#tocList'); list.replaceChildren();
  const toc = R.book.toc.length ? R.book.toc : R.book.spine.map((p, i) => ({ label: R.book.chapterTitle(i), ch: i, depth: 0, frag: '' }));
  let curIdx = -1;
  toc.forEach((t, i) => { if (t.ch <= R.cur.ch) curIdx = i; });
  toc.forEach((t, i) => {
    const b = document.createElement('button');
    b.className = 'toc-item' + (i === curIdx ? ' cur' : '');
    b.style.paddingLeft = (t.depth * 18) + 'px';
    b.textContent = t.label + (P.done && !/^Sayfa \d+$/.test(t.label) ? '  ·  s. ' + (P.starts[t.ch] + 1) : '');
    b.onclick = () => { closePanels(); goTo({ ch: t.ch, anchor: t.frag }); };
    list.append(b);
  });
}

const byPlace = (a, b) => a.bookTitle.localeCompare(b.bookTitle, 'tr') || a.ch - b.ch || (a.start || a.off || 0) - (b.start || b.off || 0);
const marksFor = bookId => marks.filter(m => !bookId || m.book === bookId).sort(byPlace);
const fmtDate = ts => new Date(ts).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });
function jumpTo(m, pos, flash) {
  const inReader = !$('#reader').hidden && R.id === m.book;
  closePanels();
  if (inReader) goTo(pos).then(() => flash && flashMark(flash));
  else openBook(m.book, Object.assign({ flash }, pos));
}
function renderMarks() {
  const inReader = !$('#reader').hidden;
  const list = marksFor(inReader ? R.id : null);
  const bl = bms.filter(b => !inReader || b.book === R.id).sort(byPlace);
  const box = $('#marksList'); box.replaceChildren();
  $('#marksTitle').textContent = 'İşaretlerim' + (list.length ? ' (' + list.length + ')' : '');
  $('#btnShare').hidden = !list.length;
  const have = new Set(bridge.list().map(b => b.id));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  if (bl.length) {
    box.append(el('div', 'mark-sec', 'Yer imleri'));
    for (const b of bl) {
      const it = el('div', 'bm-item'), sp = el('span');
      sp.append(el('small', '', (inReader ? '' : b.bookTitle + ' · ') + b.chTitle + ' · ' + fmtDate(b.ts)), document.createTextNode(b.text + '…'));
      it.append(sp);
      if (have.has(b.book)) { const go = el('button', '', 'Aç'); go.onclick = () => jumpTo(b, { ch: b.ch, off: b.off }); it.append(go); }
      const del = el('button', '', 'Sil'); del.onclick = () => { bms = bms.filter(x => x !== b); store.set('bms', bms); renderMarks(); if (inReader) afterMove(); };
      it.append(del); box.append(it);
    }
    box.append(el('div', 'mark-sec', 'İşaretlenen cümleler'));
  }
  if (!list.length) {
    box.append(el('div', 'panel-empty', 'Henüz işaretlediğin bir cümle yok. Okurken bir kelimeye basılı tut, seçimi genişlet ve bir renge dokun.'));
    return;
  }
  let lastBook = null;
  for (const m of list) {
    if (!inReader && m.book !== lastBook) { box.append(el('div', 'mark-book', m.bookTitle)); lastBook = m.book; }
    const it = el('div', 'mark-item');
    it.append(el('blockquote', m.color, m.text));
    if (m.note) it.append(el('div', 'mark-note', m.note));
    const mt = el('div', 'mark-meta'), acts = el('span');
    mt.append(el('span', '', m.chTitle + ' · ' + fmtDate(m.ts)));
    if (have.has(m.book)) { const go = el('button', '', 'Sayfaya git'); go.onclick = () => jumpTo(m, { ch: m.ch, off: m.start }, m.id); acts.append(go); }
    const nt = el('button', '', m.note ? 'Notu düzenle' : 'Not ekle'); nt.onclick = () => openNote(m.id); acts.append(nt);
    const del = el('button', '', 'Sil'); del.onclick = () => { removeMark(m.id); renderMarks(); }; acts.append(del);
    mt.append(acts); it.append(mt); box.append(it);
  }
}
$('#btnShare').onclick = () => {
  const inReader = !$('#reader').hidden;
  let out = '', last = null;
  for (const m of marksFor(inReader ? R.id : null)) {
    if (m.book !== last) { out += (out ? '\n' : '') + '📖 ' + m.bookTitle + '\n\n'; last = m.book; }
    out += '“' + m.text + '”\n— ' + m.chTitle + (m.note ? '\nNot: ' + m.note : '') + '\n\n';
  }
  bridge.share(out.trim());
};

/* kitapta arama */
let searchJob = 0;
async function doSearch() {
  const raw = $('#searchInput').value.trim(), list = $('#searchList'), info = $('#searchInfo');
  list.replaceChildren();
  if (raw.length < 2) { info.textContent = 'En az 2 harf yaz.'; return; }
  $('#searchInput').blur();
  const job = ++searchJob, book = R.book, loc = /^tr/i.test(book.lang) ? 'tr' : undefined;
  const low = s => loc ? s.toLocaleLowerCase(loc) : s.toLowerCase();
  const q = low(raw);
  let count = 0;
  for (let ch = 0; ch < book.spine.length && count < 200; ch++) {
    info.textContent = 'Aranıyor… %' + Math.round(ch / book.spine.length * 100);
    const T = await book.text(ch), L = low(T);
    if (job !== searchJob || R.book !== book) return;
    if (L.length !== T.length) continue;
    for (let i = L.indexOf(q); i >= 0 && count < 200; i = L.indexOf(q, i + q.length)) {
      count++;
      const a = Math.max(0, i - 45), b = Math.min(T.length, i + q.length + 60);
      const hit = document.createElement('button'); hit.className = 'hit';
      const sm = document.createElement('small'); sm.textContent = book.chapterTitle(ch);
      const mid = document.createElement('b'); mid.textContent = T.slice(i, i + q.length);
      hit.append(sm, (a ? '…' : '') + T.slice(a, i).replace(/\s+/g, ' '), mid, T.slice(i + q.length, b).replace(/\s+/g, ' ') + '…');
      const start = i, end = i + q.length;
      hit.onclick = async () => {
        closePanels();
        await goTo({ ch, off: start });
        const r = rangeFromOffsets(R.cur.flow, start, end);
        if (r) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
      };
      list.append(hit);
    }
    await new Promise(r => setTimeout(r, 0));
  }
  info.textContent = count ? count + (count >= 200 ? '+' : '') + ' sonuç bulundu.' : '“' + raw + '” bu kitapta geçmiyor.';
}
$('#btnDoSearch').onclick = doSearch;
$('#searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

/* sayfaya git */
const doGoto = () => { const v = parseInt($('#gotoInput').value, 10); if (!v) return toast('Bir sayfa numarası yaz'); closePanels(); goToPage(v); };
$('#btnDoGoto').onclick = doGoto;
$('#gotoInput').addEventListener('keydown', e => { if (e.key === 'Enter') doGoto(); });
$$('#panelGoto [data-go]').forEach(b => { b.onclick = () => { closePanels(); goToPage(b.dataset.go === 'first' ? 1 : b.dataset.go === 'last' ? P.total : Math.ceil(P.total / 2)); }; });

$('#btnAdd').onclick = $('#btnAdd2').onclick = () => bridge.pick();
$('#btnAllMarks').onclick = () => { renderMarks(); openPanel('#panelMarks'); };
$('#btnBack').onclick = closeReader;
$('#btnToc').onclick = () => { renderToc(); openPanel('#panelToc'); };
$('#btnMarks').onclick = () => { renderMarks(); openPanel('#panelMarks'); };
$('#btnSearch').onclick = () => { openPanel('#panelSearch'); };
$('#btnGoto').onclick = () => { $('#gotoInput').value = ''; openPanel('#panelGoto'); refreshPages(); };
$('#btnBm').onclick = toggleBookmark;
$('#btnSet').onclick = () => openPanel('#panelSet');

/* ---------------- Görünüm ayarları ---------------- */

function applyPrefs(relayout) {
  const st = document.documentElement.style, W = innerWidth;
  const pad = { dar: Math.max(18, W * 0.03), normal: Math.max(28, W * 0.07), genis: Math.max(40, W * 0.13) }[prefs.margin] || 24;
  st.setProperty('--font-size', prefs.font + 'px');
  st.setProperty('--line-height', prefs.line);
  st.setProperty('--pad-x', Math.round(pad) + 'px');
  document.body.className = 'theme-' + prefs.theme + (R.book && R.book.isPdf ? ' pdfmode' : '');
  paper = getComputedStyle(document.body).getPropertyValue('--page').trim() || '#f8f1e3';
  sizeCurl();
  $('#fontVal').textContent = prefs.font + ' pt';
  const seg = (id, v) => $$(id + ' button').forEach(b => b.classList.toggle('on', b.dataset.v === String(v)));
  seg('#segLine', prefs.line); seg('#segTheme', prefs.theme); seg('#segFlip', prefs.flip); seg('#segMargin', prefs.margin); seg('#segTr', prefs.tr);
  store.set('prefs', prefs);
  if (relayout && R.book && R.book.isPdf && !$('#reader').hidden && !R.busy) {
    // PDF sayfaları yeni ekran boyutuna göre yeniden çizilir
    const ch = R.cur.ch; R.book.clearPages(); sheetA.ch = sheetB.ch = -1;
    goTo({ ch });
  } else if (relayout && R.book && !$('#reader').hidden && !R.busy) {
    const s = R.cur, pos = meta[R.id] && meta[R.id].pos;
    s.layout();
    if (pos && pos.ch === s.ch && pos.off != null) s.show(s.pageOfOffset(pos.off));
    if (R.other.ch >= 0) R.other.layout();
    afterMove();
  }
}
$('#fontMinus').onclick = () => { prefs.font = clamp(prefs.font - 1, 14, 34); applyPrefs(true); };
$('#fontPlus').onclick = () => { prefs.font = clamp(prefs.font + 1, 14, 34); applyPrefs(true); };
const segBind = (id, key, relayout, num) => $$(id + ' button').forEach(b => { b.onclick = () => { prefs[key] = num ? parseFloat(b.dataset.v) : b.dataset.v; applyPrefs(relayout); }; });
segBind('#segLine', 'line', true, true); segBind('#segMargin', 'margin', true);
segBind('#segTheme', 'theme', false); segBind('#segFlip', 'flip', false); segBind('#segTr', 'tr', false);
let rz = 0;
addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => applyPrefs(true), 150); });

let toastT = 0;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2400);
}

applyPrefs();
renderLibrary();
