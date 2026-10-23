// One photo or video: the print, the sender's note, four reactions, "Send a
// message" (→ eight presets), Previous/Next, and a warm "Sent to Sarah" that
// returns by itself. A video plays only on a tap, in a <video> made for that tap.
import { h, photo, icon } from '../lib/dom.js';
import { openLayout } from '../lib/layout.js';
import { REACTIONS, sentLine } from '../lib/cards.js';
import { durationWords } from '../lib/time.js';

export const SENT_MS = 4000;
const MAX_PRESETS = 8;
// A video counts as seen once it has played this long (or to the end), not
// when it is opened: she may never have tapped Play.
export const VIDEO_SEEN_SECONDS = 3;

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

  // `media` and `overlay` belong to the viewer on screen now. A video left over
  // from an earlier viewer (no longer in the page) is never resumed.
  function playVideo(media, overlay) {
    if (video && (!video.isConnected || !media.contains(video))) destroyVideo();
    if (video) {
      // a paused video: carry on
      overlay.hidden = true;
      video.play().catch(() => { overlay.hidden = false; });
      return;
    }
    const it = item();
    const el = h('video', { class: 'video', playsinline: true, preload: 'auto', poster: it.poster });
    video = el;
    el.src = it.video;
    // Every handler checks it is still the current video, so a leftover element
    // can never hide this screen's Play button or keep the frame busy.
    const current = () => video === el;
    const seenOnce = () => { if (current()) ctx.markSeen(it.id); };
    el.addEventListener('playing', () => { if (current()) { overlay.hidden = true; ctx.setBusy(true); } });
    el.addEventListener('pause', () => { if (current()) { overlay.hidden = false; ctx.setBusy(false); } });
    el.addEventListener('timeupdate', () => { if (el.currentTime >= VIDEO_SEEN_SECONDS) seenOnce(); });
    el.addEventListener('ended', () => { if (!current()) return; seenOnce(); destroyVideo(); overlay.hidden = false; });
    el.addEventListener('error', () => { if (!current()) return; destroyVideo(); overlay.hidden = false; });
    // a tap on the playing video pauses it; the big button resumes
    el.addEventListener('click', () => { if (current()) el.pause(); });
    media.prepend(el);
    el.play().catch(() => { if (current()) overlay.hidden = false; });
  }

  // ----- the photo screen -----
  function viewScreen() {
    const it = item();
    // A photo is seen when it opens; a video only once it has played a little.
    if (it.kind !== 'video' || !it.video) ctx.markSeen(it.id);
    const { mode, photo: box } = openLayout(it);
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
      onClick: () => { index = (index + dir + items.length) % items.length; show(viewScreen()); },
    }, icon(dir < 0 ? 'prev' : 'next'), label);

    const print = h('figure', { class: 'print print--open' }, media, corners());
    const note = h('aside', { class: 'note note--open' },
      h('p', { class: 'note-from' }, it.kind === 'video' ? 'A video from' : 'A photo from'),
      h('p', { class: 'note-name' }, it.senderName),
      h('p', { class: 'note-when' }, ctx.when(it.createdAt)),
      it.caption && h('span', { class: 'note-rule', 'aria-hidden': 'true' }),
      it.caption && h('p', { class: 'note-text' }, it.caption));
    // the buttons below never move; only the print and its note change places
    const top = mode === 'pair'
      ? [h('div', { class: 'open-cell open-cell--pair' }, print, note)]
      : [h('div', { class: 'open-cell' }, print), note];

    return h('div', { class: 'viewer' },
      nav(-1, 'Previous'),
      h('div', { class: `viewer-main viewer-main--${mode}` },
        top,
        h('div', { class: 'reactions', role: 'group', 'aria-label': `Send ${it.senderName} a feeling` },
          REACTIONS.map((r) => h('button', {
            class: 'reaction', type: 'button',
            onClick: () => {
              destroyVideo(); // a playing video stops with the screen it was on
              ctx.send('react', { item_id: it.id, reaction: r.id });
              show(sentScreen({ reaction: r }));
            },
          }, h('img', { src: emoji(r.emoji), alt: '' }), h('span', {}, r.label)))),
        h('button', { class: 'send-btn', type: 'button', onClick: () => show(presetsScreen()) },
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
            // the text travels with the tap, so a preset Ben deletes meanwhile still arrives
            ctx.send('preset', { item_id: it.id, preset_id: p.id, preset_text: p.text });
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

  // Every screen change replaces the viewer, and its video goes with it: a
  // detached <video> would otherwise keep its sound or be resumed later.
  function show(el) {
    if (!el.classList.contains('sent')) clearTimeout(sentTimer);
    destroyVideo();
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
