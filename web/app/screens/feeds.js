// Family (everyone's uploads, newest first) and Mine (yours, with what Grandma
// sent back). Both load by cursor as you scroll and update live.
import { h, mount, confirmButton } from '../../shared/dom.js';
import { icon, REACTIONS } from '../../shared/icons.js';
import { api } from '../../shared/api.js';
import { whenLabel, formatTime, formatDuration } from '../../shared/time.js';
import { session } from '../session.js';
import { readPage, renditionUrl, ownerOf, grandmaOn, firstName, initialOf, colourFor } from '../data.js';
import { mergeIntoPosts, removeFromPosts } from '../grouping.js';
import { infiniteList } from '../components/infinite-list.js';
import { pageHead, uploadButton, errorNote } from './shell.js';
import { openViewer } from './viewer.js';
import { setupPrompts } from './prompts.js';

const LIMIT = 24;

function photoImg(item, { sizes = '(min-width: 560px) 520px, 92vw' } = {}) {
  const owner = ownerOf(item);
  const isVideo = item.kind === 'video';
  const thumb = renditionUrl(item, 'thumb');
  const big = renditionUrl(item, isVideo ? 'poster' : 'display');
  const img = h('img', {
    src: big ?? thumb ?? '',
    alt: isVideo ? `Video from ${owner.name}${item.caption ? `: ${item.caption}` : ''}` : item.caption || `Photo from ${owner.name}`,
    loading: 'lazy',
    decoding: 'async',
  });
  if (thumb && big) {
    img.srcset = `${thumb} 480w, ${big} 1600w`;
    img.sizes = sizes;
  }
  return img;
}

function videoBadges(item, small = false) {
  if (item.kind !== 'video') return [];
  return [
    h('span', { class: 'play', 'aria-hidden': 'true' }, icon('play')),
    small ? null : h('span', { class: 'plate' }, item.duration_ms ? `Video · ${formatDuration(item.duration_ms)}` : 'Video'),
  ];
}

function photoArea(post) {
  const items = post.items;
  const open = (i) => () => openViewer(items, i);
  if (items.length === 1) {
    const item = items[0];
    const tall = item.height && item.width && item.height > item.width;
    return h('button', { type: 'button', class: ['photo', tall && 'tall'], onclick: open(0), 'aria-label': item.kind === 'video' ? `Play the video from ${ownerOf(item).name}` : `Open the photo from ${ownerOf(item).name}` },
      photoImg(item), ...videoBadges(item));
  }
  const shown = items.slice(0, 3);
  const photos = items.filter((i) => i.kind !== 'video').length;
  const videos = items.length - photos;
  const count = [photos && `${photos} photo${photos === 1 ? '' : 's'}`, videos && `${videos} video${videos === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
  return h('div', { class: ['photo', 'sheet', shown.length === 2 && 'two'] },
    shown.map((item, i) => h('button', { type: 'button', class: 'sheet-cell', onclick: open(i), 'aria-label': `Open ${i + 1} of ${items.length}` },
      photoImg(item, { sizes: i === 0 ? '60vw' : '30vw' }), ...videoBadges(item, true))),
    h('span', { class: 'plate' }, count));
}

function avatar(user) {
  const el = h('span', { class: 'avatar', 'aria-hidden': 'true' }, initialOf(user.name));
  el.style.background = colourFor(user);
  return el;
}

function familyPost(post) {
  const first = post.items[0];
  const owner = ownerOf(first);
  const caption = post.items.find((i) => i.caption)?.caption;
  return h('article', { class: 'post' },
    h('div', { class: 'print' },
      photoArea(post),
      h('div', { class: 'post-mat' },
        h('div', { class: 'byline' }, avatar(owner), h('p', { class: 'who' }, owner.name), h('p', { class: 'when' }, whenLabel(first.created_at))),
        caption ? h('p', { class: 'caption' }, caption) : null)));
}

function grandmaChips(item) {
  const replies = grandmaOn(item);
  if (!replies.length) return h('p', { class: 'waiting' }, 'When Grandma reacts, it shows here.');
  return h('div', { class: 'chips' }, replies.map((r) => {
    if (r.kind === 'preset') return h('span', { class: 'chip chip--note' }, `“${r.preset_text ?? r.text ?? ''}”`);
    const info = REACTIONS[r.reaction];
    if (!info) return null;
    return h('span', { class: 'chip' }, h('img', { src: info.emoji, alt: '' }), info.label, h('small', null, formatTime(r.created_at)));
  }));
}

function minePost(item, { onDelete }) {
  const del = confirmButton({ label: 'Delete', confirmLabel: 'Tap again to delete it for everyone', onConfirm: () => onDelete(item) });
  const title = item.caption || (item.kind === 'video' ? 'Your video' : 'Your photo');
  let area;
  if (item.status === 'processing') {
    area = h('div', { class: 'getting-ready', role: 'status' }, 'Getting it ready…', h('small', null, 'It shows on Grandma’s frame as soon as it’s done.'));
  } else if (item.status === 'failed') {
    area = h('div', { class: 'getting-ready getting-ready--failed', role: 'status' }, 'This one didn’t work.', h('small', null, item.error || 'You can delete it and try sending it again.'));
  } else {
    area = photoArea({ items: [item] });
  }
  return h('article', { class: 'post' },
    h('div', { class: 'print' },
      area,
      h('div', { class: 'post-mat' },
        h('div', { class: 'byline' }, h('p', { class: 'who who--caption' }, title), h('p', { class: 'when' }, whenLabel(item.created_at))),
        item.status === 'ready' || !item.status
          ? h('div', { class: 'from-gma' }, h('p', { class: 'from-gma-label' }, 'From Grandma'), grandmaChips(item))
          : null,
        h('div', { class: 'post-actions' }, del))));
}

function emptyCard(scope) {
  return scope === 'family'
    ? h('div', { class: 'empty' }, h('p', { class: 'note-title' }, 'Nothing here yet'), h('p', null, 'Be the first to share a photo with Grandma.'))
    : h('div', { class: 'empty' }, h('p', { class: 'note-title' }, 'You haven’t shared anything yet'), h('p', null, 'Photos and videos you send show up here, with what Grandma sends back.'));
}

function feedScreen(main, ctx, scope) {
  const user = session.user;
  const head = scope === 'family'
    ? pageHead({ eyebrow: 'On Grandma’s frame', title: 'Family', sub: 'Everyone’s photos and videos, newest first.' })
    : pageHead({ eyebrow: `Shared by you, ${firstName(user.name)}`, title: 'Mine', sub: 'What you shared, and what Grandma sent back.' });
  const prompts = h('div');
  const pillSlot = h('div');
  const listEl = h('div', { class: 'posts' });
  mount(main, head, prompts, uploadButton(), pillSlot, listEl);
  const stopPrompts = scope === 'family' ? setupPrompts(prompts) : null;

  let posts = [];
  const render = (from) => {
    while (listEl.children.length > from) listEl.lastElementChild.remove();
    for (const post of posts.slice(from)) {
      listEl.append(scope === 'family' ? familyPost(post) : minePost(post.items[0], { onDelete }));
    }
  };

  async function onDelete(item) {
    try {
      await api.del(`/api/items/${encodeURIComponent(item.id)}`);
      posts = removeFromPosts(posts, item.id);
      render(0);
      if (!posts.length) mount(listEl, emptyCard(scope));
    } catch (err) {
      mount(pillSlot, errorNote(err.message));
    }
  }

  const list = infiniteList({
    container: listEl,
    load: async (before) => readPage(await api.get(`/api/items?scope=${scope}&limit=${LIMIT}${before ? `&before=${encodeURIComponent(before)}` : ''}`), 'items', LIMIT),
    onPage: (items) => {
      if (scope === 'mine') {
        // Mine shows each upload on its own, with its own status and replies.
        const seen = new Set(posts.map((p) => p.id));
        const before = posts.length;
        posts = posts.concat(items.filter((i) => !seen.has(i.id)).map((i) => ({ id: i.id, batchId: null, items: [i] })));
        render(before);
        return;
      }
      const merged = mergeIntoPosts(posts, items);
      posts = merged.posts;
      render(merged.firstChanged);
    },
    onEmpty: () => mount(listEl, emptyCard(scope)),
    onReset: () => { posts = []; mount(listEl); },
  });
  list.first().then(ctx.restoreScroll);

  // Live: refresh in place near the top; further down, offer a pill instead of moving the page.
  const changed = () => {
    if (scrollY < 300) { mount(pillSlot); list.refresh(); return; }
    mount(pillSlot, h('button', { type: 'button', class: 'new-pill', onclick: () => { scrollTo({ top: 0 }); mount(pillSlot); list.refresh(); } },
      scope === 'family' ? 'Something new. Tap to see it.' : 'Your uploads changed. Tap to see them.'));
  };
  const onRemoved = (e) => {
    const id = e.detail?.item_id ?? e.detail?.id;
    if (!id) return changed();
    posts = removeFromPosts(posts, id);
    render(0);
  };
  const topics = scope === 'family' ? ['item.ready', 'reconnect'] : ['item.ready', 'item.failed', 'grandma.event', 'reconnect'];
  for (const t of topics) ctx.live.addEventListener(t, changed);
  ctx.live.addEventListener('item.removed', onRemoved);

  return () => {
    list.destroy();
    stopPrompts?.();
    for (const t of topics) ctx.live.removeEventListener(t, changed);
    ctx.live.removeEventListener('item.removed', onRemoved);
  };
}

export const familyScreen = (main, ctx) => feedScreen(main, ctx, 'family');
export const mineScreen = (main, ctx) => feedScreen(main, ctx, 'mine');
