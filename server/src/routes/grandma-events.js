// Grandma's Feed: GET /api/grandma-events?before=<id>&limit=
//
// Every reaction, preset message and voice note from the frame, newest first.
// The feed is shared (DECISIONS.md, 2026-10-22): every relative sees every
// event, with the photo it was about, who sent that photo and who it went to.
//
// The serializers live in lib/grandma-feed.js and lib/renditions.js.

import { requireUser, httpError } from '../lib/guards.js';
import { FEED_SELECT, feedEventsJson } from '../lib/grandma-feed.js';
import { isId } from '../lib/ids.js';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export function parseLimit(raw, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw httpError(400, 'bad_limit', 'The page size must be a whole number.');
  return Math.min(n, max);
}

export default async function grandmaEventRoutes(app, { db }) {
  app.get('/api/grandma-events', { preHandler: requireUser }, async (request) => {
    const { before } = request.query;
    const limit = parseLimit(request.query.limit);
    if (before !== undefined && !isId(before)) {
      throw httpError(400, 'bad_cursor', "That page link didn't look right. Please reload.");
    }

    // ULIDs sort by creation time, so the id is the feed's time order and its cursor.
    const rows = before
      ? db.prepare(`${FEED_SELECT} WHERE e.id < ? ORDER BY e.id DESC LIMIT ?`).all(before, limit)
      : db.prepare(`${FEED_SELECT} ORDER BY e.id DESC LIMIT ?`).all(limit);

    return {
      events: feedEventsJson(db, rows),
      next_before: rows.length === limit ? rows.at(-1).id : null,
    };
  });
}
