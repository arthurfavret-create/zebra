/* Zebra Studio — composition et impression Bluetooth pour Zebra ZQ310
   Tout est dessiné sur un canvas de 384 points de large (203 dpi, 48 mm),
   converti en noir et blanc, puis envoyé en ZPL (^GFA compressé). */
'use strict';

// ---------- Constantes imprimante ----------
const PW = 384;                 // largeur imprimable en points
const TPE_MARGIN = 140;         // marge de déchirement haut et bas (≈ 17 mm)
const TPE_SIDE = 8;             // marge latérale sur ticket
const TPE_SEGMENT = 1600;       // hauteur max d'un format ZPL (on enchaîne plusieurs formats)
const DYMO_H = 807;             // hauteur étiquette 101 mm
const DYMO_LL = 848;            // pas 106 mm (étiquette + espace)
const DYMO_LH = 41;             // décalage de l'espace de 5 mm
const DYMO_INSET = 10;          // zone utile x 10..374, y 10..797
const BLOCK_GAP = 14;

const ZEBRA_SERVICE = '38eb4a80-c570-11e3-9507-0002a5d5c51b';
const ZEBRA_WRITE   = '38eb4a82-c570-11e3-9507-0002a5d5c51b';
const ZEBRA_READ    = '38eb4a81-c570-11e3-9507-0002a5d5c51b';

const FONTS = {
  sans:     { label: 'Sans (Helvetica)', css: '-apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif' },
  serif:    { label: 'Serif (Georgia)',  css: 'Georgia, "Times New Roman", serif' },
  mono:     { label: 'Ticket (Courier)', css: '"Courier New", Courier, monospace' },
  machine:  { label: 'Machine à écrire', css: '"Special Elite", "Courier New", monospace', web: 'Special Elite' },
  hand:     { label: 'Manuscrite',       css: '"Caveat", cursive', web: 'Caveat' },
  marker:   { label: 'Marqueur',         css: '"Permanent Marker", cursive', web: 'Permanent Marker' },
};
const SIZES = { S: 20, M: 25, L: 31, XL: 40 };

// ---------- État ----------
let state = {
  mode: 'tpe',
  font: 'sans',
  frame: true,
  copies: 1,
  blocks: [],
};
let nextId = 1;
const imageCache = new Map();   // id -> HTMLImageElement chargée
let lastPages = [];             // canvases de la dernière composition
let device = null, writeChar = null, printing = false;

const $ = id => document.getElementById(id);

// ---------- Journal / messages ----------
function log(m) {
  const t = new Date().toLocaleTimeString('fr-FR');
  const d = document.createElement('div'); d.textContent = `[${t}] ${m}`;
  $('log').appendChild(d); $('log').scrollTop = $('log').scrollHeight;
}
function msg(text, kind) { const el = $('msg'); el.textContent = text; el.className = kind || ''; log(text); }
window.addEventListener('error', e => log('Erreur JS : ' + e.message));
window.addEventListener('unhandledrejection', e => log('Erreur : ' + (e.reason && e.reason.message || e.reason)));

// ---------- Sauvegarde locale ----------
function save() {
  try { localStorage.setItem('zebra-studio', JSON.stringify(state)); } catch (_) { /* stockage plein ou indisponible */ }
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem('zebra-studio') || 'null');
    if (s && Array.isArray(s.blocks)) {
      state = Object.assign(state, s);
      state.blocks.forEach(b => { b.id = nextId++; });
      return true;
    }
  } catch (_) {}
  return false;
}
function defaultBlocks() {
  return [
    newBlock('text', { text: '# Bonjour\nÉcris ici en **Markdown** :\n\n- une liste\n- [ ] une case à cocher\n- [x] une case cochée\n\n> une citation\n\nImprimé le {date} à {heure}', size: 'M', align: 'left' }),
    newBlock('sep', { style: 'stars' }),
    newBlock('qr', { text: 'https://example.com', size: 'M', caption: '' }),
  ];
}
function newBlock(type, props) {
  const base = {
    text:  { text: '', size: 'M', align: 'left', font: '' },
    image: { src: '', render: 'photo', bright: 0, width: 100 },
    qr:    { text: '', size: 'M', caption: '' },
    sep:   { style: 'line' },
    space: { h: 40 },
  }[type];
  return Object.assign({ id: nextId++, type }, base, props || {});
}

// ---------- Rendu : texte Markdown ----------
function parseInline(s) {
  // **gras**, *italique* / _italique_, `code`
  const runs = [];
  const re = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`)/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) runs.push({ t: s.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith('**') || tok.startsWith('__')) runs.push({ t: tok.slice(2, -2), b: true });
    else if (tok.startsWith('`')) runs.push({ t: tok.slice(1, -1), mono: true });
    else runs.push({ t: tok.slice(1, -1), i: true });
    last = m.index + tok.length;
  }
  if (last < s.length) runs.push({ t: s.slice(last) });
  return runs;
}
function fontFor(run, size, family, forceBold) {
  const fam = run.mono ? FONTS.mono.css : family;
  return `${run.i ? 'italic ' : ''}${(run.b || forceBold) ? 'bold ' : ''}${size}px ${fam}`;
}
// Mise en page d'un paragraphe riche ; renvoie la hauteur utilisée
function layoutRich(ctx, runs, x, width, y, size, family, align, draw, forceBold) {
  const lineH = Math.round(size * 1.28);
  // découpe en mots en gardant le style
  const words = [];
  runs.forEach(r => {
    r.t.split(/(\s+)/).forEach(part => { if (part) words.push({ t: part, r, space: /^\s+$/.test(part) }); });
  });
  const lines = []; let cur = []; let curW = 0;
  const measure = w => { ctx.font = fontFor(w.r, size, family, forceBold); return ctx.measureText(w.t).width; };
  for (const w of words) {
    if (w.space) { if (cur.length) { const sw = measure(w); cur.push(Object.assign({}, w, { w: sw })); curW += sw; } continue; }
    let ww = measure(w);
    if (ww > width) { // mot trop long : coupe au caractère
      let chunk = '';
      for (const ch of w.t) {
        const test = chunk + ch; const tw = measure({ t: test, r: w.r });
        if (curW + tw > width && (chunk || cur.length)) {
          if (chunk) { cur.push({ t: chunk, r: w.r, w: measure({ t: chunk, r: w.r }) }); }
          lines.push(cur); cur = []; curW = 0; chunk = ch;
        } else chunk = test;
      }
      if (chunk) { const cw = measure({ t: chunk, r: w.r }); cur.push({ t: chunk, r: w.r, w: cw }); curW += cw; }
      continue;
    }
    if (curW + ww > width && cur.length) {
      while (cur.length && cur[cur.length - 1].space) { curW -= cur.pop().w; }
      lines.push(cur); cur = []; curW = 0;
    }
    cur.push(Object.assign({}, w, { w: ww })); curW += ww;
  }
  while (cur.length && cur[cur.length - 1].space) cur.pop();
  if (cur.length) lines.push(cur);
  if (!lines.length) lines.push([]);
  if (draw) {
    ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#000';
    lines.forEach((ln, i) => {
      const lw = ln.reduce((a, w) => a + w.w, 0);
      let cx = x + (align === 'center' ? (width - lw) / 2 : align === 'right' ? width - lw : 0);
      const by = y + i * lineH + Math.round(size * 0.95);
      ln.forEach(w => { ctx.font = fontFor(w.r, size, family, forceBold); if (!w.space) ctx.fillText(w.t, cx, by); cx += w.w; });
    });
  }
  return lines.length * lineH;
}
function fillVars(s) {
  const d = new Date();
  return s.replace(/\{date\}/gi, d.toLocaleDateString('fr-FR'))
          .replace(/\{heure\}/gi, d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }));
}
function renderTextBlock(ctx, b, W, draw) {
  const family = FONTS[b.font || state.font].css;
  const base = SIZES[b.size] || SIZES.M;
  const lines = fillVars(b.text || '').replace(/\r/g, '').split('\n');
  let y = 0;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if (!line.trim()) { y += Math.round(base * 0.55); continue; }
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      const sz = Math.round(base * [0, 1.75, 1.4, 1.15][m[1].length]);
      y += layoutRich(ctx, parseInline(m[2]), 0, W, y, sz, family, b.align, draw, true) + Math.round(base * 0.2);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      if (draw) { ctx.fillStyle = '#000'; ctx.fillRect(0, y + Math.round(base * 0.4), W, 2); }
      y += Math.round(base * 0.9); continue;
    }
    if ((m = line.match(/^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/))) {
      const box = Math.round(base * 0.72), ind = box + Math.round(base * 0.45);
      if (draw) {
        const by = y + Math.round(base * 0.22);
        ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.strokeRect(1, by, box, box);
        if (m[1] !== ' ') { ctx.beginPath(); ctx.lineWidth = 3; ctx.moveTo(4, by + box * 0.5); ctx.lineTo(box * 0.42, by + box - 4); ctx.lineTo(box - 2, by + 3); ctx.stroke(); }
      }
      y += layoutRich(ctx, parseInline(m[2]), ind, W - ind, y, base, family, 'left', draw) + 2;
      continue;
    }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/)) || (m = line.match(/^\s*(\d+[.)])\s+(.*)$/))) {
      const isNum = m.length === 3;
      const label = isNum ? m[1] : '•';
      const text = isNum ? m[2] : m[1];
      ctx.font = `bold ${base}px ${family}`;
      const ind = Math.round(Math.max(ctx.measureText(isNum ? '00.' : '•').width, base * 0.6) + base * 0.4);
      if (draw) { ctx.fillStyle = '#000'; ctx.fillText(label, 0, y + Math.round(base * 0.95)); }
      y += layoutRich(ctx, parseInline(text), ind, W - ind, y, base, family, 'left', draw) + 2;
      continue;
    }
    if ((m = line.match(/^>\s?(.*)$/))) {
      const h = layoutRich(ctx, parseInline(m[1]).map(r => Object.assign({}, r, { i: true })), 16, W - 16, y, base, family, b.align, draw);
      if (draw) { ctx.fillStyle = '#000'; ctx.fillRect(2, y + 2, 4, h - 4); }
      y += h + 2; continue;
    }
    y += layoutRich(ctx, parseInline(line), 0, W, y, base, family, b.align, draw);
  }
  return Math.max(y, 1);
}

// ---------- Rendu : images (tramage) ----------
function ditherInto(img, targetW, b) {
  const scale = targetW / img.naturalWidth;
  const w = Math.max(1, Math.round(targetW)), h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
  x.drawImage(img, 0, 0, w, h);
  const id = x.getImageData(0, 0, w, h), d = id.data;
  const g = new Float32Array(w * h);
  const bright = (b.bright || 0) * 1.6;
  for (let i = 0; i < w * h; i++) {
    const a = d[i * 4 + 3] / 255;
    const lum = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    g[i] = (lum * a + 255 * (1 - a)) + bright + 18; // +18 : la tête thermique fonce
  }
  if (b.render === 'photo') {
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const i = yy * w + xx, old = g[i], nv = old < 128 ? 0 : 255, err = old - nv; g[i] = nv;
      if (xx + 1 < w) g[i + 1] += err * 7 / 16;
      if (yy + 1 < h) { if (xx > 0) g[i + w - 1] += err * 3 / 16; g[i + w] += err * 5 / 16; if (xx + 1 < w) g[i + w + 1] += err / 16; }
    }
  } else {
    for (let i = 0; i < w * h; i++) g[i] = g[i] < 150 ? 0 : 255;
  }
  for (let i = 0; i < w * h; i++) { const v = g[i] < 128 ? 0 : 255; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
  x.putImageData(id, 0, 0);
  return c;
}
function getImage(b) {
  if (!b.src) return Promise.resolve(null);
  const hit = imageCache.get(b.src);
  if (hit) return Promise.resolve(hit);
  return new Promise(res => {
    const im = new Image();
    im.onload = () => { imageCache.set(b.src, im); res(im); };
    im.onerror = () => res(null);
    im.src = b.src;
  });
}

// ---------- Rendu : QR, séparateurs ----------
function qrCanvas(b) {
  const text = fillVars(b.text || '').trim();
  if (!text) return null;
  const qr = qrcode(0, 'M'); qr.addData(text, 'Byte'); qr.make();
  const n = qr.getModuleCount();
  const mod = { S: 3, M: 4, L: 6, XL: 8 }[b.size] || 4;
  const quiet = mod * 2;
  const c = document.createElement('canvas'); c.width = c.height = n * mod + quiet * 2;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (qr.isDark(r, col)) x.fillRect(quiet + col * mod, quiet + r * mod, mod, mod);
  return c;
}
function drawSep(ctx, style, W, y, draw) {
  const h = { line: 16, double: 20, dots: 16, dashes: 16, stars: 34, zigzag: 24, scissors: 30 }[style] || 16;
  if (!draw) return h;
  ctx.fillStyle = '#000'; ctx.strokeStyle = '#000';
  const mid = y + Math.round(h / 2);
  switch (style) {
    case 'double': ctx.fillRect(0, mid - 5, W, 2); ctx.fillRect(0, mid + 3, W, 2); break;
    case 'dots': for (let x = 3; x < W; x += 12) { ctx.beginPath(); ctx.arc(x, mid, 2.2, 0, Math.PI * 2); ctx.fill(); } break;
    case 'dashes': for (let x = 0; x < W; x += 18) ctx.fillRect(x, mid - 1, 10, 3); break;
    case 'stars': ctx.font = `bold 24px ${FONTS.serif.css}`; ctx.textAlign = 'center'; ctx.fillText('✦   ✦   ✦', W / 2, mid + 9); ctx.textAlign = 'left'; break;
    case 'zigzag': ctx.lineWidth = 2; ctx.beginPath(); for (let x = 0, up = true; x <= W; x += 10, up = !up) ctx.lineTo(x, mid + (up ? -6 : 6)); ctx.stroke(); break;
    case 'scissors':
      for (let x = 30; x < W; x += 14) ctx.fillRect(x, mid - 1, 8, 2);
      ctx.font = `22px ${FONTS.sans.css}`; ctx.fillText('✂', 0, mid + 8); break;
    default: ctx.fillRect(0, mid - 1, W, 2);
  }
  return h;
}

// ---------- Composition ----------
function contentGeometry() {
  if (state.mode === 'dymo') {
    const inset = state.frame ? DYMO_INSET + 14 : DYMO_INSET;
    return { W: PW - inset * 2, x: inset, pageH: DYMO_H - inset * 2, y: inset };
  }
  return { W: PW - TPE_SIDE * 2, x: TPE_SIDE };
}
async function ensureFonts() {
  const used = new Set([state.font]); state.blocks.forEach(b => { if (b.font) used.add(b.font); });
  const loads = [];
  used.forEach(k => { const f = FONTS[k]; if (f && f.web) { loads.push(document.fonts.load(`20px "${f.web}"`)); loads.push(document.fonts.load(`bold 20px "${f.web}"`)); } });
  try { await Promise.race([Promise.all(loads), new Promise(r => setTimeout(r, 2500))]); } catch (_) {}
}
// Dessine tous les blocs sur une longue bande de largeur W
async function composeStrip(W) {
  const meas = document.createElement('canvas').getContext('2d');
  const parts = [];
  for (const b of state.blocks) {
    if (b.type === 'text') { const h = renderTextBlock(meas, b, W, false); parts.push({ b, h }); }
    else if (b.type === 'image') {
      const im = await getImage(b); if (!im) continue;
      const c = ditherInto(im, W * (b.width || 100) / 100, b); parts.push({ b, h: c.height, c });
    }
    else if (b.type === 'qr') {
      const c = qrCanvas(b); if (!c) continue;
      let h = c.height;
      if (b.caption) h += layoutRich(meas, parseInline(fillVars(b.caption)), 0, W, 0, SIZES.S, FONTS[state.font].css, 'center', false) + 4;
      parts.push({ b, h, c });
    }
    else if (b.type === 'sep') parts.push({ b, h: drawSep(meas, b.style, W, 0, false) });
    else if (b.type === 'space') parts.push({ b, h: Math.max(4, +b.h || 40) });
  }
  const total = parts.reduce((a, p) => a + p.h, 0) + Math.max(0, parts.length - 1) * BLOCK_GAP;
  const strip = document.createElement('canvas'); strip.width = W; strip.height = Math.max(1, total);
  const ctx = strip.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, strip.height);
  let y = 0;
  for (const p of parts) {
    const b = p.b;
    ctx.save(); ctx.translate(0, y);
    if (b.type === 'text') renderTextBlock(ctx, b, W, true);
    else if (b.type === 'image') ctx.drawImage(p.c, Math.round((W - p.c.width) / 2), 0);
    else if (b.type === 'qr') {
      ctx.drawImage(p.c, Math.round((W - p.c.width) / 2), 0);
      if (b.caption) layoutRich(ctx, parseInline(fillVars(b.caption)), 0, W, p.c.height + 4, SIZES.S, FONTS[state.font].css, 'center', true);
    }
    else if (b.type === 'sep') drawSep(ctx, b.style, W, 0, true);
    ctx.restore();
    y += p.h + BLOCK_GAP;
  }
  threshold(strip);
  return strip;
}
function threshold(c) {
  const x = c.getContext('2d', { willReadFrequently: true });
  const id = x.getImageData(0, 0, c.width, c.height), d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) < 150 ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  x.putImageData(id, 0, 0);
}
function rowIsWhite(data, w, y) {
  for (let x = 0; x < w; x++) if (data[(y * w + x) * 4] < 128) return false;
  return true;
}
// Coupe la bande en morceaux de hauteur max, en cherchant une ligne blanche
function slice(strip, maxH) {
  const w = strip.width, H = strip.height;
  const data = strip.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, H).data;
  const cuts = []; let start = 0;
  while (H - start > maxH) {
    let cut = start + maxH;
    for (let y = cut; y > start + maxH - 160 && y > start + 20; y--) { if (rowIsWhite(data, w, y)) { cut = y; break; } }
    cuts.push([start, cut]); start = cut;
  }
  cuts.push([start, H]);
  return cuts;
}
async function compose() {
  await ensureFonts();
  const g = contentGeometry();
  const strip = await composeStrip(g.W);
  const pages = [];
  if (state.mode === 'dymo') {
    for (const [a, z] of slice(strip, g.pageH)) {
      const p = document.createElement('canvas'); p.width = PW; p.height = DYMO_H;
      const x = p.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, PW, DYMO_H);
      x.drawImage(strip, 0, a, g.W, z - a, g.x, g.y, g.W, z - a);
      if (state.frame) { x.strokeStyle = '#000'; x.lineWidth = 3; x.strokeRect(DYMO_INSET + 1.5, DYMO_INSET + 1.5, PW - DYMO_INSET * 2 - 3, DYMO_H - DYMO_INSET * 2 - 3); }
      threshold(p);
      pages.push(p);
    }
  } else {
    const p = document.createElement('canvas'); p.width = PW; p.height = strip.height + TPE_MARGIN * 2;
    const x = p.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, PW, p.height);
    x.drawImage(strip, g.x, TPE_MARGIN);
    pages.push(p);
  }
  return pages;
}

// ---------- Encodage ZPL ----------
const HEX = '0123456789ABCDEF';
function repeatCode(n) { // compression ASCII Zebra : G..Y = 1..19, g..z = 20..400
  let s = '';
  while (n > 400) { s += 'z'; n -= 400; }
  if (n >= 20) { s += String.fromCharCode('g'.charCodeAt(0) + Math.floor(n / 20) - 1); n %= 20; }
  if (n > 0) s += String.fromCharCode('G'.charCodeAt(0) + n - 1);
  return s;
}
function compressRow(hex) {
  // fin de ligne en zéros -> ','
  let end = hex.length; while (end > 0 && hex[end - 1] === '0') end--;
  if (end === 0) return ',';
  let out = '';
  for (let i = 0; i < end;) {
    let j = i; while (j < end && hex[j] === hex[i]) j++;
    const n = j - i;
    out += (n > 1 ? repeatCode(n) : '') + hex[i];
    i = j;
  }
  if (end < hex.length) out += (hex.length - end > 1 ? ',' : '0');
  return out;
}
function canvasToGFA(c, y0, y1) {
  const w = c.width, bpr = Math.ceil(w / 8), h = y1 - y0;
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, y0, w, h).data;
  let out = '', prev = null, black = 0;
  for (let y = 0; y < h; y++) {
    let hex = '';
    for (let bx = 0; bx < bpr; bx++) {
      let byte = 0;
      for (let k = 0; k < 8; k++) {
        const x = bx * 8 + k;
        if (x < w && d[(y * w + x) * 4] < 128) { byte |= 0x80 >> k; black++; }
      }
      hex += HEX[byte >> 4] + HEX[byte & 15];
    }
    out += (hex === prev) ? ':' : compressRow(hex);
    prev = hex;
  }
  const total = bpr * h;
  return { zpl: `^GFA,${total},${total},${bpr},${out}`, black, pixels: w * h };
}
function buildZpl(pages) {
  const parts = [];
  if (state.mode === 'dymo') {
    pages.forEach(p => {
      const g = canvasToGFA(p, 0, p.height);
      parts.push(`^XA\n^CI28\n^MNN\n^PW${PW}\n^LL${DYMO_LL}\n^LH0,${DYMO_LH}\n^FO0,0${g.zpl}^FS\n^PQ1\n^XZ`);
    });
  } else {
    const p = pages[0];
    const segs = slice(p, TPE_SEGMENT);
    segs.forEach(([a, z]) => {
      const g = canvasToGFA(p, a, z);
      parts.push(`^XA\n^MNN\n^PW${PW}\n^LL${z - a}\n^LH0,0\n^FO0,0${g.zpl}^FS\n^XZ`);
    });
  }
  const one = parts.join('\n');
  const copies = Math.max(1, Math.min(20, +state.copies || 1));
  return Array(copies).fill(one).join('\n') + '\n';
}

// ---------- Aperçu ----------
let renderTimer = null, renderSeq = 0;
function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(renderPreview, 250); }
async function renderPreview() {
  const seq = ++renderSeq;
  const pages = await compose();
  if (seq !== renderSeq) return;
  lastPages = pages;
  const pv = $('preview'); pv.innerHTML = '';
  pages.forEach(p => pv.appendChild(p));
  // infos
  let black = 0, px = 0;
  pages.forEach(p => { const d = p.getContext('2d').getImageData(0, 0, p.width, p.height).data; for (let i = 0; i < d.length; i += 16) { px++; if (d[i] < 128) black++; } });
  const ratio = px ? black / px : 0;
  let info;
  if (state.mode === 'dymo') info = `${pages.length} étiquette${pages.length > 1 ? 's' : ''} DYMO 54 × 101 mm`;
  else info = `Ticket de ${(pages[0].height / 80).toFixed(1).replace('.', ',')} cm (marges de déchirement comprises)`;
  const c = Math.max(1, +state.copies || 1); if (c > 1) info += ` · ${c} copies`;
  const el = $('pinfo');
  if (ratio > 0.3) { info += ' · Beaucoup de noir : impression lente et batterie sollicitée, pense à éclaircir.'; el.className = 'pinfo warn'; }
  else el.className = 'pinfo';
  el.textContent = info;
}

// ---------- Interface : blocs ----------
const LABELS = { text: 'Texte', image: 'Image', qr: 'QR code', sep: 'Séparateur', space: 'Espace' };
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const k in attrs || {}) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
    else if (k === 'checked') e.checked = attrs[k];
    else if (k === 'value') e.value = attrs[k];
    else e.setAttribute(k, attrs[k]);
  }
  kids.flat().forEach(c => e.append(c instanceof Node ? c : document.createTextNode(c)));
  return e;
}
function select(value, options, onchange) {
  const s = el('select', { onchange: e => onchange(e.target.value) });
  options.forEach(([v, l]) => { const o = el('option', { value: v }, l); if (v === value) o.selected = true; s.append(o); });
  return s;
}
function changed() { save(); scheduleRender(); }
function update(b, key, val) { b[key] = val; changed(); }
function renderBlocks() {
  const wrap = $('blocks'); wrap.innerHTML = '';
  if (!state.blocks.length) wrap.append(el('div', { class: 'empty' }, 'Ajoute un bloc ou importe un fichier pour commencer.'));
  state.blocks.forEach((b, i) => {
    const head = el('div', { class: 'block-head' },
      el('strong', {}, LABELS[b.type]),
      el('button', { class: 'icon-btn', title: 'Monter', onclick: () => move(i, -1) }, '↑'),
      el('button', { class: 'icon-btn', title: 'Descendre', onclick: () => move(i, 1) }, '↓'),
      el('button', { class: 'icon-btn', title: 'Supprimer', onclick: () => { state.blocks.splice(i, 1); renderBlocks(); changed(); } }, '✕'));
    const body = el('div', { class: 'block-body' });
    if (b.type === 'text') {
      body.append(el('textarea', { value: b.text, placeholder: '# Titre\nTexte, **gras**, *italique*\n- liste\n- [ ] case à cocher', oninput: e => update(b, 'text', e.target.value) }));
      body.append(el('div', { class: 'opts' },
        el('label', {}, 'Taille', select(b.size, [['S', 'Petit'], ['M', 'Moyen'], ['L', 'Grand'], ['XL', 'Très grand']], v => update(b, 'size', v))),
        el('label', {}, 'Alignement', select(b.align, [['left', 'Gauche'], ['center', 'Centré'], ['right', 'Droite']], v => update(b, 'align', v))),
        el('label', {}, 'Police', select(b.font, [['', 'Par défaut'], ...Object.entries(FONTS).map(([k, f]) => [k, f.label])], v => update(b, 'font', v)))));
    } else if (b.type === 'image') {
      body.append(el('div', { class: 'opts' },
        el('label', {}, 'Rendu', select(b.render, [['photo', 'Photo (tramée)'], ['net', 'Dessin / texte (net)']], v => update(b, 'render', v))),
        el('label', {}, 'Luminosité', el('input', { type: 'range', min: -60, max: 60, value: b.bright, oninput: e => update(b, 'bright', +e.target.value) })),
        el('label', {}, 'Largeur', el('input', { type: 'range', min: 30, max: 100, step: 5, value: b.width, oninput: e => update(b, 'width', +e.target.value) })),
        el('button', { class: 'btn ghost small', onclick: () => pickImageFor(b) }, b.src ? 'Changer' : 'Choisir une image')));
    } else if (b.type === 'qr') {
      body.append(el('div', { class: 'opts' },
        el('label', { style: 'flex:1; min-width:200px' }, 'Contenu', el('input', { type: 'text', value: b.text, style: 'flex:1', placeholder: 'lien, texte, Wi-Fi…', oninput: e => update(b, 'text', e.target.value) })),
        el('label', {}, 'Taille', select(b.size, [['S', 'Petit'], ['M', 'Moyen'], ['L', 'Grand'], ['XL', 'Très grand']], v => update(b, 'size', v))),
        el('label', { style: 'flex:1; min-width:200px' }, 'Légende', el('input', { type: 'text', value: b.caption, style: 'flex:1', placeholder: 'facultatif', oninput: e => update(b, 'caption', e.target.value) }))));
      body.append(el('p', { class: 'hint' }, 'Garde un contenu court : plus il est long, plus le QR est dense et difficile à scanner.'));
    } else if (b.type === 'sep') {
      body.append(el('div', { class: 'opts' }, el('label', {}, 'Style', select(b.style, [
        ['line', 'Trait'], ['double', 'Double trait'], ['dashes', 'Tirets'], ['dots', 'Pointillés'], ['zigzag', 'Zigzag'], ['stars', 'Étoiles'], ['scissors', 'Découpe ✂']], v => update(b, 'style', v)))));
    } else if (b.type === 'space') {
      body.append(el('div', { class: 'opts' }, el('label', {}, 'Hauteur', el('input', { type: 'range', min: 10, max: 300, step: 10, value: b.h, oninput: e => update(b, 'h', +e.target.value) }))));
    }
    wrap.append(el('div', { class: 'block' }, head, body));
  });
}
function move(i, d) {
  const j = i + d; if (j < 0 || j >= state.blocks.length) return;
  const [b] = state.blocks.splice(i, 1); state.blocks.splice(j, 0, b);
  renderBlocks(); changed();
}
function addBlock(type, props) {
  const b = newBlock(type, props); state.blocks.push(b); renderBlocks(); changed();
  return b;
}

// ---------- Import de fichiers ----------
function readAs(file, how) {
  return new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error);
    how === 'text' ? r.readAsText(file) : how === 'buffer' ? r.readAsArrayBuffer(file) : r.readAsDataURL(file);
  });
}
// Réduit une image à 768 px de large max (stockage léger, rendu net)
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
async function pdfToImages(file) {
  const lib = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
  if (!lib) throw new Error('lecteur PDF indisponible');
  lib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
  const pdf = await lib.getDocument({ data: await readAs(file, 'buffer') }).promise;
  const n = Math.min(pdf.numPages, 10);
  if (pdf.numPages > 10) msg(`PDF de ${pdf.numPages} pages : seules les 10 premières sont importées.`);
  const out = [];
  for (let i = 1; i <= n; i++) {
    const page = await pdf.getPage(i);
    const v0 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 768 / v0.width });
    const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: x, viewport: vp }).promise;
    out.push(c.toDataURL('image/jpeg', 0.9));
  }
  return out;
}
function kindOf(file) {
  const n = (file.name || '').toLowerCase();
  if (/\.(md|markdown|mdown|txt|text)$/.test(n) || /^text\//.test(file.type)) return 'text';
  if (/\.pdf$/.test(n) || file.type === 'application/pdf') return 'pdf';
  if (/^image\//.test(file.type) || /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/.test(n)) return 'image';
  return null;
}
async function importFiles(files, targetBlock) {
  for (const f of files) {
    const k = kindOf(f);
    try {
      if (k === 'text') {
        const txt = await readAs(f, 'text');
        addBlock('text', { text: txt });
        msg(`« ${f.name} » importé.`, 'ok');
      } else if (k === 'image') {
        const src = await shrinkDataUrl(await readAs(f, 'dataurl'), 768);
        if (!src) throw new Error('format d\'image non lu par l\'iPad');
        if (targetBlock) { targetBlock.src = src; renderBlocks(); changed(); targetBlock = null; }
        else addBlock('image', { src, render: /\.png$/i.test(f.name) ? 'net' : 'photo' });
        msg(`Image « ${f.name} » ajoutée.`, 'ok');
      } else if (k === 'pdf') {
        msg(`Lecture du PDF « ${f.name} »…`);
        const imgs = await pdfToImages(f);
        imgs.forEach((src, i) => {
          if (i === 0 && targetBlock) { targetBlock.src = src; targetBlock.render = 'net'; targetBlock = null; }
          else state.blocks.push(newBlock('image', { src, render: 'net' }));
        });
        renderBlocks(); changed();
        msg(`PDF importé : ${imgs.length} page${imgs.length > 1 ? 's' : ''}.`, 'ok');
      } else {
        msg(`« ${f.name} » : format non pris en charge (Markdown, texte, image ou PDF).`, 'err');
      }
    } catch (e) { msg(`Échec d'import de « ${f.name} » : ${e.message || e}`, 'err'); }
  }
}
let imageTarget = null;
function pickImageFor(b) { imageTarget = b; $('fileImage').value = ''; $('fileImage').click(); }
$('fileImage').addEventListener('change', e => { const t = imageTarget; imageTarget = null; importFiles([...e.target.files], t); });
$('fileAny').addEventListener('change', e => importFiles([...e.target.files]));
$('btnImport').onclick = () => { $('fileAny').value = ''; $('fileAny').click(); };

// ---------- Bluetooth ----------
function setState(text, kind) { $('state').textContent = text; $('dot').className = 'dot' + (kind ? ' ' + kind : ''); }
function withTimeout(p, ms, label) { return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('délai dépassé (' + label + ')')), ms))]); }
async function connect() {
  if (!('bluetooth' in navigator)) { msg('Bluetooth indisponible : ouvre cette page dans Bluefy.', 'err'); setState('Bluetooth absent', 'err'); return false; }
  try {
    setState('Recherche…');
    device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [ZEBRA_SERVICE] });
    device.addEventListener('gattserverdisconnected', () => { writeChar = null; setState('Déconnectée'); $('btnConnect').textContent = 'Connecter'; log('Imprimante déconnectée.'); });
    setState('Connexion…');
    const server = await withTimeout(device.gatt.connect(), 15000, 'connexion');
    const service = await withTimeout(server.getPrimaryService(ZEBRA_SERVICE), 10000, 'service Zebra');
    writeChar = await withTimeout(service.getCharacteristic(ZEBRA_WRITE), 10000, 'canal d\'écriture');
    try {
      const rc = await service.getCharacteristic(ZEBRA_READ); await rc.startNotifications();
      rc.addEventListener('characteristicvaluechanged', e => log('Imprimante : ' + new TextDecoder().decode(e.target.value).trim()));
    } catch (_) {}
    setState(device.name || 'Zebra', 'on'); $('btnConnect').textContent = 'Reconnecter';
    msg('Imprimante connectée.', 'ok');
    return true;
  } catch (e) {
    setState('Non connectée', 'err');
    if (e.name !== 'NotFoundError') msg('Connexion impossible : ' + (e.message || e), 'err'); else msg('Aucune imprimante choisie.');
    return false;
  }
}
async function reconnectIfNeeded() {
  if (writeChar && device && device.gatt.connected) return true;
  if (device) {
    try {
      const server = await withTimeout(device.gatt.connect(), 10000, 'reconnexion');
      const service = await server.getPrimaryService(ZEBRA_SERVICE);
      writeChar = await service.getCharacteristic(ZEBRA_WRITE);
      setState(device.name || 'Zebra', 'on'); return true;
    } catch (_) {}
  }
  return connect();
}
async function send(text) {
  const data = new TextEncoder().encode(text);
  const size = parseInt($('chunk').value, 10);
  const bar = $('progress'), fill = bar.firstElementChild; bar.style.display = 'block'; fill.style.width = '0%';
  const t0 = performance.now();
  try {
    for (let i = 0; i < data.length; i += size) {
      const part = data.slice(i, i + size);
      if (writeChar.writeValueWithResponse) await writeChar.writeValueWithResponse(part); else await writeChar.writeValue(part);
      if ((i / size) % 10 === 0) fill.style.width = Math.round(100 * i / data.length) + '%';
    }
    fill.style.width = '100%';
    log(`${data.length} octets envoyés en ${((performance.now() - t0) / 1000).toFixed(1)} s.`);
  } finally { setTimeout(() => { bar.style.display = 'none'; }, 800); }
}
$('btnConnect').onclick = connect;
$('btnPrint').onclick = async () => {
  if (printing) return;
  if (!state.blocks.length) { msg('Rien à imprimer.', 'err'); return; }
  printing = true; $('btnPrint').disabled = true;
  try {
    msg('Préparation…');
    const pages = await compose();
    const zpl = buildZpl(pages);
    if (!(await reconnectIfNeeded())) return;
    msg(`Envoi à l'imprimante (${Math.round(zpl.length / 1024)} Ko)…`);
    await send(zpl);
    msg(state.mode === 'dymo' ? 'Envoyé. Cale bien le début de l\'étiquette sous la tête avant chaque impression.' : 'Envoyé. Bonne impression !', 'ok');
  } catch (e) {
    msg('Échec d\'impression : ' + (e.message || e) + '. Essaie des paquets plus petits (réglages avancés).', 'err');
  } finally { printing = false; $('btnPrint').disabled = false; }
};
$('btnCopyZpl').onclick = async () => {
  const zpl = buildZpl(await compose());
  try { await navigator.clipboard.writeText(zpl); msg(`ZPL copié (${Math.round(zpl.length / 1024)} Ko).`, 'ok'); }
  catch (_) { msg('Copie refusée par le navigateur.', 'err'); }
};

// ---------- Réglages globaux ----------
function syncGlobals() {
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('active', b.dataset.mode === state.mode));
  $('frameWrap').style.display = state.mode === 'dymo' ? '' : 'none';
  $('gFrame').checked = !!state.frame;
  $('gCopies').value = state.copies;
}
document.querySelectorAll('#modeSeg button').forEach(b => b.onclick = () => { state.mode = b.dataset.mode; syncGlobals(); changed(); });
Object.entries(FONTS).forEach(([k, f]) => $('gFont').append(el('option', { value: k }, f.label)));
$('gFont').onchange = e => { state.font = e.target.value; changed(); };
$('gFrame').onchange = e => { state.frame = e.target.checked; changed(); };
$('gCopies').oninput = e => { state.copies = Math.max(1, Math.min(20, +e.target.value || 1)); changed(); };
document.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
  const t = b.dataset.add;
  if (t === 'image') { const nb = addBlock('image'); pickImageFor(nb); }
  else addBlock(t, t === 'text' ? { text: '' } : t === 'qr' ? { text: '' } : {});
});
$('btnClear').onclick = () => {
  if ($('btnClear').dataset.armed) { state.blocks = []; delete $('btnClear').dataset.armed; $('btnClear').textContent = 'Tout effacer'; renderBlocks(); changed(); return; }
  $('btnClear').dataset.armed = '1'; $('btnClear').textContent = 'Confirmer ?';
  setTimeout(() => { delete $('btnClear').dataset.armed; $('btnClear').textContent = 'Tout effacer'; }, 3000);
};
try { const c = localStorage.getItem('zebra-chunk'); if (c) $('chunk').value = c; } catch (_) {}
$('chunk').onchange = e => { try { localStorage.setItem('zebra-chunk', e.target.value); } catch (_) {} };

// ---------- Démarrage ----------
if (!load()) state.blocks = defaultBlocks();
$('gFont').value = state.font;
syncGlobals();
renderBlocks();
renderPreview();
if (!('bluetooth' in navigator)) setState('Ouvre dans Bluefy pour imprimer');
log('Zebra Studio prêt.');
