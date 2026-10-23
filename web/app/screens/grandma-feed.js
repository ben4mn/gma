// Grandma's Feed: every reaction, preset message and voice note from her frame,
// newest first under day headings, each with the photo it was about and who it
// went to. Voice notes play inline, only on a tap.
import { h, mount } from '../../shared/dom.js';
import { icon, REACTIONS } from '../../shared/icons.js';
import { api } from '../../shared/api.js';
import { formatTime, formatDuration, dayKey, dayLabel } from '../../shared/time.js';
import { session } from '../session.js';
import { readPage, renditionUrl, ownerOf, firstName, recipientLabel } from '../data.js';
import { infiniteList } from '../components/infinite-list.js';
import { pageHead } from './shell.js';

const LIMIT = 30;
let playing = null; // { audio, stop } — one voice note at a time

function toPill(event) {
  const to = recipientLabel(event, session.user);
  return h('span', { class: ['to', to.everyone && 'to--all'] }, icon(to.everyone ? 'people' : 'person'), to.text);
}

function thumbOf(event) {
  const item = event.item;
  const src = event.thumb_url ?? event.item_thumb ?? (item ? renditionUrl(item, 'thumb') : null) ?? event.family_photo_url;
  return src ? h('span', { class: 'print' }, h('img', { src, alt: '', loading: 'lazy', decoding: 'async' })) : null;
}

function aboutLine(event) {
  const item = event.item;
  if (!item) return null;
  const owner = ownerOf(item);
  const mine = owner.id && owner.id === session.user?.id;
  const what = item.kind === 'video' ? 'video' : 'photo';
  const whose = mine ? `your ${what}` : `${firstName(owner.name)}’s ${what}`;
  return h('p', { class: 'g-about' }, `on ${whose}`, item.caption ? [' ', h('q', null, item.caption)] : null);
}

/** Bars for the waveform, the same every time for the same note. */
function bars(seed, n = 22) {
  let x = 0;
  for (const ch of String(seed)) x = (x * 33 + ch.codePointAt(0)) >>> 0;
  return Array.from({ length: n }, () => {
    x = (x * 1103515245 + 12345) >>> 0;
    return 25 + (x % 70);
  });
}

function voicePlayer(event) {
  const note = event.voice_note ?? {};
  const id = note.id ?? event.voice_note_id;
  const duration = note.duration_ms ?? event.duration_ms ?? 0;
  const src = note.url ?? `/media/voice/${encodeURIComponent(id)}`;
  const wave = h('span', { class: 'wave', 'aria-hidden': 'true' }, bars(id ?? event.id).map((pct) => {
    const i = h('i');
    i.style.height = `${pct}%`;
    return i;
  }));
  const len = h('span', { class: 'vn-len' }, formatDuration(duration));
  const button = h('button', { type: 'button', class: 'vn-play', 'aria-pressed': 'false', 'aria-label': 'Play Grandma’s voice message' }, icon('play'));
  let audio = null;

  const paint = () => {
    const total = audio?.duration && Number.isFinite(audio.duration) ? audio.duration : duration / 1000;
    const frac = total ? (audio?.currentTime ?? 0) / total : 0;
    [...wave.children].forEach((bar, i) => bar.classList.toggle('on', i / wave.children.length < frac));
    len.textContent = audio && !audio.paused ? formatDuration((audio.currentTime ?? 0) * 1000) : formatDuration(duration);
  };
  const setPlaying = (on) => {
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute('aria-label', on ? 'Pause Grandma’s voice message' : 'Play Grandma’s voice message');
    mount(button, icon(on ? 'pause' : 'play'));
  };
  const stop = () => { audio?.pause(); };

  button.addEventListener('click', async () => {
    if (audio && !audio.paused) return stop();
    if (playing && playing.stop !== stop) playing.stop();
    if (!audio) {
      audio = new Audio();
      audio.preload = 'auto';
      audio.src = src;
      audio.addEventListener('timeupdate', paint);
      audio.addEventListener('play', () => setPlaying(true));
      audio.addEventListener('pause', () => { setPlaying(false); paint(); });
      audio.addEventListener('ended', () => { audio.currentTime = 0; paint(); });
      audio.addEventListener('error', () => { setPlaying(false); len.textContent = 'Can’t play'; });
    }
    playing = { stop };
    try { await audio.play(); } catch { setPlaying(false); }
  });
  return { node: h('div', { class: 'vn-row' }, button, wave, len), stop };
}

function feedItem(event, players) {
  const time = h('span', { class: 'g-time' }, formatTime(event.created_at));
  const attrs = { class: 'gitem', id: `e-${event.id}` };
  if (event.kind === 'voice') {
    const player = voicePlayer(event);
    players.push(player);
    return h('article', { ...attrs, class: 'gitem voice-note' },
      h('div', { class: 'vn-head' }, thumbOf(event),
        h('div', null,
          h('p', { class: 'g-what g-what--line' }, h('span', { class: 'lead' }, 'Grandma sent'), ' ', h('b', null, 'a voice message')),
          h('p', { class: 'g-about' }, 'to the whole family'))),
      player.node,
      h('p', { class: 'g-meta' }, toPill(event), time));
  }
  const what = event.kind === 'preset'
    ? h('p', { class: 'g-note' }, event.preset_text ?? event.text ?? '')
    : (() => {
      const info = REACTIONS[event.reaction] ?? { label: event.reaction, emoji: null };
      return h('p', { class: 'g-what' }, h('span', { class: 'lead' }, 'Grandma sent'), info.emoji ? h('img', { src: info.emoji, alt: '' }) : null, h('b', null, info.label));
    })();
  return h('article', attrs,
    thumbOf(event) ?? h('span', { class: 'print print--empty', 'aria-hidden': 'true' }),
    h('div', null, what, aboutLine(event), h('p', { class: 'g-meta' }, toPill(event), time)));
}

export function grandmaFeedScreen(main, ctx) {
  const listEl = h('div');
  const pillSlot = h('div');
  const footnote = h('p', { class: 'footnote' }, icon('lock'),
    'Everyone in the family sees what Grandma sends here. A reaction or a message notifies only the person who shared that photo.');
  mount(main,
    pageHead({ eyebrow: 'From her frame', title: 'Grandma’s Feed', sub: 'What Grandma sent the family, newest first.' }),
    pillSlot, listEl);

  let lastDay = null;
  let players = [];
  const wantHash = () => (location.hash.startsWith('#e-') ? location.hash.slice(1) : null);
  let target = wantHash();

  const list = infiniteList({
    container: listEl,
    load: async (before) => readPage(await api.get(`/api/grandma-events?limit=${LIMIT}${before ? `&before=${encodeURIComponent(before)}` : ''}`), 'events', LIMIT),
    onPage: (events) => {
      footnote.remove();
      for (const event of events) {
        const key = dayKey(event.created_at);
        if (key !== lastDay) {
          listEl.append(h('h2', { class: 'day' }, dayLabel(event.created_at)));
          lastDay = key;
        }
        listEl.append(feedItem(event, players));
      }
      listEl.append(footnote);
      if (target) {
        const el = document.getElementById(target);
        if (el) {
          el.scrollIntoView({ block: 'center' });
          target = null;
        }
      }
    },
    onEmpty: () => mount(listEl,
      h('div', { class: 'empty' }, h('p', { class: 'note-title' }, 'Nothing from Grandma yet'),
        h('p', null, 'When Grandma reacts to a photo, sends a message or records a voice note, it shows up here.')),
      footnote),
    onReset: () => {
      players.forEach((p) => p.stop());
      players = [];
      lastDay = null;
      mount(listEl);
    },
  });
  list.first().then(ctx.restoreScroll);

  const changed = () => {
    if (scrollY < 300) { mount(pillSlot); list.refresh(); return; }
    mount(pillSlot, h('button', { type: 'button', class: 'new-pill', onclick: () => { scrollTo({ top: 0 }); mount(pillSlot); list.refresh(); } }, 'Grandma sent something new. Tap to see it.'));
  };
  const onHash = () => { target = wantHash(); if (target) list.refresh(); };
  ctx.live.addEventListener('grandma.event', changed);
  ctx.live.addEventListener('reconnect', changed);
  addEventListener('hashchange', onHash);
  return () => {
    list.destroy();
    players.forEach((p) => p.stop());
    ctx.live.removeEventListener('grandma.event', changed);
    ctx.live.removeEventListener('reconnect', changed);
    removeEventListener('hashchange', onHash);
  };
}
