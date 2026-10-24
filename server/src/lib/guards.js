// Fastify preHandlers that check the session cookie:
//   { preHandler: requireUser }   family members (removed users get 401)
//   { preHandler: requireAdmin }  admins (401 signed out, 403 for members)
//   { preHandler: requireDevice } Grandma's frame (revoked devices get 401)
//   { preHandler: requireUserOrDevice }
// They set request.user or request.device (and request.session).
//
// httpError(status, code, message) makes an error the app's error handler
// turns into { error: { code, message } } with that status.

import { loadSession, readSessionToken, setSessionCookie } from './sessions.js';

export class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.expose = true;
  }
}

export function httpError(statusCode, code, message) {
  return new HttpError(statusCode, code, message);
}

const SIGNED_OUT = "You're signed out. Please sign in again.";

// Loads the session once per request and caches the result on the request.
export function authenticate(request, reply) {
  if (request.session !== null) return request.session;
  const auth = loadSession(request.server.db, readSessionToken(request));
  if (!auth) return null;
  if (auth.renewed) setSessionCookie(reply, readSessionToken(request));
  request.session = auth.session;
  request.user = auth.user;
  request.device = auth.device;
  return auth.session;
}

export async function requireUser(request, reply) {
  const session = authenticate(request, reply);
  if (!session || !request.user) throw httpError(401, 'unauthorized', SIGNED_OUT);
}

export async function requireAdmin(request, reply) {
  await requireUser(request, reply);
  if (request.user.role !== 'admin') {
    throw httpError(403, 'forbidden', 'Only the family admin can do that.');
  }
}

export async function requireDevice(request, reply) {
  const session = authenticate(request, reply);
  if (!session || !request.device) {
    throw httpError(401, 'unauthorized', 'This frame needs to be paired again. Ask Ben to send a new link.');
  }
}

export async function requireUserOrDevice(request, reply) {
  const session = authenticate(request, reply);
  if (!session) throw httpError(401, 'unauthorized', SIGNED_OUT);
}
