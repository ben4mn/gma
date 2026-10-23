// GET /healthz: is the app up, can it read the database, when did the worker last check in.

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
    reply.header('cache-control', 'no-store');
    reply.code(dbOk ? 200 : 503);
    return { ok: dbOk, db: dbOk, worker_last_seen: workerLastSeen };
  });
}
