// GET /healthz: is the app up, can it read the database, is the photo drive
// still there, and when did the worker last check in. Docker's healthcheck
// calls it, so a dropped drive (its .gma-media sentinel gone) turns the app
// unhealthy (503) where Ben and `docker compose ps` can see it.

import { getSetting } from '../lib/settings.js';

export default async function healthRoutes(app) {
  app.get('/healthz', async (request, reply) => {
    let dbOk = false;
    let workerLastSeen = null;
    try {
      dbOk = app.db.prepare('SELECT 1 AS ok').get().ok === 1;
      workerLastSeen = getSetting(app.db, 'worker_last_seen', null);
    } catch (err) {
      request.log.error({ err }, 'Health check could not read the database');
    }
    const mediaOk = app.storage.isMounted();
    if (!mediaOk) request.log.error('Health check: the photo drive is gone (its sentinel file is missing)');
    const ok = dbOk && mediaOk;
    reply.header('cache-control', 'no-store');
    reply.code(ok ? 200 : 503);
    return { ok, db: dbOk, media: mediaOk, worker_last_seen: workerLastSeen };
  });
}
