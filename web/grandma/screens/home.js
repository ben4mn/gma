// Home: the slideshow print (left, as large as the screen allows, standing at the
// top of its area so no empty band sits above it), "New for you" (right), and
// "Message to the whole family" below it.
import { h, photo, icon } from '../lib/dom.js';
import { heroLayout, HERO, HERO_AREA } from '../lib/layout.js';
import { cardTitle, cardDetail } from '../lib/cards.js';

export const SLIDE_MS = 40_000;
const FADE_MS = 1600;
const MAX_CARDS = 3;

function corners() {
  return ['tl', 'tr', 'br', 'bl'].map((c) => h('i', { class: `corner ${c}`, 'aria-hidden': 'true' }));
}

/** One slide: a print sized to the photo's own shape, with the sender's words. */
export function slideFor(item, ctx, area = HERO_AREA) {
  const layout = heroLayout(item, area);
  const img = photo(item.display, { alt: item.caption || `A photo from ${item.senderName}` });
  const print = h('figure', { class: 'print print--hero' },
    h('div', { class: 'print-photo', style: { width: `${layout.photo.width}px`, height: `${layout.photo.height}px` } }, img),
    layout.mode === 'landscape' && h('figcaption', { class: 'mat-caption' },
      h('span', { class: 'who' }, item.senderName),
      h('span', { class: 'what' }, item.caption),
      h('span', { class: 'when' }, ctx.when(item.createdAt))),
    corners());
  const children = [print];
  if (layout.mode === 'portrait') {
    children.push(h('div', { class: 'note' },
      h('p', { class: 'note-from' }, 'From'),
      h('p', { class: 'note-name' }, item.senderName),
      h('p', { class: 'note-when' }, ctx.when(item.createdAt)),
      item.caption && h('span', { class: 'note-rule', 'aria-hidden': 'true' }),
      item.caption && h('p', { class: 'note-text' }, item.caption)));
  }
  return { el: h('div', { class: `slide slide--${layout.mode}` }, children), img };
}

function cardArt(card) {
  const first = card.items[0];
  if (card.items.length > 1) {
    return h('span', { class: 'pcard-art stack' },
      card.items.slice(0, 3).reverse().map((i) => h('span', { class: 'print' }, photo(i.thumb))));
  }
  return h('span', { class: 'pcard-art' },
    h('span', { class: 'print' }, photo(first.thumb)),
    first.kind === 'video' && h('span', { class: 'play-badge', 'aria-hidden': 'true', html: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M4 2.5v15l13-7.5z"/></svg>' }));
}

function newCard(card, ctx) {
  const detail = cardDetail(card, ctx.when(card.newestAt));
  return h('button', {
    class: 'pcard', type: 'button',
    onClick: () => ctx.go('item', { items: card.items, index: 0 }),
  },
  cardArt(card),
  h('span', { class: 'pcard-text' },
    h('span', { class: 'pcard-title' }, cardTitle(card)),
    h('span', { class: detail.kind === 'quote' ? 'pcard-quote' : 'pcard-meta' }, detail.text)));
}

export function renderHome(ctx) {
  const { slideshow, cards, familyPhoto } = ctx.state;
  const hero = h('div', { class: 'hero', role: 'button', tabindex: '0', 'aria-label': 'Open this photo' });
  const stage = h('main', { class: 'stage stage--home' }, hero,
    h('section', { class: 'new', 'aria-labelledby': 'new-title' },
      h('h2', { class: 'new-title', id: 'new-title' }, 'New for you'),
      cards.length
        ? cards.slice(0, MAX_CARDS).map((c) => newCard(c, ctx))
        : h('p', { class: 'new-empty' }, 'You’ve seen everything new. More will show up here.'),
      h('button', { class: 'voice', type: 'button', onClick: () => ctx.go('voice') },
        familyPhoto ? h('span', { class: 'print' }, photo(familyPhoto)) : h('span'),
        h('span', { class: 'voice-label' },
          h('span', { class: 'voice-mic' }, icon('mic')),
          h('span', { class: 'voice-text' }, 'Message to the whole family')))));

  // ----- the slideshow -----
  // Back on the same photo after a redraw, even when newer ones sorted in ahead of it.
  const sameSlide = ctx.slideId ? slideshow.findIndex((i) => i.id === ctx.slideId) : -1;
  let index = sameSlide >= 0 ? sameSlide : Math.min(ctx.slideIndex ?? 0, Math.max(0, slideshow.length - 1));
  let current = null;
  let timer = null;
  let paused = false;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  hero.addEventListener('click', () => {
    if (slideshow.length) ctx.go('item', { items: slideshow, index });
  });

  async function show(i, { fade = true, tries = slideshow.length } = {}) {
    if (!slideshow.length) {
      hero.replaceChildren(h('p', { class: 'hero-empty' }, 'Photos from the family will show here.'));
      return;
    }
    const item = slideshow[i];
    const { el, img } = slideFor(item, ctx);
    try {
      await img.decode();
    } catch {
      // not saved and no internet: try the next photo instead of showing a hole
      if (tries > 1) return show((i + 1) % slideshow.length, { fade, tries: tries - 1 });
    }
    index = i;
    ctx.slideIndex = i;
    ctx.slideId = item.id;
    const old = current;
    current = el;
    hero.append(el);
    if (fade && old && !still) {
      el.classList.add('is-entering');
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-on')));
      setTimeout(() => old.remove(), FADE_MS + 100);
    } else {
      el.classList.add('is-on');
      old?.remove();
    }
  }

  function schedule() {
    clearInterval(timer);
    if (!paused && slideshow.length > 1) {
      timer = setInterval(() => show((index + 1) % slideshow.length), SLIDE_MS);
    }
  }

  show(index, { fade: false });
  paused = Boolean(ctx.night);
  schedule();

  return {
    el: stage,
    /** At night the slideshow rests on one print; in the morning it carries on. */
    setPaused(value) { paused = value; schedule(); },
    currentItem() { return slideshow[index] ?? null; },
    destroy() { clearInterval(timer); },
  };
}

export { HERO };
