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
let prefs = Object.assign({ font: 20, line: 1.65, theme: 'paper', flip: 'on' }, store.get('prefs', {}));

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
      for (const n of Array.from(body.childNodes)) frag.appendChild(document.importNode(n, true));
    }
    this.cache.set(i, frag);
    if (this.cache.size > 14) this.cache.delete(this.cache.keys().next().value);
    return frag;
  }

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
    this.layout();
  }
  layout() {
    this.flow.style.columnWidth = this.clip.clientWidth + 'px';
    this.pages = Math.max(1, Math.round((this.flow.scrollWidth + GAP) / this.step));
    if (this.page > this.pages - 1) this.page = this.pages - 1;
    this.show(this.page);
  }
  show(p) {
    this.page = clamp(p, 0, this.pages - 1);
    this.flow.style.transform = 'translateX(' + (-this.page * this.step) + 'px)';
    if (R.book) {
      this.footCh.textContent = R.book.chapterTitle(this.ch);
      this.footPg.textContent = (this.page + 1) + ' / ' + this.pages;
    }
  }
  pageOfRect(rect) {
    const x = rect.left - this.flow.getBoundingClientRect().left;
    return clamp(Math.floor((x + 2) / this.step), 0, this.pages - 1);
  }
  pageOfOffset(off) {
    const r = rangeFromOffsets(this.flow, off, off + 1);
    const rect = r && r.getClientRects()[0];
    return rect ? this.pageOfRect(rect) : 0;
  }
  pageOfAnchor(id) {
    let el = null;
    try { el = this.flow.querySelector('#' + CSS.escape(id)) || this.flow.querySelector('[name="' + CSS.escape(id) + '"]'); } catch (e) {}
    return el ? this.pageOfRect(el.getBoundingClientRect()) : 0;
  }
}

const sheetA = new Sheet($('#sheetA')), sheetB = new Sheet($('#sheetB'));
const R = { id: null, book: null, cur: sheetA, other: sheetB, busy: false };

function setTop(s) {
  const o = s === sheetA ? sheetB : sheetA;
  s.el.className = 'sheet top';
  o.el.className = 'sheet under rest';
}

function animate(cur, oth, dir) {
  if (prefs.flip === 'off') { setTop(oth); return Promise.resolve(); }
  return new Promise(res => {
    const mover = dir > 0 ? cur : oth, still = dir > 0 ? oth : cur;
    still.el.className = 'sheet under';
    mover.el.className = 'sheet top turning ' + (dir > 0 ? 'out-fwd' : 'in-back');
    let done = false;
    const fin = () => {
      if (done) return; done = true;
      mover.el.removeEventListener('animationend', onEnd);
      setTop(oth); res();
    };
    const onEnd = e => { if (e.target === mover.el) fin(); };
    mover.el.addEventListener('animationend', onEnd);
    setTimeout(fin, 1000);
  });
}

async function turn(dir) {
  if (R.busy || !R.book) return;
  const cur = R.cur, oth = R.other;
  let ch = cur.ch, pg = cur.page + dir, toLast = false;
  if (pg < 0) { if (ch === 0) return toast('Kitabın başındasın'); ch--; toLast = true; }
  else if (pg >= cur.pages) { if (ch >= R.book.spine.length - 1) return toast('Kitabın sonu'); ch++; pg = 0; }
  R.busy = true;
  hideFloating();
  try {
    await oth.load(ch);
    oth.show(toLast ? oth.pages - 1 : pg);
    await animate(cur, oth, dir);
    R.cur = oth; R.other = cur;
    afterMove();
  } finally { R.busy = false; }
}

async function goTo(pos) {
  if (!R.book) return;
  R.busy = true;
  try {
    const s = R.cur;
    await s.load(clamp(pos.ch || 0, 0, R.book.spine.length - 1));
    let p = 0;
    if (pos.off != null) p = s.pageOfOffset(pos.off);
    else if (pos.anchor) p = s.pageOfAnchor(pos.anchor);
    else if (pos.frac) p = Math.min(s.pages - 1, Math.floor(pos.frac * s.pages + 1e-4));
    s.show(p); setTop(s);
    afterMove();
  } finally { R.busy = false; }
}

function afterMove() {
  const s = R.cur, n = R.book.spine.length;
  const pct = clamp((s.ch + (s.page + 1) / s.pages) / n, 0, 1);
  const m = meta[R.id] || (meta[R.id] = {});
  m.pos = { ch: s.ch, frac: s.page / s.pages }; m.pct = pct;
  store.set('books', meta);
  $('#progFill').style.width = (pct * 100).toFixed(1) + '%';
  $('#progText').textContent = '%' + Math.round(pct * 100) + ' · ' + R.book.chapterTitle(s.ch);
  // bir sonraki sayfayı arkada hazırla
  const next = s.page < s.pages - 1 ? s.ch : Math.min(s.ch + 1, n - 1);
  R.other.load(next);
}

/* ---------------- İşaretler ---------------- */

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
      mk.className = 'hl ' + m.color; mk.dataset.id = m.id;
      node.replaceWith(mk); mk.appendChild(node);
    }
  }
}
function repaint() {
  [sheetA, sheetB].forEach(s => { if (s.ch >= 0) paintMarks(s); });
}

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
    $('#markPop').hidden = true; showBars(false);
    $('#selbar').hidden = false;
  } else if (lastSel) {
    lastSel.t = Date.now();
    setTimeout(() => { if (!selRange()) $('#selbar').hidden = true; }, 400);
  }
});
function activeSel() {
  const r = selRange();
  if (r) { const o = selOffsets(r); return { ch: R.cur.ch, start: o.start, end: o.end }; }
  if (lastSel && Date.now() - lastSel.t < 2500 && lastSel.ch === R.cur.ch) return lastSel;
  return null;
}

function addMark(color) {
  const s = activeSel();
  if (!s) return;
  const T = R.cur.flow.textContent;
  let a = s.start, b = s.end;
  while (a < b && /\s/.test(T[a])) a++;
  while (b > a && /\s/.test(T[b - 1])) b--;
  if (b <= a) return;
  // üst üste gelen eski işaretleri birleştir
  marks = marks.filter(m => {
    if (m.book !== R.id || m.ch !== s.ch || m.end <= a || m.start >= b) return true;
    a = Math.min(a, m.start); b = Math.max(b, m.end); return false;
  });
  marks.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    book: R.id, bookTitle: (meta[R.id] && meta[R.id].title) || R.book.title || 'Kitap',
    ch: s.ch, chTitle: R.book.chapterTitle(s.ch),
    start: a, end: b, text: T.slice(a, b).replace(/\s+/g, ' ').trim(), color, ts: Date.now()
  });
  store.set('marks', marks);
  getSelection().removeAllRanges(); lastSel = null;
  $('#selbar').hidden = true;
  repaint();
  toast('İşaretlendi');
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
  const lo = span(block(sr.startContainer))[0], hi = span(block(sr.endContainer))[1];
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

const press = (el, fn) => el.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); fn(e); });
$$('#selbar .dot').forEach(d => press(d, () => addMark(d.dataset.color)));
press($('#btnSentence'), expandToSentence);

let popId = null;
function showMarkPop(id) {
  const m = marks.find(x => x.id === id);
  if (!m) return;
  popId = id;
  $('#markPopText').textContent = m.text;
  $('#markPop').hidden = false;
}
$('#btnMarkDel').onclick = () => { if (popId) removeMark(popId); $('#markPop').hidden = true; toast('İşaret kaldırıldı'); };
$('#btnMarkClose').onclick = () => { $('#markPop').hidden = true; };

/* ---------------- Dokunma ---------------- */

let down = null;
const stage = $('#stage');
stage.addEventListener('pointerdown', e => {
  down = { x: e.clientX, y: e.clientY, t: Date.now(), sel: !!selRange(), target: e.target };
});
stage.addEventListener('pointerup', e => {
  if (!down) return;
  const d = down; down = null;
  const dx = e.clientX - d.x, dy = e.clientY - d.y, dt = Date.now() - d.t;
  if (d.sel || selRange()) return;
  if (Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy) && dt < 800) return void turn(dx < 0 ? 1 : -1);
  if (Math.abs(dx) > 12 || Math.abs(dy) > 12 || dt > 350) return;
  // dokunuş
  if (!$('#markPop').hidden) { $('#markPop').hidden = true; return; }
  if (!$('#topbar').hidden) return showBars(false);
  const mk = d.target.closest && d.target.closest('mark.hl');
  if (mk) return showMarkPop(mk.dataset.id);
  const link = d.target.closest && d.target.closest('a[data-href]');
  if (link) {
    const [p, frag] = link.dataset.href.split('#');
    const ch = R.book.spine.indexOf(p);
    if (ch >= 0) return void goTo({ ch, anchor: frag });
  }
  const x = e.clientX / innerWidth;
  if (x < 0.28) turn(-1); else if (x > 0.72) turn(1); else showBars(true);
});
stage.addEventListener('pointercancel', () => { down = null; });
document.addEventListener('keydown', e => {
  if ($('#reader').hidden) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') turn(1);
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') turn(-1);
});

function showBars(on) { $('#topbar').hidden = !on; $('#bottombar').hidden = !on; }
function hideFloating() { showBars(false); $('#markPop').hidden = true; }

/* ---------------- Kitaplık ---------------- */

function renderLibrary() {
  const books = bridge.list();
  const grid = $('#bookGrid');
  grid.replaceChildren();
  $('#libEmpty').hidden = books.length > 0;
  $('#libCount').textContent = books.length ? books.length + ' kitap · ' + marks.length + ' işaret' : '';
  for (const b of books) {
    const m = meta[b.id] || {};
    const title = m.title || b.name.replace(/\.epub$/i, '');
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
      R.book = null; sheetA.ch = sheetB.ch = -1; sheetA.page = sheetB.page = 0;
      const res = await fetch(bridge.url(id));
      if (!res.ok) throw new Error('Dosya okunamadı');
      const book = await Epub.open(await res.arrayBuffer());
      R.book = book; R.id = id;
      const m = meta[id] || (meta[id] = {});
      m.title = book.title || m.title || id.replace(/\.epub$/i, '');
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
  getSelection().removeAllRanges();
  $('#reader').hidden = true; $('#library').hidden = false; $('#selbar').hidden = true;
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
    if (!$('#markPop').hidden) { $('#markPop').hidden = true; return true; }
    if (selRange()) { getSelection().removeAllRanges(); return true; }
    closeReader(); return true;
  }
  return false;
};

/* ---------------- Paneller ---------------- */

function openPanel(id) { closePanels(); $('#scrim').hidden = false; $(id).hidden = false; showBars(false); }
function closePanels() { $('#scrim').hidden = true; $$('.panel').forEach(p => { p.hidden = true; }); }
$('#scrim').onclick = closePanels;
$$('.panel .close').forEach(b => { b.onclick = closePanels; });

function renderToc() {
  const list = $('#tocList'); list.replaceChildren();
  const toc = R.book.toc.length ? R.book.toc : R.book.spine.map((p, i) => ({ label: 'Bölüm ' + (i + 1), ch: i, depth: 0, frag: '' }));
  let curIdx = -1;
  toc.forEach((t, i) => { if (t.ch <= R.cur.ch) curIdx = i; });
  toc.forEach((t, i) => {
    const b = document.createElement('button');
    b.className = 'toc-item' + (i === curIdx ? ' cur' : '');
    b.style.paddingLeft = (t.depth * 18) + 'px';
    b.textContent = t.label;
    b.onclick = () => { closePanels(); goTo({ ch: t.ch, anchor: t.frag }); };
    list.append(b);
  });
}

function marksFor(bookId) {
  return marks.filter(m => !bookId || m.book === bookId)
    .sort((a, b) => a.bookTitle.localeCompare(b.bookTitle, 'tr') || a.ch - b.ch || a.start - b.start);
}
function renderMarks() {
  const inReader = !$('#reader').hidden;
  const list = marksFor(inReader ? R.id : null);
  const box = $('#marksList'); box.replaceChildren();
  $('#marksTitle').textContent = 'İşaretlerim' + (list.length ? ' (' + list.length + ')' : '');
  $('#btnShare').hidden = !list.length;
  if (!list.length) {
    const d = document.createElement('div'); d.className = 'panel-empty';
    d.textContent = 'Henüz işaretlediğin bir cümle yok. Okurken bir cümleye basılı tut, seç ve bir renge dokun.';
    box.append(d); return;
  }
  const have = new Set(bridge.list().map(b => b.id));
  let lastBook = null;
  for (const m of list) {
    if (!inReader && m.book !== lastBook) {
      const h = document.createElement('div'); h.className = 'mark-book'; h.textContent = m.bookTitle; box.append(h); lastBook = m.book;
    }
    const it = document.createElement('div'); it.className = 'mark-item';
    const q = document.createElement('blockquote'); q.className = m.color; q.textContent = m.text;
    const mt = document.createElement('div'); mt.className = 'mark-meta';
    const info = document.createElement('span');
    info.textContent = m.chTitle + ' · ' + new Date(m.ts).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });
    const acts = document.createElement('span');
    if (have.has(m.book)) {
      const go = document.createElement('button'); go.textContent = 'Sayfaya git';
      go.onclick = () => {
        closePanels();
        if (inReader) goTo({ ch: m.ch, off: m.start }).then(() => flashMark(m.id));
        else openBook(m.book, { ch: m.ch, off: m.start, flash: m.id });
      };
      acts.append(go);
    }
    const del = document.createElement('button'); del.textContent = 'Sil';
    del.onclick = () => { removeMark(m.id); renderMarks(); };
    acts.append(del);
    mt.append(info, acts); it.append(q, mt); box.append(it);
  }
}
$('#btnShare').onclick = () => {
  const inReader = !$('#reader').hidden;
  let out = '', last = null;
  for (const m of marksFor(inReader ? R.id : null)) {
    if (m.book !== last) { out += (out ? '\n' : '') + '📖 ' + m.bookTitle + '\n\n'; last = m.book; }
    out += '“' + m.text + '”\n— ' + m.chTitle + '\n\n';
  }
  bridge.share(out.trim());
};

$('#btnAdd').onclick = $('#btnAdd2').onclick = () => bridge.pick();
$('#btnAllMarks').onclick = () => { renderMarks(); openPanel('#panelMarks'); };
$('#btnBack').onclick = closeReader;
$('#btnToc').onclick = () => { renderToc(); openPanel('#panelToc'); };
$('#btnMarks').onclick = () => { renderMarks(); openPanel('#panelMarks'); };
$('#btnSet').onclick = () => openPanel('#panelSet');

/* ---------------- Görünüm ayarları ---------------- */

function applyPrefs(relayout) {
  const st = document.documentElement.style, W = innerWidth;
  st.setProperty('--font-size', prefs.font + 'px');
  st.setProperty('--line-height', prefs.line);
  st.setProperty('--pad-x', Math.max(28, Math.round(W * 0.06), Math.round((W - 860) / 2)) + 'px');
  document.body.className = 'theme-' + prefs.theme;
  $('#fontVal').textContent = prefs.font + ' pt';
  const seg = (id, v) => $$(id + ' button').forEach(b => b.classList.toggle('on', b.dataset.v === String(v)));
  seg('#segLine', prefs.line); seg('#segTheme', prefs.theme); seg('#segFlip', prefs.flip);
  store.set('prefs', prefs);
  if (relayout && R.book && !$('#reader').hidden) {
    const s = R.cur, frac = s.page / s.pages;
    s.layout(); s.show(Math.min(s.pages - 1, Math.floor(frac * s.pages + 1e-4)));
    if (R.other.ch >= 0) R.other.layout();
    afterMove();
  }
}
$('#fontMinus').onclick = () => { prefs.font = clamp(prefs.font - 1, 14, 34); applyPrefs(true); };
$('#fontPlus').onclick = () => { prefs.font = clamp(prefs.font + 1, 14, 34); applyPrefs(true); };
$$('#segLine button').forEach(b => { b.onclick = () => { prefs.line = parseFloat(b.dataset.v); applyPrefs(true); }; });
$$('#segTheme button').forEach(b => { b.onclick = () => { prefs.theme = b.dataset.v; applyPrefs(false); }; });
$$('#segFlip button').forEach(b => { b.onclick = () => { prefs.flip = b.dataset.v; applyPrefs(false); }; });
let rz = 0;
addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => applyPrefs(true), 150); });

let toastT = 0;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2200);
}

applyPrefs();
renderLibrary();
