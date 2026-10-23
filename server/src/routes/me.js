// The signed-in person: who they are and their passkeys (the You screen).
//
//   GET    /api/me                → {user, passkeys: n, push, offer_passkey}
//   GET    /api/me/passkeys       → {passkeys: [...], rp_id, user_handle}
//   DELETE /api/me/passkeys/:id   → {ok, passkeys: n}
//
// rp_id and user_handle are what the client needs for
// PublicKeyCredential.signalAllAcceptedCredentials, which must only ever be
// called with this full list (Apple deletes passkeys missing from it).

import { httpError, requireUser } from '../lib/guards.js';
import { countPasskeys, deletePasskey, listPasskeys, userHandleB64 } from '../lib/webauthn.js';
import { publicUser, takePasskeyOffer } from './auth.js';

export default async function meRoutes(app, { config, db }) {
  app.get('/api/me', { preHandler: requireUser }, async (request, reply) => {
    const { user } = request;
    const push = db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ? LIMIT 1').get(user.id) !== undefined;
    reply.header('cache-control', 'no-store');
    return {
      user: publicUser(user),
      passkeys: countPasskeys(db, user.id),
      push,
      offer_passkey: takePasskeyOffer(request, reply, request.session.id),
    };
  });

  app.get('/api/me/passkeys', { preHandler: requireUser }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return {
      passkeys: listPasskeys(db, request.user.id),
      rp_id: config.webauthnRpId,
      user_handle: userHandleB64(config, request.user.id),
    };
  });

  app.delete('/api/me/passkeys/:id', { preHandler: requireUser }, async (request) => {
    const id = String(request.params.id ?? '');
    if (id.length === 0 || id.length > 1024 || !deletePasskey(db, request.user.id, id)) {
      throw httpError(404, 'not_found', "We couldn't find that passkey. It may already be gone.");
    }
    return { ok: true, passkeys: countPasskeys(db, request.user.id) };
  });
}
