/* Zebra Studio — dessin au stylet (Apple Pencil) : pression, gomme, annuler, paume ignorée */
'use strict';

const DRAW_SCALE = 2;           // on dessine en 2× pour des traits lisses, réduits à l'impression
const DRAW_TOOLS = {
  fin:      { label: 'Fin',      w: 3,  icon: '✎', hidden: true }, // retiré de la barre, gardé pour les anciens dessins
  feutre:   { label: 'Feutre',   w: 7,  icon: '🖊' },
  marqueur: { label: 'Marqueur', w: 16, icon: '🖍' },
  gros:     { label: 'Gros',     w: 34, icon: '⬤' },
  gomme:    { label: 'Gomme',    w: 30, icon: '⌫', erase: true },
};

// Ouvre la feuille de dessin. opts : { width (points d'impression), height, strokes, fixedHeight, title }
// Résout avec { src (PNG), strokes, height } ou null si annulé.
function openDrawing(opts) {
  return new Promise(resolve => {
    const W = Math.round(opts.width * DRAW_SCALE);
    let H = Math.round((opts.height || 400) * DRAW_SCALE);
    const k = opts.strokesWidth && opts.strokesWidth !== opts.width ? opts.width / opts.strokesWidth : 1;
    if (k !== 1) H = Math.round(H * k);
    let strokes = (opts.strokes || []).map(s => ({ tool: s.tool, w: s.w, i: s.i, pts: s.pts.map(p => [Math.round(p[0] * k), Math.round(p[1] * k), p[2]]) }));
    const undoStack = [], redo = [];
    const commit = () => { undoStack.push(strokes.slice()); if (undoStack.length > 200) undoStack.shift(); redo.length = 0; };
    let eraseSize = 30, eraseMode = 'area'; // gomme : épaisseur, ou trait entier
    let tool = 'feutre', penSeen = false, handMode = true, intensity = 1; // le doigt fait défiler par défaut
    const active = new Map();   // traits en cours, un par pointeur (stylet, doigt…)
    let scroller = null;        // défilement au doigt

    const bg = document.createElement('div'); bg.className = 'draw-bg';
    bg.innerHTML = `
      <div class="draw-top">
        <button class="dbtn" data-act="cancel">Annuler</button>
        <b>${opts.title || 'Dessin'}</b>
        <button class="dbtn primary" data-act="done">Terminé</button>
      </div>
      <div class="draw-tools">
        ${Object.entries(DRAW_TOOLS).filter(([, t]) => !t.hidden).map(([k, t]) => `<button class="dtool${k === tool ? ' on' : ''}" data-tool="${k}"><span>${t.icon}</span>${t.label}</button>`).join('')}
        <span class="dsep"></span>
        ${[1, 0.7, 0.45, 0.25].map(v => `<button class="dtool dint${v === 1 ? ' on' : ''}" data-int="${v}"><i style="background:rgb(${Math.round(255 * (1 - v))},${Math.round(255 * (1 - v))},${Math.round(255 * (1 - v))})"></i>${Math.round(v * 100)} %</button>`).join('')}
        <span class="dsep"></span>
        <button class="dtool on" data-act="hand"><span>✋</span>Doigt : défile</button>
        <button class="dtool" data-act="undo"><span>↶</span>Annuler</button>
        <button class="dtool" data-act="redo"><span>↷</span>Refaire</button>
        <button class="dtool" data-act="clear"><span>🗑</span>Effacer</button>
        ${opts.fixedHeight ? '' : `<span class="dsep"></span><button class="dtool" data-act="shorter"><span>−</span>Raccourcir</button><button class="dtool" data-act="taller"><span>+</span>Allonger</button>`}
      </div>
      <div class="draw-sub" style="display:none">
        <span class="dlab">Gomme</span>
        <button class="dchip" data-esize="14">Petite</button><button class="dchip on" data-esize="30">Moyenne</button><button class="dchip" data-esize="60">Grande</button>
        <button class="dchip" data-emode="stroke">Trait entier</button>
      </div>
      <div class="draw-stage"><div class="draw-paper"><canvas></canvas><div class="draw-cursor"></div></div></div>
      <div class="draw-hint">Le stylet dessine, le doigt fait défiler (touche « Doigt » pour dessiner au doigt). Les gris sont imprimés en fine trame de points.</div>`;
    document.body.append(bg);
    const cv = bg.querySelector('canvas'), ctx = cv.getContext('2d');
    const cursor = bg.querySelector('.draw-cursor'), sub = bg.querySelector('.draw-sub');
    function showCursor(e) {
      if (!DRAW_TOOLS[tool].erase || (e && e.pointerType === 'touch' && handMode)) { cursor.style.display = 'none'; return; }
      const r = cv.getBoundingClientRect(), k = r.width / W, d = Math.max(10, eraseSize * k);
      cursor.style.display = 'block';
      cursor.style.width = cursor.style.height = d + 'px';
      cursor.style.left = (e.clientX - r.left - d / 2) + 'px'; cursor.style.top = (e.clientY - r.top - d / 2) + 'px';
      cursor.classList.toggle('whole', eraseMode === 'stroke');
    }
    cv.addEventListener('pointerleave', () => { cursor.style.display = 'none'; });
    // gomme « trait entier » : supprime les traits touchés
    function hitStrokes(p) {
      const rr = eraseSize / 2; let removed = false;
      strokes = strokes.filter(s => {
        if (DRAW_TOOLS[s.tool].erase) return true;
        const lim = rr + s.w / 2;
        const hit = s.pts.some(q => (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 <= lim * lim);
        if (hit) removed = true;
        return !hit;
      });
      if (removed) redraw();
    }
    const stage = bg.querySelector('.draw-stage');

    function size() {
      cv.width = W; cv.height = H;
      // affichage : toute la largeur disponible, max 2,2× la taille réelle
      const avail = Math.min(stage.clientWidth - 32, 720);
      cv.style.width = avail + 'px'; cv.style.height = (avail * H / W) + 'px';
      redraw();
    }
    function strokePath(s, from) {
      const t = DRAW_TOOLS[s.tool];
      // gris = feutre atténué ; « darken » : un trait plus clair ne pâlit jamais un trait plus foncé
      ctx.globalCompositeOperation = t.erase ? 'destination-out' : 'darken';
      const v = Math.round(255 * (1 - (s.i == null ? 1 : s.i)));
      ctx.strokeStyle = ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const p = s.pts;
      if (p.length === 1) { ctx.beginPath(); ctx.arc(p[0][0], p[0][1], s.w * (0.4 + p[0][2]) / 2, 0, Math.PI * 2); ctx.fill(); return; }
      for (let i = Math.max(1, from || 1); i < p.length; i++) {
        const a = p[i - 1], b = p[i];
        ctx.lineWidth = t.erase ? s.w : s.w * (0.35 + (a[2] + b[2]) * 0.65);
        ctx.beginPath();
        if (i === 1) ctx.moveTo(a[0], a[1]); else { const m0 = p[i - 2]; ctx.moveTo((m0[0] + a[0]) / 2, (m0[1] + a[1]) / 2); }
        ctx.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        ctx.stroke();
      }
    }
    function redraw() {
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, W, H);
      strokes.forEach(s => strokePath(s)); // (forEach passerait l'index comme 2e argument)
      ctx.globalCompositeOperation = 'source-over';
    }
    const pos = e => {
      const r = cv.getBoundingClientRect();
      const pr = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
      return [Math.round((e.clientX - r.left) * W / r.width), Math.round((e.clientY - r.top) * H / r.height), Math.round(pr * 100) / 100];
    };
    // Palme : contact large, ou doigt posé juste avant le stylet → on l'ignore / on retire ce qu'il a tracé
    // (un doigt sur iPad mesure déjà 30 à 50 px de contact : seule une très grande surface compte comme paume)
    const isPalm = e => e.pointerType === 'touch' && ((e.width || 0) > 80 || (e.height || 0) > 80);
    cv.addEventListener('pointerdown', e => {
      e.preventDefault();
      if (e.pointerType === 'pen') {
        if (!penSeen) {
          penSeen = true;
          // tout ce que les doigts ont tracé dans la dernière seconde était sans doute la paume
          const now = performance.now();
          strokes = strokes.filter(s => !(s.touch && now - s.t0 < 1000));
          for (const [id, s] of active) if (s.touch) active.delete(id);
          redraw();
        }
      }
      const touchScroll = e.pointerType === 'touch' && handMode;
      if ((handMode && e.pointerType === 'touch') || touchScroll) {
        scroller = { id: e.pointerId, y: e.clientY, top: stage.scrollTop }; // tout contact du doigt fait défiler
        return;
      }
      if (isPalm(e)) return;
      try { cv.setPointerCapture(e.pointerId); } catch (_) {}
      const t = DRAW_TOOLS[tool];
      commit();
      showCursor(e);
      if (t.erase && eraseMode === 'stroke') { active.set(e.pointerId, { wholeEraser: true }); hitStrokes(pos(e)); return; }
      const s = { tool, w: t.erase ? eraseSize : t.w, i: t.erase ? 1 : intensity, pts: [pos(e)], touch: e.pointerType === 'touch', t0: performance.now() };
      active.set(e.pointerId, s);
      strokes.push(s);
      strokePath(s);
      ctx.globalCompositeOperation = 'source-over';
    });
    cv.addEventListener('pointermove', e => {
      if (scroller && e.pointerId === scroller.id) { e.preventDefault(); stage.scrollTop = scroller.top - (e.clientY - scroller.y); return; }
      showCursor(e); // y compris au survol du stylet, sans toucher l'écran
      const s = active.get(e.pointerId); if (!s) return;
      e.preventDefault();
      if (s.wholeEraser) { hitStrokes(pos(e)); return; }
      let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (!evs || !evs.length) evs = [e];
      const from = s.pts.length;
      evs.forEach(ev => s.pts.push(pos(ev)));
      strokePath(s, from); // seulement les nouveaux segments : fluide même avec beaucoup de traits
      ctx.globalCompositeOperation = 'source-over';
    });
    const end = e => {
      if (scroller && e.pointerId === scroller.id) scroller = null;
      const s = active.get(e.pointerId);
      if (s) active.delete(e.pointerId);
    };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end); cv.addEventListener('lostpointercapture', end);
    // Safari signale aussi l'Apple Pencil par touchType « stylus »
    cv.addEventListener('touchstart', e => { for (const t of e.changedTouches) if (t.touchType === 'stylus') penSeen = true; e.preventDefault(); }, { passive: false });
    cv.addEventListener('touchmove', e => e.preventDefault(), { passive: false });

    bg.addEventListener('click', e => {
      const ib = e.target.closest('[data-int]');
      if (ib) { intensity = +ib.dataset.int; bg.querySelectorAll('[data-int]').forEach(b => b.classList.toggle('on', b === ib)); if (DRAW_TOOLS[tool].erase) { tool = 'feutre'; bg.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === 'feutre')); sub.style.display = 'none'; cursor.style.display = 'none'; } return; }
      const tb = e.target.closest('[data-tool]');
      if (tb) { tool = tb.dataset.tool; bg.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b === tb)); sub.style.display = DRAW_TOOLS[tool].erase ? '' : 'none'; cursor.style.display = 'none'; return; }
      const es = e.target.closest('[data-esize]'), em = e.target.closest('[data-emode]');
      if (es) { eraseSize = +es.dataset.esize; eraseMode = 'area'; sub.querySelectorAll('.dchip').forEach(b => b.classList.toggle('on', b === es)); return; }
      if (em) { eraseMode = 'stroke'; sub.querySelectorAll('.dchip').forEach(b => b.classList.toggle('on', b === em)); return; }
      const act = (e.target.closest('[data-act]') || {}).dataset; if (!act) return;
      switch (act.act) {
        case 'hand': { handMode = !handMode; const hb = e.target.closest('[data-act]'); hb.classList.toggle('on', handMode); hb.lastChild.textContent = handMode ? 'Doigt : défile' : 'Doigt : dessine'; break; }
        case 'undo': if (undoStack.length) { redo.push(strokes); strokes = undoStack.pop(); redraw(); } break;
        case 'redo': if (redo.length) { undoStack.push(strokes); strokes = redo.pop(); redraw(); } break;
        case 'clear': if (strokes.length) { commit(); strokes = []; redraw(); } break;
        case 'taller': H = Math.min(H + 200 * DRAW_SCALE, 4000 * DRAW_SCALE); size(); break;
        case 'shorter': {
          const maxY = strokes.reduce((m, s) => Math.max(m, ...s.pts.map(p => p[1])), 0);
          H = Math.max(H - 200 * DRAW_SCALE, 120 * DRAW_SCALE, maxY + 40); size(); break;
        }
        case 'cancel': close(null); break;
        case 'done': {
          const ink = strokes.some(s => !DRAW_TOOLS[s.tool].erase);
          if (!ink) { close({ src: '', strokes: [], height: H / DRAW_SCALE }); break; }
          // image finale : fond blanc, traits noirs
          const out = document.createElement('canvas'); out.width = W; out.height = H;
          const o = out.getContext('2d'); o.fillStyle = '#fff'; o.fillRect(0, 0, W, H); o.drawImage(cv, 0, 0);
          close({ src: out.toDataURL('image/png'), strokes: strokes.map(s => ({ tool: s.tool, w: s.w, i: s.i, pts: s.pts })), height: H / DRAW_SCALE, width: W / DRAW_SCALE });
          break;
        }
      }
    });
    function close(v) { window.removeEventListener('resize', size); bg.remove(); resolve(v); }
    window.addEventListener('resize', size);
    requestAnimationFrame(size);
  });
}
