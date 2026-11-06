/* Zebra Studio — moteur : rendu canvas 384 points, tramage, encodage ZPL ^GFA compressé */
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
const TPE_LIST_MIN = 1200;      // 15 cm minimum dès qu'il y a une liste (8 points/mm)

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

// ---------- Rendu : liste à cocher ----------
function listItems(b) {
  return (b.items || '').split('\n').map(s => s.trim()).filter(Boolean);
}
function renderListBlock(ctx, b, W, draw) {
  const family = FONTS[state.font].css;
  const base = SIZES[b.size] || SIZES.M;
  let y = 0;
  const title = fillVars(b.title || '').trim();
  if (title) {
    y += layoutRich(ctx, parseInline(title), 0, W, y, Math.round(base * 1.4), family, 'left', draw, true);
    y += 6;
    if (draw) { ctx.fillStyle = '#000'; ctx.fillRect(0, y, W, 3); }
    y += 3 + Math.round(base * 0.6);
  }
  const items = listItems(b);
  const box = Math.round(base * 0.82);
  const ind = box + Math.round(base * 0.55);
  items.forEach((raw, i) => {
    let text = fillVars(raw), done = false;
    const m = text.match(/^\[(x|X)\]\s*(.*)$/); if (m) { done = true; text = m[2]; }
    const h = layoutRich(ctx, parseInline(text), ind, W - ind, y, base, family, 'left', draw);
    if (draw) {
      const by = y + Math.round(base * 0.2);
      ctx.strokeStyle = '#000'; ctx.lineWidth = 2.5;
      if (b.box === 'round') { ctx.beginPath(); ctx.arc(1 + box / 2, by + box / 2, box / 2 - 1, 0, Math.PI * 2); ctx.stroke(); }
      else ctx.strokeRect(1.5, by, box - 1, box - 1);
      if (done) { ctx.beginPath(); ctx.lineWidth = 3; ctx.moveTo(5, by + box * 0.5); ctx.lineTo(box * 0.42, by + box - 5); ctx.lineTo(box - 3, by + 4); ctx.stroke(); }
    }
    y += Math.max(h, box) + (i < items.length - 1 ? Math.round(base * 0.5) : 0);
  });
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
    if (b.type === 'text') { if (!(b.text || '').trim()) continue; const h = renderTextBlock(meas, b, W, false); parts.push({ b, h }); }
    else if (b.type === 'list') { if (!listItems(b).length && !(b.title || '').trim()) continue; parts.push({ b, h: renderListBlock(meas, b, W, false) }); }
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
  strip._bounds = [];
  for (const p of parts) {
    const b = p.b;
    if (y > 0) strip._bounds.push(y - Math.round(BLOCK_GAP / 2));
    ctx.save(); ctx.translate(0, y);
    if (b.type === 'text') renderTextBlock(ctx, b, W, true);
    else if (b.type === 'list') renderListBlock(ctx, b, W, true);
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
function slice(strip, maxH, bounds) {
  const w = strip.width, H = strip.height;
  const data = strip.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, H).data;
  const cuts = []; let start = 0;
  while (H - start > maxH) {
    let cut = start + maxH;
    // d'abord entre deux blocs (sans couper une image ou une liste), sinon sur une ligne blanche
    const between = (bounds || []).filter(b => b > start + maxH * 0.35 && b <= start + maxH);
    if (between.length) { cuts.push([start, between[between.length - 1]]); start = between[between.length - 1]; continue; }
    for (let y = cut; y > start + maxH - 160 && y > start + 20; y--) { if (rowIsWhite(data, w, y)) { cut = y; break; } }
    cuts.push([start, cut]); start = cut;
  }
  cuts.push([start, H]);
  return cuts;
}
async function compose() {
  await ensureFonts();
  if (state.mode === 'dymo' && state.label && state.label.tpl !== 'free') {
    const r = composeLabel(state.label);
    const pages = [r.print]; pages.view = r.view; pages.fit = r.fit;
    return pages;
  }
  const g = contentGeometry();
  const strip = await composeStrip(g.W);
  const pages = [];
  if (state.mode === 'dymo') {
    for (const [a, z] of slice(strip, g.pageH, strip._bounds)) {
      const p = document.createElement('canvas'); p.width = PW; p.height = DYMO_H;
      const x = p.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, PW, DYMO_H);
      x.drawImage(strip, 0, a, g.W, z - a, g.x, g.y, g.W, z - a);
      if (state.frame) { x.strokeStyle = '#000'; x.lineWidth = 3; x.strokeRect(DYMO_INSET + 1.5, DYMO_INSET + 1.5, PW - DYMO_INSET * 2 - 3, DYMO_H - DYMO_INSET * 2 - 3); }
      threshold(p);
      pages.push(p);
    }
  } else {
    // une liste imprime toujours au moins 15 cm de papier (blanc ajouté en bas)
    const minH = state.blocks.some(b => b.type === 'list') ? TPE_LIST_MIN : 0;
    const p = document.createElement('canvas'); p.width = PW; p.height = Math.max(strip.height + TPE_MARGIN * 2, minH);
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

