// Who is signed in, plus the per-device passkey hint. The session itself is an
// HttpOnly cookie; this module only mirrors /api/me for the screens.
import { api, ApiError } from '../shared/api.js';

const PASSKEY_HINT = 'gma.passkey';
let me = null;

export const session = {
  get user() { return me?.user ?? null; },
  get info() { return me; },
  get isAdmin() { return me?.user?.role === 'admin'; },
  set(info) { me = info?.user ? { passkeys: 0, push: false, ...info } : null; },
  clear() { me = null; },
};

/** Load /api/me. Resolves to the user, or null when nobody is signed in. */
export async function loadMe() {
  try {
    session.set(await api.get('/api/me'));
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) session.clear();
    else throw err;
  }
  return session.user;
}

export function hasPasskeyHint() {
  try { return localStorage.getItem(PASSKEY_HINT) === '1'; } catch { return false; }
}

export function setPasskeyHint(on) {
  try {
    if (on) localStorage.setItem(PASSKEY_HINT, '1');
    else localStorage.removeItem(PASSKEY_HINT);
  } catch { /* private mode: the hint is only a nicety */ }
}

export async function signOut() {
  try { await api.post('/api/auth/logout'); } catch { /* signed out locally either way */ }
  session.clear();
  navigator.serviceWorker?.controller?.postMessage({ type: 'signed-out' });
}
