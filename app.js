/* Zebra Studio — interface */
'use strict';

// ---------- État ----------
let state = { mode: 'tpe', font: 'sans', frame: true, copies: 1, blocks: [] };
let nextId = 1;
let selectedId = null;
const imageCache = new Map();
let device = null, writeChar = null, printing = false;
const $ = id => document.getElementById(id);

const FONT_CHIPS = { sans: 'Sans', serif: 'Serif', mono: 'Ticket', machine: 'Machine', hand: 'Manuscrite', marker: 'Marqueur' };

// ---------- Journal, toast ----------
function log(m) {
  const d = document.createElement('div'); d.textContent = `[${new Date().toLocaleTimeString('fr-FR')}] ${m}`;
  $('log').appendChild(d); $('log').scrollTop = $('log').scrollHeight;
}
let toastTimer;
function toast(text, err, action) {
  const t = $('toast'); t.textContent = text; t.className = 'toast show' + (err ? ' err' : '') + (action ? ' act' : '');
  if (action) t.append(h('button', { onclick: () => { t.className = 'toast'; action.run(); } }, action.label));
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.className = 'toast', action ? 6000 : err ? 4500 : 2600);
  log(text);
}
function wipeAll() {
  if (!state.blocks.length) { toast('C\'est déjà tout propre ✨'); return; }
  const backup = state.blocks.slice();
  state.blocks = []; selectedId = null; renderBlocks(); changed();
  toast('Tout est effacé 🧹', false, { label: 'Annuler', run: () => { state.blocks = backup; renderBlocks(); changed(); toast('Restauré'); } });
}
window.addEventListener('error', e => log('Erreur JS : ' + e.message));
window.addEventListener('unhandledrejection', e => log('Erreur : ' + (e.reason && e.reason.message || e.reason)));

// ---------- Sauvegarde ----------
function save() { try { localStorage.setItem('zebra-studio-v2', JSON.stringify(state)); } catch (_) {} }
function load() {
  try {
    const s = JSON.parse(localStorage.getItem('zebra-studio-v2') || localStorage.getItem('zebra-studio') || 'null');
    if (s && Array.isArray(s.blocks)) { state = Object.assign(state, s); state.blocks.forEach(b => b.id = nextId++); return true; }
  } catch (_) {}
  return false;
}
function newBlock(type, props) {
  const base = {
    text:  { text: '', size: 'M', align: 'left' },
    list:  { title: '', items: '', size: 'M', box: 'square' },
    image: { src: '', render: 'photo', bright: 0, width: 100 },
    qr:    { text: '', size: 'M', caption: '' },
    sep:   { style: 'stars' },
    space: { h: 60 },
  }[type];
  return Object.assign({ id: nextId++, type }, base, props || {});
}
function starter() {
  return [
    newBlock('list', { title: 'À faire ce week-end', items: 'Arroser les plantes\nPromener le chien\nAppeler maman\nRanger le garage' }),
    newBlock('sep', { style: 'scissors' }),
    newBlock('text', { text: 'Imprimé le {date} à {heure}', size: 'S', align: 'center' }),
  ];
}

// ---------- Aperçu ----------
let renderTimer = null, renderSeq = 0;
function changed() { save(); clearTimeout(renderTimer); renderTimer = setTimeout(renderPreview, 220); }
async function renderPreview() {
  const seq = ++renderSeq;
  const pages = await compose();
  if (seq !== renderSeq) return;
  const paper = $('paper'); paper.className = 'paper ' + state.mode; paper.innerHTML = '';
  pages.forEach(p => paper.appendChild(p));
  let black = 0, px = 0;
  pages.forEach(p => { const d = p.getContext('2d').getImageData(0, 0, p.width, p.height).data; for (let i = 0; i < d.length; i += 32) { px++; if (d[i] < 128) black++; } });
  let info = state.mode === 'dymo'
    ? `${pages.length} étiquette${pages.length > 1 ? 's' : ''}`
    : `Ticket de ${(pages[0].height / 80).toFixed(1).replace('.', ',')} cm` + (state.blocks.some(b => b.type === 'list') && pages[0].height <= TPE_LIST_MIN ? ' (minimum liste)' : '');
  if (state.copies > 1) info += ` · ${state.copies} exemplaires`;
  const warn = px && black / px > 0.3;
  if (warn) info += ' · beaucoup de noir, pense à éclaircir';
  $('info').textContent = info; $('info').className = 'info' + (warn ? ' warn' : '');
}

// ---------- Petits utilitaires DOM ----------
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else e.setAttribute(k, v);
  }
  kids.flat().forEach(c => { if (c != null) e.append(c instanceof Node ? c : document.createTextNode(c)); });
  return e;
}
function seg(value, options, onpick) {
  const s = h('div', { class: 'seg' });
  options.forEach(([v, label, title]) => {
    const b = h('button', { class: v === value ? 'on' : '', title: title || '', onclick: e => {
      e.stopPropagation(); s.querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); onpick(v);
    } }, label);
    s.append(b);
  });
  return s;
}
function autosize(t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }
const SIZE_OPTS = [['S', 'S'], ['M', 'M'], ['L', 'L'], ['XL', 'XL']];

// ---------- Cartes ----------
function card(b) {
  const c = h('div', { class: 'block' + (b.id === selectedId ? ' sel' : ''), 'data-type': b.type, 'data-id': b.id });
  c.addEventListener('pointerdown', () => select(b.id));
  c.append(h('div', { class: 'tools' },
    h('button', { title: 'Monter', onclick: e => { e.stopPropagation(); move(b, -1); } }, '↑'),
    h('button', { title: 'Descendre', onclick: e => { e.stopPropagation(); move(b, 1); } }, '↓'),
    h('button', { title: 'Dupliquer', onclick: e => { e.stopPropagation(); duplicate(b); } }, '⧉'),
    h('button', { title: 'Supprimer', onclick: e => { e.stopPropagation(); remove(b); } }, '🗑')));
  const more = h('div', { class: 'more' });
  const set = (k, v) => { b[k] = v; changed(); };

  if (b.type === 'text') {
    const ta = h('textarea', { rows: 1, value: b.text, placeholder: 'Écris quelque chose…', oninput: e => { autosize(e.target); set('text', e.target.value); } });
    c.append(ta); requestAnimationFrame(() => autosize(ta));
    const wrap = (pre, post) => {
      const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
      const mid = v.slice(s, e) || 'texte';
      ta.value = v.slice(0, s) + pre + mid + post + v.slice(e);
      ta.focus(); ta.setSelectionRange(s + pre.length, s + pre.length + mid.length);
      autosize(ta); set('text', ta.value);
    };
    const prefix = p => {
      const v = ta.value, s = ta.selectionStart; const ls = v.lastIndexOf('\n', s - 1) + 1;
      const line = v.slice(ls).split('\n')[0];
      const clean = line.replace(/^(#{1,3}\s|[-*+]\s\[[ xX]\]\s|[-*+]\s)/, '');
      const next = line.startsWith(p) ? clean : p + clean;
      ta.value = v.slice(0, ls) + next + v.slice(ls + line.length);
      ta.focus(); autosize(ta); set('text', ta.value);
    };
    more.append(
      h('div', { class: 'fmt' },
        h('button', { title: 'Gras', onclick: e => { e.stopPropagation(); wrap('**', '**'); } }, 'B'),
        h('button', { title: 'Italique', style: 'font-style:italic', onclick: e => { e.stopPropagation(); wrap('*', '*'); } }, 'I'),
        h('button', { title: 'Titre', onclick: e => { e.stopPropagation(); prefix('# '); } }, 'H'),
        h('button', { title: 'Puce', onclick: e => { e.stopPropagation(); prefix('- '); } }, '•'),
        h('button', { title: 'Case à cocher', onclick: e => { e.stopPropagation(); prefix('- [ ] '); } }, '☐')),
      seg(b.size, SIZE_OPTS, v => set('size', v)),
      seg(b.align, [['left', '⇤', 'Gauche'], ['center', '↔', 'Centré'], ['right', '⇥', 'Droite']], v => set('align', v)));
  }

  else if (b.type === 'list') {
    const title = h('input', { class: 'title', value: b.title, placeholder: 'Titre de la liste', oninput: e => { set('title', e.target.value); } });
    const preview = h('ul', { class: 'checks' + (b.box === 'round' ? ' round' : '') });
    const refreshPreview = () => {
      preview.innerHTML = '';
      listItems(b).slice(0, 12).forEach(t => preview.append(h('li', { class: /^\[[xX]\]/.test(t) ? 'done' : '' }, t.replace(/^\[[xX]\]\s*/, ''))));
      const n = listItems(b).length; if (n > 12) preview.append(h('li', { style: 'opacity:.6' }, `… et ${n - 12} autres`));
      if (!n) preview.append(h('li', { style: 'opacity:.5' }, 'Touche pour écrire ta liste'));
    };
    refreshPreview();
    const ta = h('textarea', { rows: 3, value: b.items, placeholder: 'Un élément par ligne… ou écris / dicte tout d\'un bloc, puis ✨ Ranger',
      oninput: e => { autosize(e.target); set('items', e.target.value); refreshPreview(); } });
    ta.style.display = b.id === selectedId ? '' : 'none';
    preview.style.display = b.id === selectedId ? 'none' : '';
    c.append(title, preview, ta);
    requestAnimationFrame(() => autosize(ta));
    c._onSelect = on => { ta.style.display = on ? '' : 'none'; preview.style.display = on ? 'none' : ''; if (on) autosize(ta); };
    more.append(
      h('button', { class: 'magic', onclick: e => { e.stopPropagation(); ta.value = tidyList(ta.value); autosize(ta); set('items', ta.value); refreshPreview(); toast(`${listItems(b).length} éléments rangés ✨`); } }, '✨ Ranger'),
      seg(b.size, SIZE_OPTS, v => set('size', v)),
      seg(b.box, [['square', '☐', 'Cases carrées'], ['round', '◯', 'Ronds']], v => { set('box', v); preview.classList.toggle('round', v === 'round'); }));
  }

  else if (b.type === 'image') {
    const thumb = h('div', { class: 'thumb' }, h('span', { style: 'color:var(--mute);font-size:14px;padding:30px' }, 'Chargement…'));
    c.append(thumb);
    const drawThumb = async () => {
      const im = await getImage(b);
      thumb.innerHTML = '';
      if (!im) { thumb.append(h('span', { style: 'color:var(--mute);padding:30px' }, 'Image illisible')); return; }
      thumb.append(ditherInto(im, contentGeometry().W * (b.width || 100) / 100, b));
    };
    drawThumb();
    let t; const setThumb = (k, v) => { b[k] = v; changed(); clearTimeout(t); t = setTimeout(drawThumb, 120); };
    more.append(
      seg(b.render, [['photo', 'Photo'], ['net', 'Net']], v => setThumb('render', v)),
      h('label', { class: 'slider', title: 'Luminosité' }, '☾', h('input', { type: 'range', min: -60, max: 60, value: b.bright, oninput: e => setThumb('bright', +e.target.value) }), '☀︎'),
      h('label', { class: 'slider', title: 'Taille' }, '▫︎', h('input', { type: 'range', min: 30, max: 100, step: 5, value: b.width, oninput: e => setThumb('width', +e.target.value) }), '◻︎'),
      h('button', { class: 'seg', style: 'border:0;padding:0 14px;height:40px;font-weight:700', onclick: e => { e.stopPropagation(); replaceImage(b); } }, 'Remplacer'));
  }

  else if (b.type === 'qr') {
    const pv = h('div', { style: 'width:72px;height:72px;flex:none;display:grid;place-items:center;background:var(--bg);border-radius:8px;color:var(--mute);font-size:28px' }, '▦');
    const draw = () => { const q = qrCanvas(b); pv.innerHTML = ''; if (q) pv.append(q); else pv.textContent = '▦'; };
    draw();
    c.append(h('div', { class: 'row' }, pv,
      h('input', { class: 'field', value: b.text, placeholder: 'Un lien, un texte, un mot de passe Wi-Fi…', oninput: e => { set('text', e.target.value); draw(); } })));
    more.append(seg(b.size, SIZE_OPTS, v => set('size', v)),
      h('input', { class: 'field', value: b.caption, placeholder: 'Légende sous le QR (facultatif)', oninput: e => set('caption', e.target.value) }));
  }

  else if (b.type === 'sep') {
    const view = h('div', { class: 'sepview' });
    const draw = () => { view.innerHTML = ''; view.append(sepCanvas(b.style)); };
    draw(); c.append(view);
    const sw = h('div', { class: 'swatches' });
    ['line', 'double', 'dashes', 'dots', 'zigzag', 'stars', 'scissors'].forEach(st => {
      const bt = h('button', { class: st === b.style ? 'on' : '', onclick: e => { e.stopPropagation(); sw.querySelectorAll('button').forEach(x => x.classList.remove('on')); bt.classList.add('on'); set('style', st); draw(); } }, sepCanvas(st));
      sw.append(bt);
    });
    more.append(sw);
  }

  else if (b.type === 'space') {
    const view = h('div', { class: 'spaceview' });
    const draw = () => { view.style.height = Math.max(24, b.h / 2.5) + 'px'; view.textContent = `Espace · ${(b.h / 8 / 10).toFixed(1).replace('.', ',')} cm`; };
    draw(); c.append(view);
    more.append(h('label', { class: 'slider' }, '↕', h('input', { type: 'range', min: 10, max: 400, step: 10, value: b.h, oninput: e => { set('h', +e.target.value); draw(); } })));
  }

  c.append(more);
  return c;
}
function sepCanvas(style) {
  const W = PW - 16, hgt = drawSep(null, style, W, 0, false);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = hgt;
  const x = cv.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, W, hgt);
  drawSep(x, style, W, 0, true);
  cv.style.cssText = 'filter:var(--sepfilter, none)';
  return cv;
}

// ---------- Liste : rangement intelligent ----------
function tidyList(text) {
  let parts = text.replace(/\r/g, '').split(/\n+/);
  if (parts.filter(p => p.trim()).length <= 1) parts = text.split(/[,;]|\s+(?:et|puis|aussi)\s+/i);
  const seen = new Set(), out = [];
  parts.forEach(p => {
    let s = p.trim();
    let done = /^[-*+•]?\s*\[[xX]\]/.test(s);
    for (let i = 0; i < 3; i++) s = s.replace(/^(?:[-*+•–]\s*|\d+[.)]\s*|\[[ xX]?\]\s*|☐\s*|☑\s*|✓\s*)/, '').trim();
    s = s.replace(/[.;,]+$/, '').trim();
    if (!s) return;
    s = s.charAt(0).toUpperCase() + s.slice(1);
    const key = s.toLowerCase();
    if (seen.has(key)) return; seen.add(key);
    out.push((done ? '[x] ' : '') + s);
  });
  return out.join('\n');
}
function looksLikeList(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return false;
  const marked = lines.filter(l => /^\s*([-*+•]|\d+[.)]|\[[ xX]?\]|☐)/.test(l)).length;
  return marked >= Math.max(2, lines.length * 0.6);
}

// ---------- Gestion des blocs ----------
function renderBlocks() {
  const w = $('blocks'); w.innerHTML = '';
  if (!state.blocks.length) w.append(h('div', { class: 'empty' }, h('b', {}, 'Page blanche ✨'), 'Ajoute un texte, une liste, une photo… ou colle directement ce que tu veux.'));
  state.blocks.forEach(b => w.append(card(b)));
}
function select(id) {
  if (selectedId === id) return;
  selectedId = id;
  document.querySelectorAll('.block').forEach(el => {
    const on = +el.dataset.id === id;
    if (el.classList.contains('sel') !== on) { el.classList.toggle('sel', on); if (el._onSelect) el._onSelect(on); }
  });
}
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('.block, .bar, .sheet-bg, .adds, .drop, header')) select(null);
});
function insertIndex() {
  const i = state.blocks.findIndex(b => b.id === selectedId);
  return i < 0 ? state.blocks.length : i + 1;
}
function addBlock(type, props, focus) {
  const b = newBlock(type, props);
  state.blocks.splice(insertIndex(), 0, b);
  selectedId = b.id; renderBlocks(); changed();
  const el = document.querySelector(`.block[data-id="${b.id}"]`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (focus) { const t = el.querySelector(type === 'list' ? 'textarea' : 'textarea, input.field'); if (t) setTimeout(() => t.focus(), 50); }
  }
  return b;
}
function move(b, d) {
  const i = state.blocks.indexOf(b), j = i + d; if (j < 0 || j >= state.blocks.length) return;
  state.blocks.splice(i, 1); state.blocks.splice(j, 0, b); renderBlocks(); changed();
}
function duplicate(b) {
  const copy = Object.assign({}, b, { id: nextId++ });
  state.blocks.splice(state.blocks.indexOf(b) + 1, 0, copy); selectedId = copy.id; renderBlocks(); changed();
}
function remove(b) {
  const i = state.blocks.indexOf(b); state.blocks.splice(i, 1); selectedId = null; renderBlocks(); changed();
  toast('Bloc supprimé');
}

// ---------- Fichiers, collage, glisser-déposer ----------
function readAs(file, how) {
  return new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error);
    how === 'text' ? r.readAsText(file) : how === 'buffer' ? r.readAsArrayBuffer(file) : r.readAsDataURL(file);
  });
}
function shrinkDataUrl(src, maxW) {
  return new Promise(res => {
    const im = new Image();
    im.onload = () => {
      const s = Math.min(1, maxW / im.naturalWidth);
      const c = document.createElement('canvas'); c.width = Math.round(im.naturalWidth * s); c.height = Math.round(im.naturalHeight * s);
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(im, 0, 0, c.width, c.height);
      res(c.toDataURL('image/jpeg', 0.88));
    };
    im.onerror = () => res(null);
    im.src = src;
  });
}
function getImage(b) {
  if (!b.src) return Promise.resolve(null);
  if (imageCache.has(b.src)) return Promise.resolve(imageCache.get(b.src));
  return new Promise(res => { const im = new Image(); im.onload = () => { imageCache.set(b.src, im); res(im); }; im.onerror = () => res(null); im.src = b.src; });
}
async function pdfToImages(file) {
  const lib = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
  if (!lib) throw new Error('lecteur PDF indisponible');
  lib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
  const pdf = await lib.getDocument({ data: await readAs(file, 'buffer') }).promise;
  const n = Math.min(pdf.numPages, 10);
  if (pdf.numPages > 10) toast(`PDF de ${pdf.numPages} pages : je prends les 10 premières.`);
  const out = [];
  for (let i = 1; i <= n; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 768 / page.getViewport({ scale: 1 }).width });
    const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: x, viewport: vp }).promise;
    out.push(c.toDataURL('image/jpeg', 0.9));
  }
  return out;
}
function kindOf(f) {
  const n = (f.name || '').toLowerCase();
  if (/\.(md|markdown|mdown|txt|text)$/.test(n) || /^text\//.test(f.type)) return 'text';
  if (/\.pdf$/.test(n) || f.type === 'application/pdf') return 'pdf';
  if (/^image\//.test(f.type) || /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/.test(n)) return 'image';
  return null;
}
function addText(txt) {
  txt = txt.replace(/\r/g, '').trim(); if (!txt) return;
  if (looksLikeList(txt)) {
    const lines = txt.split('\n'); let title = '';
    if (!/^\s*([-*+•]|\d+[.)]|\[)/.test(lines[0])) title = lines.shift().replace(/^#+\s*/, '').replace(/\s*[:：]\s*$/, '').trim();
    addBlock('list', { title, items: tidyList(lines.join('\n')) });
    toast('Liste prête à cocher ✓');
  } else { addBlock('text', { text: txt }); toast('Texte ajouté'); }
}
async function importFiles(files, target) {
  for (const f of files) {
    const k = kindOf(f);
    try {
      if (k === 'text') addText(await readAs(f, 'text'));
      else if (k === 'image') {
        const src = await shrinkDataUrl(await readAs(f, 'dataurl'), 768);
        if (!src) throw new Error('format d\'image non lu');
        if (target) { target.src = src; target = null; renderBlocks(); changed(); }
        else addBlock('image', { src, render: 'photo' });
        toast('Image ajoutée 🖼️');
      } else if (k === 'pdf') {
        toast('Lecture du PDF…');
        const imgs = await pdfToImages(f);
        imgs.forEach((src, i) => {
          if (i === 0 && target) { target.src = src; target.render = 'net'; target = null; renderBlocks(); changed(); }
          else addBlock('image', { src, render: 'net' });
        });
        toast(`PDF ajouté : ${imgs.length} page${imgs.length > 1 ? 's' : ''}`);
      } else toast(`« ${f.name} » : je sais lire les photos, PDF, .md et .txt`, true);
    } catch (e) { toast(`Impossible d'ouvrir « ${f.name} » : ${e.message || e}`, true); }
  }
}
let replaceTarget = null;
function replaceImage(b) { replaceTarget = b; $('fileReplace').value = ''; $('fileReplace').click(); }
$('fileReplace').addEventListener('change', e => { const t = replaceTarget; replaceTarget = null; importFiles([...e.target.files], t); });
$('filePick').addEventListener('change', e => importFiles([...e.target.files]));

function clipboardFiles(cd) {
  const out = [];
  if (cd.files && cd.files.length) out.push(...cd.files);
  else [...(cd.items || [])].forEach(it => { if (it.kind === 'file') { const f = it.getAsFile(); if (f) out.push(f); } });
  return out;
}
document.addEventListener('paste', e => {
  const cd = e.clipboardData; if (!cd) return;
  const files = clipboardFiles(cd);
  const inField = e.target.closest && e.target.closest('textarea, input');
  if (files.length) { e.preventDefault(); importFiles(files); return; }
  if (inField) return; // texte collé dans un champ : comportement normal
  const txt = cd.getData('text/plain');
  if (txt) { e.preventDefault(); addText(txt); }
});
// zone de collage : on n'y écrit jamais
const drop = $('drop'); const dropHTML = drop.innerHTML;
drop.addEventListener('beforeinput', e => { if (e.inputType !== 'insertFromPaste') e.preventDefault(); });
drop.addEventListener('input', () => { drop.innerHTML = dropHTML; });
drop.addEventListener('blur', () => { drop.innerHTML = dropHTML; });
let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const dt = e.dataTransfer; if (!dt) return;
  if (dt.files && dt.files.length) importFiles([...dt.files]);
  else { const t = dt.getData('text/plain'); if (t) addText(t); }
});

// ---------- Bluetooth ----------
function setConn(text, kind) { $('state').textContent = text; $('btnConnect').className = 'pill' + (kind ? ' ' + kind : ''); }
function withTimeout(p, ms, label) { return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('délai dépassé (' + label + ')')), ms))]); }
async function attach() {
  const server = await withTimeout(device.gatt.connect(), 15000, 'connexion');
  const service = await withTimeout(server.getPrimaryService(ZEBRA_SERVICE), 10000, 'service Zebra');
  writeChar = await withTimeout(service.getCharacteristic(ZEBRA_WRITE), 10000, 'canal d\'écriture');
  try {
    const rc = await service.getCharacteristic(ZEBRA_READ); await rc.startNotifications();
    rc.addEventListener('characteristicvaluechanged', e => log('Imprimante : ' + new TextDecoder().decode(e.target.value).trim()));
  } catch (_) {}
  setConn(device.name || 'Zebra', 'on');
}
async function connect() {
  if (!('bluetooth' in navigator)) { toast('Ouvre cette page dans Bluefy pour imprimer 📱', true); setConn('Bluefy requis', 'err'); return false; }
  try {
    setConn('Recherche…');
    device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [ZEBRA_SERVICE] });
    device.addEventListener('gattserverdisconnected', () => { writeChar = null; setConn('Connecter'); log('Imprimante déconnectée.'); });
    setConn('Connexion…');
    await attach();
    toast('Imprimante connectée 🦓');
    return true;
  } catch (e) {
    setConn('Connecter', e.name === 'NotFoundError' ? '' : 'err');
    if (e.name !== 'NotFoundError') toast('Connexion impossible : ' + (e.message || e), true);
    return false;
  }
}
async function ensureConnected() {
  if (writeChar && device && device.gatt.connected) return true;
  if (device) { try { await attach(); return true; } catch (_) {} }
  return connect();
}
function chunkSize() { try { return +(localStorage.getItem('zebra-chunk') || 20); } catch (_) { return 20; } }
async function send(text, onProgress) {
  const data = new TextEncoder().encode(text), size = chunkSize();
  const t0 = performance.now();
  for (let i = 0; i < data.length; i += size) {
    const part = data.slice(i, i + size);
    if (writeChar.writeValueWithResponse) await writeChar.writeValueWithResponse(part); else await writeChar.writeValue(part);
    if ((i / size) % 8 === 0) onProgress(i / data.length);
  }
  onProgress(1);
  log(`${data.length} octets envoyés en ${((performance.now() - t0) / 1000).toFixed(1)} s (paquets de ${size}).`);
}
function confetti() {
  const btn = $('btnPrint').getBoundingClientRect();
  const bits = ['🦓', '✨', '🎉', '🧾', '★', '✓'];
  for (let i = 0; i < 16; i++) {
    const s = h('span', { class: 'confetti' }, bits[i % bits.length]);
    s.style.left = (btn.left + btn.width / 2) + 'px'; s.style.top = (btn.top) + 'px';
    s.style.setProperty('--dx', (Math.random() * 360 - 180) + 'px');
    s.style.setProperty('--dy', (-120 - Math.random() * 260) + 'px');
    s.style.setProperty('--r', (Math.random() * 540 - 270) + 'deg');
    document.body.append(s); setTimeout(() => s.remove(), 1200);
  }
}
$('btnConnect').onclick = connect;
$('btnPrint').onclick = async () => {
  if (printing) return;
  if (!state.blocks.length) { toast('Rien à imprimer pour l\'instant', true); return; }
  printing = true;
  const label = $('printLabel'), fill = $('fill'), paper = $('paper');
  try {
    label.textContent = 'Préparation…';
    const zpl = buildZpl(await compose());
    label.textContent = 'Connexion…';
    if (!(await ensureConnected())) { label.textContent = 'Imprimer'; return; }
    paper.classList.add('printing');
    await send(zpl, p => { fill.style.width = Math.round(p * 100) + '%'; label.textContent = `Envoi ${Math.round(p * 100)} %`; });
    label.textContent = 'Imprimé ✓'; confetti();
    if (state.mode === 'dymo') toast('Pense à bien caler l\'étiquette sous la tête 🏷️');
    setTimeout(() => { label.textContent = 'Imprimer'; fill.style.width = '0'; }, 2200);
  } catch (e) {
    label.textContent = 'Imprimer'; fill.style.width = '0';
    toast('Échec d\'envoi : ' + (e.message || e) + ' — essaie la vitesse « Sûr » dans les réglages', true);
  } finally { printing = false; paper.classList.remove('printing'); }
};

// ---------- Réglages globaux ----------
function syncTop() {
  document.querySelectorAll('.mode').forEach(m => m.classList.toggle('active', m.dataset.mode === state.mode));
  const f = $('fonts'); f.innerHTML = '';
  Object.entries(FONT_CHIPS).forEach(([k, label]) => {
    f.append(h('button', { class: 'chip' + (state.font === k ? ' active' : ''), onclick: () => { state.font = k; syncTop(); changed(); refreshThumbs(); } },
      h('span', { class: 'aa', style: `font-family:${FONTS[k].css}` }, 'Aa'), h('small', {}, label)));
  });
  if (state.mode === 'dymo') {
    f.append(h('button', { class: 'toggle' + (state.frame ? ' on' : ''), onclick: () => { state.frame = !state.frame; syncTop(); changed(); refreshThumbs(); } }, h('i'), 'Cadre'));
  }
  $('cVal').textContent = '×' + state.copies;
}
function refreshThumbs() { renderBlocks(); } // la largeur utile change selon le mode / le cadre
document.querySelectorAll('.mode').forEach(m => m.onclick = () => { state.mode = m.dataset.mode; syncTop(); changed(); refreshThumbs(); });
$('cMinus').onclick = () => { state.copies = Math.max(1, state.copies - 1); syncTop(); changed(); };
$('cPlus').onclick = () => { state.copies = Math.min(20, state.copies + 1); syncTop(); changed(); };
document.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
  const t = b.dataset.add;
  if (t === 'file') { $('filePick').value = ''; $('filePick').click(); }
  else addBlock(t, {}, t === 'text' || t === 'list' || t === 'qr');
});

// Feuille de réglages
$('btnSettings').onclick = () => $('sheetBg').classList.add('open');
$('sheetBg').addEventListener('click', e => { if (e.target === $('sheetBg')) $('sheetBg').classList.remove('open'); });
(function () {
  const cur = String(chunkSize());
  document.querySelectorAll('#chunkSeg button').forEach(b => {
    b.classList.toggle('on', b.dataset.v === cur);
    b.onclick = () => { document.querySelectorAll('#chunkSeg button').forEach(x => x.classList.remove('on')); b.classList.add('on'); try { localStorage.setItem('zebra-chunk', b.dataset.v); } catch (_) {} };
  });
})();
$('btnCopyZpl').onclick = async () => {
  const zpl = buildZpl(await compose());
  try { await navigator.clipboard.writeText(zpl); toast(`ZPL copié (${Math.round(zpl.length / 1024)} Ko)`); }
  catch (_) { toast('Copie refusée par le navigateur', true); }
};
$('btnClear').onclick = () => { $('sheetBg').classList.remove('open'); wipeAll(); };
$('btnWipe').onclick = wipeAll;

// ---------- Démarrage ----------
if (!load()) state.blocks = starter();
syncTop();
renderBlocks();
renderPreview();
if (!('bluetooth' in navigator)) setConn('Bluefy requis');
document.fonts && document.fonts.ready.then(() => { syncTop(); changed(); });
log('Zebra Studio prêt.');
