/* Zebra Studio — étiquettes DYMO 54 × 101 mm : modèles, ajustement automatique, cadres, orientation */
'use strict';

const LABEL_ICONS = ['', '★', '♥', '✿', '☘', '❄', '☀', '☕', '♫', '✈', '⌂', '✉', '♻', '⚠', '⚡', '✂', '☺', '✓'];
const LABEL_FRAMES = ['none', 'simple', 'double', 'round', 'dashed', 'corners'];

const LABEL_TPLS = {
  bocal:     { name: 'Bocal',     orient: 'land', frame: 'round',   upper: false, align: 'center', icon: '',  qrOn: false,
               ex: { title: 'Farine', subtitle: 'T65 · bio', detail: 'Rempli le {date}' } },
  carton:    { name: 'Carton',    orient: 'land', frame: 'double',  upper: true,  align: 'center', icon: '',  qrOn: false,
               ex: { title: 'Cuisine', subtitle: 'Fragile · verres', detail: 'Carton n° 3' } },
  nom:       { name: 'Prénom',    orient: 'land', frame: 'none',    upper: false, align: 'center', icon: '',  qrOn: false,
               ex: { title: 'Léa', subtitle: '', detail: '' } },
  rangement: { name: 'Rangement', orient: 'port', frame: 'corners', upper: true,  align: 'center', icon: '★', qrOn: false,
               ex: { title: 'Câbles', subtitle: 'USB-C · HDMI', detail: '' } },
  photo:     { name: 'Photo',     orient: 'land', frame: 'round',   upper: false, align: 'center', icon: '',  qrOn: false, photoPos: 'left',
               ex: { title: 'Souvenir', subtitle: 'Été 2026', detail: '' } },
  qr:        { name: 'QR code',   orient: 'port', frame: 'simple',  upper: false, align: 'center', icon: '',  qrOn: true,
               ex: { title: 'Wi-Fi', subtitle: 'Scanne-moi', detail: '', qr: 'WIFI:T:WPA;S:MaBox;P:motdepasse;;' } },
};

function defaultLabel() {
  const t = LABEL_TPLS.bocal;
  return { tpl: 'bocal', orient: t.orient, frame: t.frame, upper: t.upper, align: t.align, icon: t.icon, qrOn: t.qrOn, flip: false,
           title: t.ex.title, subtitle: t.ex.subtitle, detail: t.ex.detail, qr: '',
           photo: '', photoPos: '', photoFit: 'contain', photoRender: 'photo', photoBright: 0 };
}

// Dessin utilisé comme icône : rogné sur ses traits, chargé une fois
const labelDrawCache = { src: null, img: null };
function labelDrawImage(L) {
  if (!L.drawing) return null;
  if (labelDrawCache.src === L.drawing) return labelDrawCache.img;
  labelDrawCache.src = L.drawing; labelDrawCache.img = null;
  const im = new Image();
  im.onload = () => { if (labelDrawCache.src === L.drawing) { labelDrawCache.img = trimWhite(im); if (typeof changed === 'function') changed(); if (typeof renderLabelEditor === 'function' && state.mode === 'dymo') renderLabelEditor(); } };
  im.src = L.drawing;
  return null;
}

// Photo de l'étiquette : chargée une fois, puis recadrée et tramée à la taille de sa zone
const labelPhotoCache = { src: null, img: null };
function labelPhotoImage(L) {
  if (!L.photo) return null;
  if (labelPhotoCache.src === L.photo) return labelPhotoCache.img;
  labelPhotoCache.src = L.photo; labelPhotoCache.img = null;
  const im = new Image();
  im.onload = () => { if (labelPhotoCache.src === L.photo) { labelPhotoCache.img = im; if (typeof changed === 'function') changed(); } };
  im.src = L.photo;
  return null;
}
function photoBox(img, bw, bh, L) {
  bw = Math.max(1, Math.round(bw)); bh = Math.max(1, Math.round(bh));
  const c = document.createElement('canvas'); c.width = bw; c.height = bh;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, bw, bh);
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const k = L.photoFit === 'cover' ? Math.max(bw / iw, bh / ih) : Math.min(bw / iw, bh / ih);
  const dw = iw * k, dh = ih * k;
  x.drawImage(img, (bw - dw) / 2, (bh - dh) / 2, dw, dh);
  return ditherInto(c, bw, { render: L.photoRender || 'photo', bright: L.photoBright || 0 });
}
function photoPlaceholder(ctx, x, y, w, h) {
  toneFill(ctx, x, y, w, h, 0.12);
  ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.setLineDash([8, 6]); ctx.strokeRect(x + 1, y + 1, w - 2, h - 2); ctx.setLineDash([]);
  // petite montagne + soleil
  const cx = x + w / 2, cy = y + h / 2, s = Math.min(w, h) * 0.22;
  ctx.fillStyle = '#000'; ctx.beginPath(); ctx.moveTo(cx - s * 1.4, cy + s * 0.7); ctx.lineTo(cx - s * 0.3, cy - s * 0.5); ctx.lineTo(cx + s * 0.3, cy + s * 0.1); ctx.lineTo(cx + s * 0.7, cy - s * 0.2); ctx.lineTo(cx + s * 1.4, cy + s * 0.7); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + s * 0.8, cy - s * 0.8, s * 0.28, 0, Math.PI * 2); ctx.fill();
}

// ---------- Cadres ----------
function drawFrame(ctx, style, W, H) {
  const i = DYMO_INSET;
  ctx.strokeStyle = '#000'; ctx.fillStyle = '#000'; ctx.setLineDash([]);
  const rect = (x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); ctx.stroke(); };
  switch (style) {
    case 'simple': ctx.lineWidth = 3; rect(i + 1.5, i + 1.5, W - 2 * i - 3, H - 2 * i - 3, 0); break;
    case 'double': ctx.lineWidth = 4; rect(i + 2, i + 2, W - 2 * i - 4, H - 2 * i - 4, 0);
                   ctx.lineWidth = 1.5; rect(i + 10, i + 10, W - 2 * i - 20, H - 2 * i - 20, 0); break;
    case 'round':  ctx.lineWidth = 4; rect(i + 2, i + 2, W - 2 * i - 4, H - 2 * i - 4, 26); break;
    case 'dashed': ctx.lineWidth = 3; ctx.setLineDash([14, 9]); rect(i + 1.5, i + 1.5, W - 2 * i - 3, H - 2 * i - 3, 12); ctx.setLineDash([]); break;
    case 'corners': {
      const L = Math.min(46, Math.min(W, H) / 4), t = 5, x0 = i, y0 = i, x1 = W - i, y1 = H - i;
      [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]].forEach(([x, y, dx, dy]) => {
        ctx.fillRect(dx > 0 ? x : x - L, dy > 0 ? y : y - t, L, t);
        ctx.fillRect(dx > 0 ? x : x - t, dy > 0 ? y : y - L, t, L);
      });
      break;
    }
  }
}

// ---------- Mise en page automatique ----------
function labelTexts(L) {
  const up = s => (L.upper ? s.toLocaleUpperCase('fr-FR') : s);
  return {
    title: up(fillVars(L.title || '').trim()),
    subtitle: fillVars(L.subtitle || '').trim(),
    detail: fillVars(L.detail || '').trim(),
  };
}
function longestWord(ctx, text, font) {
  ctx.font = font; let m = 0;
  text.split(/\s+/).forEach(w => { m = Math.max(m, ctx.measureText(w).width); });
  return m;
}
// Hauteur de la pile (icône, titre, sous-titre, détail) pour une taille de titre s
function stackFor(ctx, T, L, s, Wt, family) {
  const sub = Math.max(17, Math.round(s * 0.42)), det = Math.max(15, Math.round(s * 0.3));
  const gap = Math.round(Math.max(6, s * 0.16));
  const items = [];
  if (L.icon === 'draw' && L.drawing) items.push({ kind: 'drawing', h: Math.round(s * 1.6) });
  else if (L.icon && L.icon !== 'draw') items.push({ kind: 'icon', h: Math.round(s * 1.05), size: Math.round(s * 0.95) });
  if (T.title) items.push({ kind: 'title', size: s, h: layoutRich(ctx, parseInline(T.title), 0, Wt, 0, s, family, L.align, false, true) });
  if (T.subtitle) items.push({ kind: 'subtitle', size: sub, h: layoutRich(ctx, parseInline(T.subtitle), 0, Wt, 0, sub, family, L.align, false) });
  if (T.detail) items.push({ kind: 'detail', size: det, h: layoutRich(ctx, parseInline(T.detail), 0, Wt, 0, det, family, L.align, false) });
  const total = items.reduce((a, it) => a + it.h, 0) + Math.max(0, items.length - 1) * gap;
  const titleLines = T.title ? Math.round(items.find(i => i.kind === 'title').h / Math.round(s * 1.28)) : 0;
  return { items, total, gap, titleLines, sub, det };
}
function fitStack(ctx, T, L, Wt, Ht, family) {
  let lo = 12, hi = Math.min(260, Math.round(Ht)), best = null;
  while (lo <= hi) {
    const s = (lo + hi) >> 1;
    const st = stackFor(ctx, T, L, s, Wt, family);
    const wordOk = !T.title || longestWord(ctx, T.title, `bold ${s}px ${family}`) <= Wt;
    const subOk = !T.subtitle || longestWord(ctx, T.subtitle, `${st.sub}px ${family}`) <= Wt;
    if (st.total <= Ht && wordOk && subOk && st.titleLines <= 3) { best = { s, st }; lo = s + 1; }
    else hi = s - 1;
  }
  if (!best) best = { s: 12, st: stackFor(ctx, T, L, 12, Wt, family) };
  return best;
}

// ---------- Rendu d'une étiquette ----------
function composeLabel(L, opts) {
  opts = opts || {};
  const land = L.orient === 'land';
  const d = labelDims();
  const W = land ? d.hD : d.wD, H = land ? d.wD : d.hD;
  const view = document.createElement('canvas'); view.width = W; view.height = H;
  const ctx = view.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  const family = FONTS[fontKey(state.font)].css;
  const T = labelTexts(L);
  drawFrame(ctx, L.frame, W, H);

  const small = Math.min(W, H) < 240;
  const pad = DYMO_INSET + (L.frame === 'none' ? (small ? 6 : 12) : L.frame === 'double' ? (small ? 18 : 26) : (small ? 14 : 22));
  let ax = pad, ay = pad, aw = W - 2 * pad, ah = H - 2 * pad;

  // QR : à droite si couchée, en bas si debout
  let qr = null;
  const qrText = L.qrOn ? fillVars(L.qr || '').trim() : '';
  if (qrText) {
    const q = qrcode(0, 'M'); q.addData(qrText, 'Byte'); q.make();
    const n = q.getModuleCount() + 4;
    const room = land ? Math.min(ah, aw * 0.42) : Math.min(aw, ah * 0.5);
    const mod = Math.max(2, Math.floor(room / n));
    const size = n * mod;
    qr = { q, mod, size };
    if (land) { qr.x = ax + aw - size; qr.y = ay + (ah - size) / 2; aw -= size + 16; }
    else { qr.x = ax + (aw - size) / 2; qr.y = ay + ah - size; ah -= size + 12; }
  }

  // Photo : à gauche, au-dessus, ou sur toute l'étiquette (avec le titre en bandeau)
  let photo = null;
  const hasText = !!(T.title || T.subtitle || T.detail || L.icon);
  if (L.photoPos) {
    const img = labelPhotoImage(L);
    const pos = L.photoPos;
    let bx = ax, by = ay, bw = aw, bh = ah;
    if (pos === 'left' && hasText) { bw = Math.round(aw * 0.5); ax += bw + 14; aw -= bw + 14; }
    else if (pos === 'top' && hasText) { bh = Math.round(ah * 0.58); ay += bh + 12; ah -= bh + 12; }
    photo = { img, bx, by, bw, bh, full: pos === 'full' };
  }
  if (photo) {
    if (photo.img) ctx.drawImage(photoBox(photo.img, photo.bw, photo.bh, L), Math.round(photo.bx), Math.round(photo.by));
    else if (!opts.noPlaceholder) photoPlaceholder(ctx, photo.bx, photo.by, photo.bw, photo.bh);
  }
  if (photo && photo.full) {
    // pleine étiquette : le titre seul, dans un bandeau blanc en bas
    if (T.title) {
      const bandH = Math.round(Math.min(H, W) * 0.26), pad2 = 10;
      const sub = Object.assign({}, L, { icon: '' });
      const ft = fitStack(ctx, { title: T.title, subtitle: '', detail: '' }, sub, aw - pad2 * 2, bandH - pad2 * 2, family);
      const yb = ay + ah - bandH;
      ctx.fillStyle = '#fff'; ctx.fillRect(ax, yb, aw, bandH);
      ctx.fillStyle = '#000'; ctx.fillRect(ax, yb, aw, 3);
      layoutRich(ctx, parseInline(T.title), ax + pad2, aw - pad2 * 2, yb + (bandH - ft.st.total) / 2, ft.s, family, 'center', true, true);
    }
    toneThreshold(view);
    return finishLabel(view, L, d, opts, { s: 0, st: { total: 0 } });
  }
  const fit = fitStack(ctx, T, L, aw, ah, family);
  const st = fit.st;
  let y = Math.round(ay + (ah - st.total) / 2);
  for (const it of st.items) {
    if (it.kind === 'drawing') {
      const im = labelDrawImage(L);
      if (im) {
        const r = Math.min(aw / im.width, it.h / im.height);
        const dw = im.width * r, dh = im.height * r;
        const dx = L.align === 'left' ? ax : ax + (aw - dw) / 2;
        ctx.drawImage(bayerCanvas(im, dw, dh), Math.round(dx), Math.round(y + (it.h - dh) / 2)); // gris tramés
      }
    } else if (it.kind === 'icon') {
      ctx.font = `${it.size}px ${family}`; ctx.fillStyle = '#000'; ctx.textBaseline = 'alphabetic';
      const glyph = L.icon + '︎', gw = ctx.measureText(glyph).width;
      const gx = L.align === 'left' ? ax : ax + (aw - gw) / 2;
      ctx.fillText(glyph, gx, y + Math.round(it.size * 0.92));
    } else {
      const text = T[it.kind];
      layoutRich(ctx, parseInline(text), ax, aw, y, it.size, family, L.align, true, it.kind === 'title');
    }
    y += it.h + st.gap;
  }
  if (qr) {
    ctx.fillStyle = '#000';
    const n = qr.q.getModuleCount();
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
      if (qr.q.isDark(r, c)) ctx.fillRect(Math.round(qr.x) + (c + 2) * qr.mod, Math.round(qr.y) + (r + 2) * qr.mod, qr.mod, qr.mod);
  }
  toneThreshold(view);
  return finishLabel(view, L, d, opts, fit);
}
function finishLabel(view, L, d, opts, fit) {
  const land = L.orient === 'land';
  if (opts.viewOnly) return { view, fit };
  // Page d'impression : 384 × 807, pivotée si l'étiquette est couchée
  const print = document.createElement('canvas'); print.width = PW; print.height = d.hD;
  const p = print.getContext('2d'); p.fillStyle = '#fff'; p.fillRect(0, 0, PW, d.hD);
  if (land) {
    if (L.flip) { p.translate(d.xOff, d.hD); p.rotate(-Math.PI / 2); }
    else { p.translate(d.xOff + d.wD, 0); p.rotate(Math.PI / 2); }
  } else {
    if (L.flip) { p.translate(d.xOff + d.wD, d.hD); p.rotate(Math.PI); }
    else p.translate(d.xOff, 0);
  }
  p.drawImage(view, 0, 0);
  p.setTransform(1, 0, 0, 1, 0, 0);
  threshold(print);
  return { view, print, fit };
}
