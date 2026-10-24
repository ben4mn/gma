// What the frame shows, built from GET /api/frame/state. Pure: no DOM, no fetch.
// normalizeItem() accepts the few shapes the server may send (a rendition map of
// URLs or {url} objects, or bare names), so the screens only see one shape.
// People are named by their short name everywhere on the frame ("3 photos from
// Mike", "Sent to Mike"); Ben sets it in /admin, and it defaults to the first word.

const RENDITIONS = ['thumb', 'display', 'large', 'poster', 'video'];

function renditionUrl(raw, name) {
  const r = raw.renditions;
  let found = null;
  if (Array.isArray(r)) found = r.find((x) => x?.name === name) ?? null;
  else if (r && typeof r === 'object') found = r[name] ?? null;
  if (typeof found === 'string') return found;
  if (found?.url) return found.url;
  if (found) return `/media/${raw.id}/${name}?v=${raw.ready_at ?? ''}`;
  return null;
}

function senderOf(raw) {
  const s = raw.sender ?? raw.user ?? raw.from ?? null;
  if (s && typeof s === 'object') return { id: s.id ?? null, name: s.name ?? '', shortName: s.short_name ?? '' };
  return {
    id: raw.user_id ?? null,
    name: typeof s === 'string' ? s : raw.user_name ?? raw.sender_name ?? '',
    shortName: raw.user_short_name ?? raw.sender_short_name ?? '',
  };
}

/** What Grandma calls someone: their short_name ("Mike"), else the first word of their name. */
export function shortName(name, short = '') {
  const chosen = typeof short === 'string' ? short.trim().replace(/\s+/g, ' ') : '';
  if (chosen) return chosen;
  return (typeof name === 'string' ? name.trim().split(/\s+/)[0] : '') ?? '';
}

export function normalizeItem(raw) {
  if (!raw || !raw.id) return null;
  const sender = senderOf(raw);
  const urls = Object.fromEntries(RENDITIONS.map((n) => [n, renditionUrl(raw, n)]));
  return {
    id: raw.id,
    kind: raw.kind === 'video' ? 'video' : 'photo',
    caption: (raw.caption ?? '').trim(),
    batchId: raw.batch_id ?? null,
    senderId: sender.id,
    // the frame names people the way Grandma does: "Mike", not "Michael Torres"
    senderName: shortName(sender.name, sender.shortName) || 'Your family',
    createdAt: raw.ready_at ?? raw.created_at ?? 0,
    width: raw.width ?? urlsDim(raw, 'width'),
    height: raw.height ?? urlsDim(raw, 'height'),
    durationMs: raw.duration_ms ?? null,
    thumb: urls.thumb ?? urls.display ?? urls.poster,
    display: urls.display ?? urls.poster ?? urls.large,
    poster: urls.poster ?? urls.display,
    video: urls.video,
  };
}

function urlsDim(raw, key) {
  const r = raw.renditions;
  const d = Array.isArray(r) ? r.find((x) => x?.name === 'display' || x?.name === 'poster') : r?.display ?? r?.poster;
  return d && typeof d === 'object' ? d[key] ?? null : null;
}

export function normalizeList(list) {
  return (Array.isArray(list) ? list : []).map(normalizeItem).filter(Boolean);
}

/**
 * The slideshow: photos and videos newest first, a video shown by its poster
 * (it plays only when she taps it open). Videos stay here for good, so one she
 * opened once, or one that left "New for you", can always be found again.
 */
export function slideshowItems(list) {
  return normalizeList(list)
    .filter((i) => i.display)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * "New for you" cards, one per upload batch, newest first, without anything
 * already seen on this frame. The server sends cards ({items: [...]}) or plain
 * items; plain items are grouped here by batch (an item without a batch is its own card).
 */
export function groupIntoCards(newList, seen = new Set()) {
  const groups = new Map();
  for (const entry of Array.isArray(newList) ? newList : []) {
    const isCard = Array.isArray(entry?.items);
    const members = isCard ? entry.items : [entry];
    // a card's sender and batch apply to items that don't carry their own
    const inherited = isCard ? { sender: entry.sender ?? entry.user, batch_id: entry.batch_id ?? entry.id } : {};
    for (const raw of members) {
      const item = normalizeItem({ ...inherited, ...raw });
      if (!item || seen.has(item.id)) continue;
      const key = `batch:${item.batchId ?? item.id}`;
      if (!groups.has(key)) groups.set(key, { key, items: [] });
      groups.get(key).items.push(item);
    }
  }
  const cards = [...groups.values()].map((card) => {
    card.items.sort((a, b) => a.createdAt - b.createdAt); // read a batch in the order it was taken
    card.senderName = card.items[0].senderName;
    card.newestAt = Math.max(...card.items.map((i) => i.createdAt));
    return card;
  });
  return cards.sort((a, b) => b.newestAt - a.newestAt);
}

function count(n, one, many) {
  return n === 1 ? one : `${n} ${many}`;
}

/** "Video from Sarah", "3 photos from Mike", "2 photos and a video from Mike". */
export function cardTitle(card) {
  const photos = card.items.filter((i) => i.kind === 'photo').length;
  const videos = card.items.length - photos;
  const from = ` from ${card.senderName}`;
  if (videos === 0) return (photos === 1 ? 'Photo' : `${photos} photos`) + from;
  if (photos === 0) return (videos === 1 ? 'Video' : `${videos} videos`) + from;
  return `${count(photos, 'A photo', 'photos')} and ${count(videos, 'a video', 'videos')}${from}`;
}

/** The card's headline: who sent it ("From Sarah"), so the name is never what a long title cuts off. */
export function cardFrom(card) {
  return `From ${card.senderName}`;
}

/** What came: "Photo", "Video", "3 photos", "2 photos and a video". */
export function cardKind(card) {
  const photos = card.items.filter((i) => i.kind === 'photo').length;
  const videos = card.items.length - photos;
  if (videos === 0) return photos === 1 ? 'Photo' : `${photos} photos`;
  if (photos === 0) return videos === 1 ? 'Video' : `${videos} videos`;
  return `${count(photos, 'A photo', 'photos')} and ${count(videos, 'a video', 'videos')}`;
}

export const QUOTE_MAX = 40; // longer captions wait for the photo screen rather than being cut off

/** The card's second line: a single photo's short caption, else what came and when. */
export function cardDetail(card, whenText) {
  const [only] = card.items;
  if (card.items.length === 1 && only.kind === 'photo' && only.caption && only.caption.length <= QUOTE_MAX) {
    return { kind: 'quote', text: `“${card.items[0].caption}”` };
  }
  return { kind: 'when', text: `${cardKind(card)} · ${whenText}` };
}

/** What Grandma reads after she sends something. Uses the name, never a guessed "she". */
export function sentLine(kind, name, reaction) {
  if (kind === 'preset') return `Your note is on its way to ${name}.`;
  return {
    love: `${name} will know you loved it.`,
    funny: `${name} will know it made you laugh.`,
    wow: `${name} will know it amazed you.`,
    thankful: `${name} will know you’re thankful.`,
  }[reaction] ?? `${name} will see it soon.`;
}

export const REACTIONS = [
  { id: 'love', label: 'Love', emoji: 'emoji_u2764.svg' },
  { id: 'funny', label: 'Funny', emoji: 'emoji_u1f602.svg' },
  { id: 'wow', label: 'Wow', emoji: 'emoji_u1f62e.svg' },
  { id: 'thankful', label: 'Thankful', emoji: 'emoji_u1f64f.svg' },
];

/** The family photo behind "Message to the whole family": a URL, an item, or nothing. */
export function familyPhotoUrl(value, fallbackItems = []) {
  if (typeof value === 'string' && value) return value;
  const item = value ? normalizeItem(value) ?? (value.url ? { display: value.url } : null) : null;
  const fallback = fallbackItems.find((i) => i?.kind !== 'video') ?? fallbackItems[0];
  return item?.display ?? fallback?.display ?? null;
}
