// Pure helpers that shape lists for the screens.
import { dayKey, dayLabel } from '../shared/time.js';

/** Group entries under day headings ("Today", "Yesterday", "Sunday"), keeping their order. */
export function groupByDay(entries, { now = Date.now(), timeZone, timeOf = (e) => e.created_at } = {}) {
  const groups = [];
  for (const entry of entries) {
    const key = dayKey(timeOf(entry), timeZone);
    let group = groups.at(-1);
    if (!group || group.key !== key) {
      group = { key, label: dayLabel(timeOf(entry), now, timeZone), entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

const ownerOf = (item) => item.user?.id ?? item.user_id ?? null;

/**
 * Fold a page of items into posts: neighbours from the same upload batch (same
 * batch_id, same person) share one post, like Mike's three photos on one mat.
 * Returns the new posts and the index of the first post that changed, so the
 * screen re-renders only from there (a batch can straddle two pages).
 */
export function mergeIntoPosts(posts, items) {
  const next = posts.slice();
  let firstChanged = next.length;
  for (const item of items) {
    const last = next.at(-1);
    const joins = last && item.batch_id && last.batchId === item.batch_id && ownerOf(last.items[0]) === ownerOf(item);
    if (joins) {
      if (last.items.some((i) => i.id === item.id)) continue;
      next[next.length - 1] = { ...last, items: [...last.items, item] };
      firstChanged = Math.min(firstChanged, next.length - 1);
    } else {
      if (next.some((p) => p.items.some((i) => i.id === item.id))) continue;
      next.push({ id: item.id, batchId: item.batch_id ?? null, items: [item] });
    }
  }
  return { posts: next, firstChanged };
}

/** Drop one item from the posts (deleted or hidden), removing posts left empty. */
export function removeFromPosts(posts, itemId) {
  return posts
    .map((p) => (p.items.some((i) => i.id === itemId) ? { ...p, items: p.items.filter((i) => i.id !== itemId) } : p))
    .filter((p) => p.items.length > 0);
}
