// Pure readers for the server's JSON. They accept the shapes the contract
// describes and a few obvious variants, so a renamed field shows up in one place.
import { REACTIONS } from '../shared/icons.js';

/** URL of an item's rendition: the server's own URL when it sends one, else the contract's path. */
export function renditionUrl(item, name) {
  const r = item?.renditions;
  const entry = Array.isArray(r) ? r.find((x) => x.name === name) : r?.[name];
  if (typeof entry === 'string') return entry;
  if (entry?.url) return entry.url;
  if (r && !entry) return null;
  const v = item?.ready_at ? `?v=${item.ready_at}` : '';
  return `/media/${encodeURIComponent(item.id)}/${name}${v}`;
}

export function hasRendition(item, name) {
  const r = item?.renditions;
  if (!r) return item?.status === 'ready';
  return Array.isArray(r) ? r.some((x) => x.name === name) : Boolean(r[name]);
}

/** → { list, next } from a paginated response; `next` is the cursor for ?before=, or null at the end. */
export function readPage(res, key, limit) {
  const list = Array.isArray(res) ? res : res?.[key] ?? res?.items ?? res?.data ?? [];
  let next = Array.isArray(res) ? undefined : res?.next_before ?? res?.next_cursor ?? res?.next ?? res?.before;
  if (next === undefined) next = list.length >= limit && list.length ? list.at(-1).id : null;
  return { list, next: next || null };
}

export function ownerOf(item) {
  return item?.user ?? item?.owner ?? { id: item?.user_id, name: item?.user_name ?? item?.owner_name ?? 'Someone' };
}

/** Grandma's reactions and preset messages on an item, oldest first. */
export function grandmaOn(item) {
  const list = item?.grandma_events ?? item?.reactions ?? item?.grandma ?? [];
  return list.slice().sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
}

export function reactionInfo(name) {
  return REACTIONS[name] ?? null;
}

/** First name for friendly copy: "Sarah" from "Sarah Lee". */
export function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'Someone';
}

export function initialOf(name) {
  return (String(name || '').trim()[0] || '?').toUpperCase();
}

const AVATAR_COLOURS = ['#8A3517', '#3A5236', '#6B4F1D', '#3D4A55'];

/** A person's colour: theirs if it's a hex, else a stable pick from the Heirloom avatar colours. */
export function colourFor(user) {
  if (/^#[0-9a-f]{6}$/i.test(user?.color ?? '')) return user.color;
  const seed = String(user?.id ?? user?.name ?? '');
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLOURS[hash % AVATAR_COLOURS.length];
}

/** The recipient of a Grandma event as the reader should see it. */
export function recipientLabel(event, me) {
  const r = event?.recipient ?? (event?.recipient_user_id ? { id: event.recipient_user_id, name: event.recipient_name } : null);
  if (!r || !r.id) return { everyone: true, text: 'To everyone' };
  if (me && r.id === me.id) return { everyone: false, text: 'To you' };
  return { everyone: false, text: `To ${firstName(r.name)}` };
}
