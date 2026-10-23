// Full-screen viewer: a photo you can pinch to zoom, or a video with the
// browser's own controls. Nothing plays until it's tapped. Back closes it.
import { h, mount } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { whenLabel, formatDuration } from '../../shared/time.js';
import { renditionUrl, hasRendition, ownerOf } from '../data.js';

const MAX_SCALE = 5;

/** Pinch to zoom, drag when zoomed, double-tap to zoom in or out, swipe to move on. */
function zoomable(stage, img, { onSwipe }) {
  let s = 1, tx = 0, ty = 0;
  const pts = new Map();
  let gesture = null;
  let lastTap = 0;

  const apply = () => { img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`; };
  const local = (e) => {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left - img.offsetLeft, y: e.clientY - r.top - img.offsetTop };
  };
  const clamp = () => {
    if (s <= 1.01) { s = 1; tx = 0; ty = 0; return; }
    tx = Math.min(0, Math.max(img.offsetWidth * (1 - s), tx));
    ty = Math.min(0, Math.max(img.offsetHeight * (1 - s), ty));
  };
  const begin = () => {
    const [a, b] = [...pts.values()];
    if (b) {
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      gesture = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: s, u: { x: (mid.x - tx) / s, y: (mid.y - ty) / s } };
    } else if (a) {
      gesture = { kind: 'pan', p0: a, t0: { x: tx, y: ty }, moved: false };
    }
  };

  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, local(e));
    begin();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !gesture) return;
    pts.set(e.pointerId, local(e));
    const [a, b] = [...pts.values()];
    if (gesture.kind === 'pinch' && b) {
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      s = Math.min(MAX_SCALE, Math.max(1, gesture.s0 * (Math.hypot(a.x - b.x, a.y - b.y) / gesture.d0)));
      tx = mid.x - gesture.u.x * s;
      ty = mid.y - gesture.u.y * s;
      apply();
    } else if (gesture.kind === 'pan') {
      const dx = a.x - gesture.p0.x;
      const dy = a.y - gesture.p0.y;
      if (Math.abs(dx) + Math.abs(dy) > 8) gesture.moved = true;
      if (s > 1) {
        tx = gesture.t0.x + dx;
        ty = gesture.t0.y + dy;
        clamp();
        apply();
      }
    }
  });
  const end = (e) => {
    const was = gesture;
    const last = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    if (was?.kind === 'pan' && last) {
      const dx = last.x - was.p0.x;
      if (s === 1 && was.moved && Math.abs(dx) > 60) onSwipe(dx < 0 ? 1 : -1);
      else if (!was.moved) {
        const now = Date.now();
        if (now - lastTap < 300) {
          if (s > 1) { s = 1; tx = 0; ty = 0; } else { s = 2.5; tx = last.x - last.x * s; ty = last.y - last.y * s; clamp(); }
          img.style.transition = 'transform 160ms ease';
          apply();
          setTimeout(() => { img.style.transition = ''; }, 180);
          lastTap = 0;
        } else lastTap = now;
      }
    }
    clamp();
    apply();
    begin();
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

function stageFor(item, onSwipe) {
  const stage = h('div', { class: 'viewer-stage' });
  if (item.kind === 'video') {
    stage.classList.add('is-video');
    // preload="none": nothing downloads or plays until the play button is tapped.
    const video = h('video', { controls: true, playsinline: true, preload: 'none', poster: renditionUrl(item, 'poster') });
    const src = renditionUrl(item, 'video');
    if (src) video.src = src;
    stage.append(video);
    return { stage, stop: () => { video.pause(); video.removeAttribute('src'); video.load(); } };
  }
  const src = hasRendition(item, 'large') ? renditionUrl(item, 'large') : renditionUrl(item, 'display');
  const img = h('img', { src, alt: item.caption || `Photo from ${ownerOf(item).name}`, draggable: 'false' });
  stage.append(img);
  zoomable(stage, img, { onSwipe });
  return { stage, stop: () => {} };
}

/** Open items[index] full screen. Returns a function that closes it. */
export function openViewer(items, index = 0) {
  const ready = items.filter((i) => i.status === 'ready' || !i.status);
  let at = Math.max(0, ready.indexOf(items[index]));
  let shown = null;
  const opener = document.activeElement;
  const root = h('div', { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Photo viewer' });

  const close = () => history.back();
  function teardown() {
    shown?.stop();
    root.remove();
    removeEventListener('popstate', onPop);
    removeEventListener('keydown', onKey);
    document.body.style.overflow = '';
    opener?.focus?.({ preventScroll: true });
  }
  const onPop = () => teardown();
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight') go(1);
    if (e.key === 'ArrowLeft') go(-1);
  };
  function go(step) {
    const next = at + step;
    if (next < 0 || next >= ready.length) return;
    at = next;
    draw();
  }

  function draw() {
    const item = ready[at];
    const owner = ownerOf(item);
    shown?.stop();
    shown = stageFor(item, go);
    const closeBtn = h('button', { type: 'button', class: 'viewer-btn', onclick: close }, icon('close'), 'Close');
    mount(root,
      h('div', { class: 'viewer-bar' }, closeBtn,
        ready.length > 1 ? h('p', { class: 'viewer-count' }, `${at + 1} of ${ready.length}`) : null),
      shown.stage,
      h('div', { class: 'viewer-foot' },
        h('div', { class: 'byline' },
          h('p', { class: 'who' }, owner.name),
          h('p', { class: 'when' }, item.kind === 'video' && item.duration_ms ? `Video · ${formatDuration(item.duration_ms)}` : whenLabel(item.created_at))),
        item.caption ? h('p', { class: 'caption' }, item.caption) : null,
        ready.length > 1 ? h('div', { class: 'viewer-nav' },
          h('button', { type: 'button', class: 'viewer-btn', disabled: at === 0, onclick: () => go(-1) }, icon('back'), 'Previous'),
          h('button', { type: 'button', class: 'viewer-btn', disabled: at === ready.length - 1, onclick: () => go(1) }, 'Next', icon('next'))) : null));
    closeBtn.focus({ preventScroll: true });
  }

  history.pushState({ viewer: true }, '', `${location.pathname}${location.search}#view`);
  addEventListener('popstate', onPop);
  addEventListener('keydown', onKey);
  document.body.style.overflow = 'hidden';
  document.body.append(root);
  draw();
  return close;
}
