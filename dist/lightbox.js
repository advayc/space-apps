// Click any content image to open it in a full-screen viewer.
// Wheel, pinch, double-click and buttons zoom; drag pans; arrows and Esc work.
// Zoom and pan are eased on every frame, and open/close fly from/to the thumbnail.

const SELECTOR = 'img:not([data-no-zoom])';
const MIN_SIZE = 96;          // ignore icons and tiny images
const MAX_ZOOM = 8;           // times the fitted size
const DOUBLE_ZOOM = 2.5;
const SMOOTH_MS = 85;         // easing time constant for zoom and pan
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const dur = ms => (reduceMotion.matches ? 0 : ms);

let root, stage, img, countEl, loadEl, zoomEl, captionEl, prevBtn, nextBtn, closeBtn, tools;
let items = [], index = -1, opener = null, isOpen = false, busy = false;
let w0 = 0, h0 = 0, c0x = 0, c0y = 0;
let s = 1, gs = 1, x = 0, y = 0, gx = 0, gy = 0, anchor = null;
let raf = 0, last = 0;
const pointers = new Map();
let pinch = null, drag = null, lastTap = { t: 0, x: 0, y: 0 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function eligible(el) {
  if (!(el instanceof HTMLImageElement)) return false;
  if (el.closest('a, button, [data-no-zoom], .lb')) return false;
  const r = el.getBoundingClientRect();
  return r.width >= MIN_SIZE && r.height >= MIN_SIZE / 2 && el.currentSrc !== '';
}

function collect() {
  return [...document.querySelectorAll(SELECTOR)].filter(el => eligible(el) && !el.closest('[hidden]'));
}

function fullSrc(src) {
  // Wikimedia thumbnails can be re-requested at a larger width for sharp zooming.
  return src.replace(/(Special:FilePath\/[^?]+\?)(?:[^#]*&)?width=\d+/, '$1width=2400');
}

function build() {
  root = document.createElement('div');
  root.className = 'lb';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Image viewer');
  root.innerHTML = `
    <div class="lb-backdrop"></div>
    <div class="lb-stage"><img class="lb-img" alt="" draggable="false"></div>
    <div class="lb-bar">
      <span class="lb-count" aria-live="polite"></span>
      <span class="lb-load" hidden>Loading full size…</span>
      <span class="lb-tools">
        <button type="button" class="lb-btn" data-act="out" aria-label="Zoom out" title="Zoom out (−)">−</button>
        <output class="lb-zoom" title="Reset zoom (0)">100%</output>
        <button type="button" class="lb-btn" data-act="in" aria-label="Zoom in" title="Zoom in (+)">+</button>
        <button type="button" class="lb-btn lb-reset" data-act="reset" aria-label="Fit to screen" title="Fit to screen (0)">Fit</button>
        <button type="button" class="lb-btn lb-close" data-act="close" aria-label="Close" title="Close (Esc)">✕</button>
      </span>
    </div>
    <button type="button" class="lb-nav lb-prev" data-act="prev" aria-label="Previous image">‹</button>
    <button type="button" class="lb-nav lb-next" data-act="next" aria-label="Next image">›</button>
    <div class="lb-caption"></div>`;
  document.body.append(root);
  stage = root.querySelector('.lb-stage');
  img = root.querySelector('.lb-img');
  countEl = root.querySelector('.lb-count');
  loadEl = root.querySelector('.lb-load');
  zoomEl = root.querySelector('.lb-zoom');
  captionEl = root.querySelector('.lb-caption');
  prevBtn = root.querySelector('.lb-prev');
  nextBtn = root.querySelector('.lb-next');
  closeBtn = root.querySelector('.lb-close');
  tools = root.querySelector('.lb-tools');

  root.addEventListener('click', onClick);
  stage.addEventListener('wheel', onWheel, { passive: false });
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('pointercancel', onPointerUp);
  stage.addEventListener('dblclick', e => e.preventDefault());
  addEventListener('resize', () => { if (isOpen) { layout(); render(); } });
}

/* ---------- layout & rendering ---------- */

function layout() {
  const vw = innerWidth, vh = innerHeight;
  const top = 56;
  const bottom = captionEl.textContent.trim() ? Math.min(150, captionEl.offsetHeight + 28) : 20;
  const bw = Math.max(80, vw - (vw > 700 ? 120 : 24));
  const bh = Math.max(80, vh - top - bottom);
  const ar = (img.naturalWidth || 4) / (img.naturalHeight || 3);
  w0 = Math.min(bw, bh * ar);
  h0 = w0 / ar;
  c0x = vw / 2;
  c0y = top + bh / 2;
  img.style.width = w0 + 'px';
  img.style.height = h0 + 'px';
  img.style.left = c0x - w0 / 2 + 'px';
  img.style.top = c0y - h0 / 2 + 'px';
}

function limits(scale) {
  const w = w0 * scale, h = h0 * scale;
  const rx = w > innerWidth ? [innerWidth - c0x - w / 2, w / 2 - c0x] : [0, 0];
  const ry = h > innerHeight ? [innerHeight - c0y - h / 2, h / 2 - c0y] : [0, 0];
  return { rx, ry };
}

function render() {
  if (busy) return;
  const { rx, ry } = limits(s);
  x = clamp(x, rx[0], rx[1]);
  y = clamp(y, ry[0], ry[1]);
  img.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${s})`;
  zoomEl.value = Math.round(s * 100) + '%';
  root.classList.toggle('is-zoomed', gs > 1.04);
  root.classList.toggle('at-min', gs <= 1.001);
  root.classList.toggle('at-max', gs >= MAX_ZOOM - 0.001);
}

function frame(t) {
  raf = 0;
  const dt = Math.min(64, t - (last || t));
  last = t;
  const a = reduceMotion.matches ? 1 : 1 - Math.exp(-dt / SMOOTH_MS);
  // scale eases in log space so zoom feels even in both directions
  s = Math.exp(Math.log(s) + (Math.log(gs) - Math.log(s)) * a);
  if (Math.abs(Math.log(gs / s)) < 0.0008) s = gs;
  if (anchor) {
    x = anchor.ax - anchor.ux * s;
    y = anchor.ay - anchor.uy * s;
    const { rx, ry } = limits(s);
    gx = x = clamp(x, rx[0], rx[1]);
    gy = y = clamp(y, ry[0], ry[1]);
    if (s === gs) anchor = null;
  } else {
    const { rx, ry } = limits(s);
    gx = clamp(gx, rx[0], rx[1]);
    gy = clamp(gy, ry[0], ry[1]);
    x += (gx - x) * a;
    y += (gy - y) * a;
    if (Math.abs(gx - x) < 0.05) x = gx;
    if (Math.abs(gy - y) < 0.05) y = gy;
  }
  render();
  if (s !== gs || anchor || x !== gx || y !== gy) kick();
  else last = 0;
}

function kick() { if (!raf) raf = requestAnimationFrame(frame); }

function zoomAt(newScale, cx, cy) {
  gs = clamp(newScale, 1, MAX_ZOOM);
  const ax = cx - c0x, ay = cy - c0y;
  anchor = { ax, ay, ux: (ax - x) / s, uy: (ay - y) / s };
  kick();
}

function resetView() {
  gs = 1; gx = 0; gy = 0; anchor = null;
  kick();
}

/* ---------- input ---------- */

function onWheel(e) {
  e.preventDefault();
  if (busy) return;
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  const k = e.ctrlKey ? 0.012 : 0.0016;
  zoomAt(gs * Math.exp(-e.deltaY * unit * k), e.clientX, e.clientY);
}

function onPointerDown(e) {
  if (busy || e.button > 0) return;
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
  if (pointers.size === 2) {
    const [p, q] = [...pointers.values()];
    const mx = (p.x + q.x) / 2 - c0x, my = (p.y + q.y) / 2 - c0y;
    pinch = { d: Math.hypot(p.x - q.x, p.y - q.y), s0: s, ux: (mx - x) / s, uy: (my - y) / s };
    drag = null;
    anchor = null;
  } else if (pointers.size === 1) {
    drag = { onImage: e.target === img, sx: e.clientX, sy: e.clientY, x0: x, y0: y, moved: 0, vx: 0, vy: 0, lt: performance.now(), lx: e.clientX, ly: e.clientY };
    anchor = null;
    gx = x; gy = y; gs = s;
  }
  root.classList.add('is-grabbing');
}

function onPointerMove(e) {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  p.x = e.clientX; p.y = e.clientY;
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    s = gs = clamp(pinch.s0 * d / pinch.d, 0.6, MAX_ZOOM);
    const mx = (a.x + b.x) / 2 - c0x, my = (a.y + b.y) / 2 - c0y;
    x = gx = mx - pinch.ux * s;
    y = gy = my - pinch.uy * s;
    render();
    return;
  }
  if (drag) {
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
    const now = performance.now(), dt = Math.max(1, now - drag.lt);
    drag.vx = 0.8 * drag.vx + 0.2 * ((e.clientX - drag.lx) / dt);
    drag.vy = 0.8 * drag.vy + 0.2 * ((e.clientY - drag.ly) / dt);
    drag.lt = now; drag.lx = e.clientX; drag.ly = e.clientY;
    if (s > 1.001) {
      x = gx = drag.x0 + dx;
      y = gy = drag.y0 + dy;
      render();
    }
  }
}

function onPointerUp(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pinch) {
    if (pointers.size < 2) {
      pinch = null;
      if (s < 1) resetView();
      else { gs = s; gx = x; gy = y; kick(); }
      const rest = [...pointers.values()][0];
      drag = null;
      if (rest) drag = { sx: rest.x, sy: rest.y, x0: x, y0: y, moved: 99, vx: 0, vy: 0, lt: performance.now(), lx: rest.x, ly: rest.y };
    }
    if (!pointers.size) root.classList.remove('is-grabbing');
    return;
  }
  root.classList.remove('is-grabbing');
  if (!drag) return;
  const d = drag;
  drag = null;
  if (e.type === 'pointercancel') return;
  if (d.moved < 6) {
    // a tap or click, not a drag
    const now = performance.now();
    const onImage = d.onImage;
    if (now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30 && onImage) {
      if (gs > 1.05) resetView(); else zoomAt(DOUBLE_ZOOM, e.clientX, e.clientY);
      lastTap = { t: 0, x: 0, y: 0 };
    } else {
      lastTap = { t: now, x: e.clientX, y: e.clientY };
      if (!onImage) close();
    }
    return;
  }
  if (s > 1.001 && performance.now() - d.lt < 80) {
    // glide on release
    gx = x + d.vx * 220;
    gy = y + d.vy * 220;
    kick();
  }
}

function onClick(e) {
  const btn = e.target.closest('[data-act]');
  if (btn) {
    const act = btn.dataset.act;
    if (act === 'close') close();
    else if (act === 'in') zoomAt(gs * 1.5, c0x, c0y);
    else if (act === 'out') zoomAt(gs / 1.5, c0x, c0y);
    else if (act === 'reset') resetView();
    else if (act === 'prev') step(-1);
    else if (act === 'next') step(1);
    return;
  }
  if (e.target.closest('.lb-caption a')) return;
  if (e.target === zoomEl) resetView();
}

function onKey(e) {
  if (!isOpen) return;
  const key = e.key;
  if (key === 'Escape') { e.preventDefault(); close(); return; }
  if (key === 'Tab') {
    const focusable = [...root.querySelectorAll('button:not([hidden]), .lb-caption a')].filter(b => !b.disabled && b.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], lastEl = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
    return;
  }
  if (key === '+' || key === '=') { e.preventDefault(); zoomAt(gs * 1.5, c0x, c0y); }
  else if (key === '-' || key === '_') { e.preventDefault(); zoomAt(gs / 1.5, c0x, c0y); }
  else if (key === '0') { e.preventDefault(); resetView(); }
  else if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
    if (gs > 1.04) {
      e.preventDefault();
      const n = 120;
      if (key === 'ArrowLeft') gx += n; if (key === 'ArrowRight') gx -= n;
      if (key === 'ArrowUp') gy += n; if (key === 'ArrowDown') gy -= n;
      anchor = null; kick();
    } else if (key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (key === 'ArrowRight') { e.preventDefault(); step(1); }
  }
}

/* ---------- open, close, navigate ---------- */

function setCaption(el) {
  captionEl.replaceChildren();
  const fig = el.closest('figure');
  const cap = fig && fig.querySelector('figcaption');
  if (cap) captionEl.append(...[...cap.childNodes].map(n => n.cloneNode(true)));
  else if (el.alt) captionEl.textContent = el.alt;
}

function loadInto(el) {
  return new Promise(resolve => {
    img.alt = el.alt || '';
    img.src = el.currentSrc || el.src;
    const done = () => resolve();
    if (img.complete && img.naturalWidth) done();
    else { img.onload = done; img.onerror = done; }
  });
}

function upgrade(el, token) {
  const big = fullSrc(el.currentSrc || el.src);
  if (big === (el.currentSrc || el.src)) return;
  loadEl.hidden = false;
  const pre = new Image();
  pre.referrerPolicy = el.referrerPolicy || '';
  pre.onload = () => {
    loadEl.hidden = true;
    if (token !== index || !isOpen) return;
    img.src = big;      // same aspect ratio, so the swap is invisible
  };
  pre.onerror = () => { loadEl.hidden = true; };
  pre.src = big;
}

function thumbPose(el) {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const cover = cs.objectFit === 'cover';
  let sc, clip;
  if (cover) {
    sc = Math.max(r.width / w0, r.height / h0);
    const tx = Math.max(0, (w0 - r.width / sc) / 2), ty = Math.max(0, (h0 - r.height / sc) / 2);
    const rad = (parseFloat(cs.borderTopLeftRadius) || 0) / sc;
    clip = `inset(${ty}px ${tx}px ${ty}px ${tx}px round ${rad}px)`;
  } else {
    sc = Math.min(r.width / w0, r.height / h0);
    clip = 'inset(0px 0px 0px 0px round 0px)';
  }
  const dx = r.left + r.width / 2 - c0x, dy = r.top + r.height / 2 - c0y;
  const visible = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  return { transform: `translate3d(${dx}px, ${dy}px, 0) scale(${sc})`, clip, visible };
}

const REST_CLIP = 'inset(0px 0px 0px 0px round 0px)';
const EASE = 'cubic-bezier(.2,.8,.2,1)';

async function open(el) {
  if (isOpen || busy) return;
  if (!root) build();
  items = collect();
  index = items.indexOf(el);
  if (index < 0) { items = [el]; index = 0; }
  opener = document.activeElement;
  busy = true;
  isOpen = true;
  const sbw = innerWidth - document.documentElement.clientWidth;
  document.documentElement.classList.add('lb-lock');
  if (sbw > 0) document.documentElement.style.paddingRight = sbw + 'px';
  setCaption(el);
  root.hidden = false;
  root.classList.remove('is-open');
  img.style.opacity = '0';
  await loadInto(el);
  s = gs = 1; x = y = gx = gy = 0; anchor = null;
  layout();
  updateChrome();
  el.style.visibility = 'hidden';
  void root.offsetWidth;
  root.classList.add('is-open');
  const from = thumbPose(el);
  img.style.opacity = '1';
  img.style.transform = 'translate3d(0,0,0) scale(1)';
  if (from.visible && dur(1)) {
    const a = img.animate(
      [{ transform: from.transform, clipPath: from.clip }, { transform: 'translate3d(0,0,0) scale(1)', clipPath: REST_CLIP }],
      { duration: dur(420), easing: EASE }
    );
    await a.finished.catch(() => {});
  } else {
    await img.animate([{ opacity: 0, transform: 'scale(.97)' }, { opacity: 1, transform: 'scale(1)' }], { duration: dur(220), easing: EASE }).finished.catch(() => {});
  }
  busy = false;
  render();
  closeBtn.focus({ preventScroll: true });
  upgrade(el, index);
}

async function close() {
  if (!isOpen || busy) return;
  busy = true;
  cancelAnimationFrame(raf); raf = 0; last = 0;
  anchor = null;
  const el = items[index];
  const nowT = `translate3d(${x}px, ${y}px, 0) scale(${s})`;
  root.classList.remove('is-open');
  root.classList.remove('is-zoomed');
  const to = thumbPose(el);
  let anim;
  if (to.visible && dur(1)) {
    anim = img.animate(
      [{ transform: nowT, clipPath: REST_CLIP }, { transform: to.transform, clipPath: to.clip }],
      { duration: dur(360), easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' }
    );
  } else {
    anim = img.animate([{ opacity: 1, transform: nowT }, { opacity: 0, transform: nowT + ' scale(.97)' }], { duration: dur(200), fill: 'forwards' });
  }
  await anim.finished.catch(() => {});
  el.style.visibility = '';
  root.hidden = true;
  anim.cancel();
  img.removeAttribute('src');
  document.documentElement.classList.remove('lb-lock');
  document.documentElement.style.paddingRight = '';
  pointers.clear(); pinch = null; drag = null;
  isOpen = false;
  busy = false;
  loadEl.hidden = true;
  if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
  else el.focus({ preventScroll: true });
}

async function step(dir) {
  if (busy || items.length < 2) return;
  const prev = items[index];
  const nextIndex = (index + dir + items.length) % items.length;
  const next = items[nextIndex];
  busy = true;
  cancelAnimationFrame(raf); raf = 0; last = 0;
  await img.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur(130), fill: 'forwards' }).finished.catch(() => {});
  prev.style.visibility = '';
  index = nextIndex;
  setCaption(next);
  await loadInto(next);
  s = gs = 1; x = y = gx = gy = 0; anchor = null;
  layout();
  updateChrome();
  next.style.visibility = 'hidden';
  img.style.transform = 'translate3d(0,0,0) scale(1)';
  const a = img.animate([{ opacity: 0, transform: `translate3d(${dir * 24}px,0,0) scale(.985)` }, { opacity: 1, transform: 'translate3d(0,0,0) scale(1)' }], { duration: dur(260), easing: EASE, fill: 'forwards' });
  await a.finished.catch(() => {});
  img.getAnimations().forEach(an => an.cancel());
  busy = false;
  render();
  upgrade(next, index);
}

function updateChrome() {
  const many = items.length > 1;
  prevBtn.hidden = nextBtn.hidden = !many;
  countEl.textContent = many ? `${index + 1} / ${items.length}` : '';
  captionEl.hidden = !captionEl.textContent.trim();
  layout();
}

/* ---------- wiring ---------- */

function decorate(scope = document) {
  scope.querySelectorAll(SELECTOR).forEach(el => {
    if (el.dataset.zoomReady || el.closest('.lb, a, button, [data-no-zoom]')) return;
    el.dataset.zoomReady = '1';
    el.classList.add('zoomable');
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    const label = el.alt ? `Zoom image: ${el.alt}` : 'Zoom image';
    el.setAttribute('aria-label', label.length > 140 ? label.slice(0, 137) + '…' : label);
  });
}

document.addEventListener('click', e => {
  const el = e.target instanceof Element ? e.target.closest('img.zoomable') : null;
  if (!el || !eligible(el)) return;
  e.preventDefault();
  open(el);
});
document.addEventListener('keydown', e => {
  if (isOpen) return onKey(e);
  if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof HTMLImageElement && e.target.classList.contains('zoomable')) {
    e.preventDefault();
    open(e.target);
  }
});

decorate();
new MutationObserver(muts => {
  for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) {
    if (n.matches?.('img')) decorate(n.parentNode); else decorate(n);
  }
}).observe(document.body, { childList: true, subtree: true });
