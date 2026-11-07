/* Zebra Studio — dessin au stylet (Apple Pencil) : pression, gomme, annuler, paume ignorée */
'use strict';

const DRAW_SCALE = 2;           // on dessine en 2× pour des traits lisses, réduits à l'impression
const DRAW_TOOLS = {
  fin:      { label: 'Fin',      w: 3,  icon: '✎' },
  feutre:   { label: 'Feutre',   w: 7,  icon: '🖊' },
  marqueur: { label: 'Marqueur', w: 16, icon: '🖍' },
  gomme:    { label: 'Gomme',    w: 26, icon: '⌫', erase: true },
};

// Ouvre la feuille de dessin. opts : { width (points d'impression), height, strokes, fixedHeight, title }
// Résout avec { src (PNG), strokes, height } ou null si annulé.
function openDrawing(opts) {
  return new Promise(resolve => {
    const W = Math.round(opts.width * DRAW_SCALE);
    let H = Math.round((opts.height || 400) * DRAW_SCALE);
    let strokes = (opts.strokes || []).map(s => Object.assign({}, s, { pts: s.pts.slice() }));
    const redo = [];
    let tool = 'feutre', penSeen = false, current = null;

    const bg = document.createElement('div'); bg.className = 'draw-bg';
    bg.innerHTML = `
      <div class="draw-top">
        <button class="dbtn" data-act="cancel">Annuler</button>
        <b>${opts.title || 'Dessin'}</b>
        <button class="dbtn primary" data-act="done">Terminé</button>
      </div>
      <div class="draw-tools">
        ${Object.entries(DRAW_TOOLS).map(([k, t]) => `<button class="dtool${k === tool ? ' on' : ''}" data-tool="${k}"><span>${t.icon}</span>${t.label}</button>`).join('')}
        <span class="dsep"></span>
        <button class="dtool" data-act="undo"><span>↶</span>Annuler</button>
        <button class="dtool" data-act="redo"><span>↷</span>Refaire</button>
        <button class="dtool" data-act="clear"><span>🗑</span>Effacer</button>
        ${opts.fixedHeight ? '' : `<span class="dsep"></span><button class="dtool" data-act="shorter"><span>−</span>Raccourcir</button><button class="dtool" data-act="taller"><span>+</span>Allonger</button>`}
      </div>
      <div class="draw-stage"><div class="draw-paper"><canvas></canvas></div></div>
      <div class="draw-hint">Dessine au stylet : le doigt reste libre pour faire défiler. Ce que tu vois sera imprimé en noir.</div>`;
    document.body.append(bg);
    const cv = bg.querySelector('canvas'), ctx = cv.getContext('2d');
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
      ctx.globalCompositeOperation = t.erase ? 'destination-out' : 'source-over';
      ctx.strokeStyle = '#000'; ctx.fillStyle = '#000'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
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
      strokes.forEach(strokePath);
      ctx.globalCompositeOperation = 'source-over';
    }
    const pos = e => {
      const r = cv.getBoundingClientRect();
      const pr = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
      return [Math.round((e.clientX - r.left) * W / r.width), Math.round((e.clientY - r.top) * H / r.height), Math.round(pr * 100) / 100];
    };
    cv.addEventListener('pointerdown', e => {
      if (e.pointerType === 'pen') penSeen = true;
      if (penSeen && e.pointerType === 'touch') return; // paume / doigt ignorés dès qu'un stylet a servi
      e.preventDefault(); cv.setPointerCapture(e.pointerId);
      const t = DRAW_TOOLS[tool];
      current = { tool, w: t.w, pts: [pos(e)], id: e.pointerId };
      strokes.push(current); redo.length = 0;
      redraw();
    });
    cv.addEventListener('pointermove', e => {
      if (!current || e.pointerId !== current.id) return;
      e.preventDefault();
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      const from = current.pts.length;
      evs.forEach(ev => current.pts.push(pos(ev)));
      strokePath(current, from); // seulement les nouveaux segments : fluide même avec beaucoup de traits
      ctx.globalCompositeOperation = 'source-over';
    });
    const end = e => { if (current && e.pointerId === current.id) { current = null; } };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    cv.addEventListener('touchstart', e => { if (!penSeen || e.touches[0].touchType === 'stylus') e.preventDefault(); }, { passive: false });

    bg.addEventListener('click', e => {
      const tb = e.target.closest('[data-tool]');
      if (tb) { tool = tb.dataset.tool; bg.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b === tb)); return; }
      const act = (e.target.closest('[data-act]') || {}).dataset; if (!act) return;
      switch (act.act) {
        case 'undo': if (strokes.length) { redo.push(strokes.pop()); redraw(); } break;
        case 'redo': if (redo.length) { strokes.push(redo.pop()); redraw(); } break;
        case 'clear': if (strokes.length) { redo.push(...strokes.reverse()); strokes = []; redraw(); } break;
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
          close({ src: out.toDataURL('image/png'), strokes, height: H / DRAW_SCALE });
          break;
        }
      }
    });
    function close(v) { window.removeEventListener('resize', size); bg.remove(); resolve(v); }
    window.addEventListener('resize', size);
    requestAnimationFrame(size);
  });
}
