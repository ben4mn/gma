// One photo or video: the print, the sender's note, four reactions, "Send a
// message" (→ eight presets), Previous/Next, and a warm "Sent to Sarah" that
// returns by itself. A video plays only on a tap, in a <video> made for that tap.
import { h, photo, icon } from '../lib/dom.js';
import { fitBox } from '../lib/layout.js';
import { REACTIONS, sentLine } from '../lib/cards.js';
import { durationWords } from '../lib/time.js';

export const SENT_MS = 4000;
const OPEN_BOX = { width: 624, height: 416 }; // the photo inside the 656x448 print
const MAX_PRESETS = 8;

function corners() {
  return ['tl', 'tr', 'br', 'bl'].map((c) => h('i', { class: `corner ${c}`, 'aria-hidden': 'true' }));
}

const emoji = (file) => `../assets/emoji/${file}`;

export function renderItem(ctx, params) {
  const items = params.items;
  let index = params.index ?? 0;
  let video = null;
  let sentTimer = null;
  const root = h('main', { class: 'screen-item' });

  const item = () => items[index];

  // ----- the video: made on tap, destroyed on leave -----
  function destroyVideo() {
    if (!video) return;
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
    video = null;
    ctx.setBusy(false);
  }

  function playVideo(media, overlay) {
    if (video) {
      // a paused video: carry on
      overlay.hidden = true;
      video.play().catch(() => { overlay.hidden = false; });
      return;
    }
    const it = item();
    video = h('video', { class: 'video', playsinline: true, preload: 'auto', poster: it.poster });
    video.src = it.video;
    video.addEventListener('playing', () => { overlay.hidden = true; ctx.setBusy(true); });
    video.addEventListener('pause', () => { overlay.hidden = false; ctx.setBusy(false); });
    video.addEventListener('ended', () => { destroyVideo(); overlay.hidden = false; });
    video.addEventListener('error', () => { destroyVideo(); overlay.hidden = false; });
    // a tap on the playing video pauses it; the big button resumes
    video.addEventListener('click', () => video?.pause());
    media.prepend(video);
    video.play().catch(() => { overlay.hidden = false; });
  }

  // ----- the photo screen -----
  function viewScreen() {
    const it = item();
    ctx.markSeen(it.id);
    const box = fitBox(it.width, it.height, OPEN_BOX.width, OPEN_BOX.height);
    const media = h('div', { class: 'media', style: { width: `${box.width}px`, height: `${box.height}px` } },
      photo(it.kind === 'video' ? it.poster : it.display, { alt: it.caption || `A ${it.kind} from ${it.senderName}` }));
    if (it.kind === 'video' && it.video) {
      const length = durationWords(it.durationMs);
      const overlay = h('button', { class: 'play-big', type: 'button', 'aria-label': 'Play the video' },
        h('span', { class: 'disc' }, icon('play')),
        h('span', { class: 'plate' }, length ? `Play video · ${length}` : 'Play video'));
      overlay.addEventListener('click', () => playVideo(media, overlay));
      media.append(overlay);
    }
    const many = items.length > 1;
    const nav = (dir, label) => h('button', {
      class: 'nav-arrow', type: 'button',
      style: { visibility: many ? 'visible' : 'hidden' },
      onClick: () => { destroyVideo(); index = (index + dir + items.length) % items.length; show(viewScreen()); },
    }, icon(dir < 0 ? 'prev' : 'next'), label);

    return h('div', { class: 'viewer' },
      nav(-1, 'Previous'),
      h('div', { class: 'viewer-main' },
        h('div', { class: 'open-cell' }, h('figure', { class: 'print print--open' }, media, corners())),
        h('aside', { class: 'note note--open' },
          h('p', { class: 'note-from' }, it.kind === 'video' ? 'A video from' : 'A photo from'),
          h('p', { class: 'note-name' }, it.senderName),
          h('p', { class: 'note-when' }, ctx.when(it.createdAt)),
          it.caption && h('span', { class: 'note-rule', 'aria-hidden': 'true' }),
          it.caption && h('p', { class: 'note-text' }, it.caption)),
        h('div', { class: 'reactions', role: 'group', 'aria-label': `Send ${it.senderName} a feeling` },
          REACTIONS.map((r) => h('button', {
            class: 'reaction', type: 'button',
            onClick: () => {
              ctx.send('react', { item_id: it.id, reaction: r.id });
              show(sentScreen({ reaction: r }));
            },
          }, h('img', { src: emoji(r.emoji), alt: '' }), h('span', {}, r.label)))),
        h('button', { class: 'send-btn', type: 'button', onClick: () => { destroyVideo(); show(presetsScreen()); } },
          icon('message'), 'Send a message')),
      nav(1, 'Next'));
  }

  // ----- eight presets, plainly for one person -----
  function presetsScreen() {
    const it = item();
    return h('section', { class: 'presets', 'aria-labelledby': 'presets-title' },
      h('div', { class: 'presets-head' },
        h('span', { class: 'print' }, photo(it.thumb)),
        h('div', {},
          h('h1', { class: 'presets-title', id: 'presets-title' }, `Send ${it.senderName} a message`),
          h('p', { class: 'presets-sub' }, icon('person'),
            h('span', {}, 'It goes to ', h('b', {}, `${it.senderName} only`), '. One tap sends it.')))),
      h('div', { class: 'preset-grid' },
        ctx.state.presets.slice(0, MAX_PRESETS).map((p) => h('button', {
          class: 'preset', type: 'button',
          onClick: () => {
            ctx.send('preset', { item_id: it.id, preset_id: p.id });
            show(sentScreen({ preset: p }));
          },
        }, p.text))),
      h('div', { class: 'presets-foot' },
        h('button', { class: 'back-btn', type: 'button', onClick: () => show(viewScreen()) }, icon('back'), 'Back to the photo')));
  }

  // ----- sent: warm, brief, and back by itself -----
  function sentScreen({ reaction, preset }) {
    const it = item();
    const back = () => { clearTimeout(sentTimer); show(viewScreen()); };
    sentTimer = setTimeout(back, SENT_MS);
    const tucked = reaction
      ? h('span', { class: 'sent-badge' }, h('img', { src: emoji(reaction.emoji), alt: '' }), h('span', {}, reaction.label))
      : h('span', { class: 'sent-note' }, preset.text);
    return h('div', { class: 'sent', role: 'status', 'aria-live': 'polite' },
      h('figure', { class: 'print sent-print' }, photo(it.kind === 'video' ? it.poster : it.display), tucked),
      h('div', { class: 'sent-words' },
        h('p', { class: 'sent-check' }, icon('check'), 'Done'),
        h('p', { class: 'sent-title' }, `Sent to ${it.senderName}`),
        h('p', { class: 'sent-sub' }, sentLine(reaction ? 'react' : 'preset', it.senderName, reaction?.id)),
        h('button', { class: 'ok-btn', type: 'button', onClick: back }, 'OK')));
  }

  function show(el) {
    if (!el.classList.contains('sent')) clearTimeout(sentTimer);
    root.replaceChildren(el);
  }

  // fixture screenshots can open straight on a sub-screen
  if (params.view === 'presets') show(presetsScreen());
  else if (params.view === 'sent') show(sentScreen(params.preset ? { preset: params.preset } : { reaction: REACTIONS.find((r) => r.id === (params.reaction ?? 'love')) }));
  else show(viewScreen());

  return {
    el: root,
    removed(id) { return items.some((i) => i.id === id); },
    destroy() { clearTimeout(sentTimer); destroyVideo(); },
  };
}
