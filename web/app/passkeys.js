// Passkeys ("Face ID or your fingerprint"). iOS only lets WebAuthn start inside a
// tap, and a network wait inside the tap can lose it, so the options are fetched
// ahead of time and refreshed before the server's 5-minute challenge goes stale.
import { startAuthentication, startRegistration, browserSupportsWebAuthn } from '../vendor/simplewebauthn-browser/index.js';
import { api } from '../shared/api.js';

export const PASSKEY_ERROR = 'That didn’t work. Try again or get an email code.';
const FRESH_FOR_MS = 4 * 60 * 1000;

export function passkeysSupported() {
  try { return browserSupportsWebAuthn(); } catch { return false; }
}

/**
 * Can this phone make a Face ID / fingerprint passkey at all? False on a phone
 * with no screen lock (and anywhere the check fails), so the offer isn't shown
 * to someone it can't work for.
 */
export async function platformPasskeysAvailable(PKC = globalThis.PublicKeyCredential) {
  try {
    if (typeof PKC?.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') return false;
    return Boolean(await PKC.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

/** The phone already holds this person's passkey (it was excluded): that's success. */
export function isAlreadyRegistered(err) {
  return err?.name === 'InvalidStateError' || err?.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED'
    || err?.cause?.name === 'InvalidStateError';
}

export const PASSKEY_RETRY = 'That didn’t work. You can try again, or keep using email codes.';
export const PASSKEY_IOS_HELP = 'Face ID sign-in needs a passcode on your phone and iCloud Keychain turned on (Settings, then your name, then iCloud, then Passwords). It’s fine to skip it: email codes always work.';

/** What to say after a failed set-up: why, on an iPhone, and nothing more to try after two. */
export function registrationFailure({ os = 'other', failures = 1 } = {}) {
  return {
    message: os === 'ios' ? PASSKEY_IOS_HELP : PASSKEY_RETRY,
    canRetry: failures < 2,
  };
}

/**
 * Keeps one set of options ready. take() hands them out once (a challenge is
 * single use). It does not fetch the next set: the server keeps one pending
 * challenge per browser (the gma_webauthn cookie), so fetching during the
 * ceremony would replace the challenge the sheet is signing. Call refresh()
 * once the ceremony has failed. onChange(ready) lets the screen enable its
 * button only when a tap can go straight to the sheet.
 */
export function prefetchOptions(fetchOptions, { onChange = () => {}, now = () => Date.now(), freshForMs = FRESH_FOR_MS } = {}) {
  let options = null;
  let fetchedAt = 0;
  let inflight = null;
  let timer = null;
  let stopped = false;

  const fresh = () => options && now() - fetchedAt < freshForMs;

  async function refresh() {
    if (stopped) return;
    if (inflight) return inflight;
    options = null;
    onChange(false);
    inflight = (async () => {
      try {
        const res = await fetchOptions();
        options = res?.options ?? res?.optionsJSON ?? res;
        fetchedAt = now();
        clearTimeout(timer);
        timer = setTimeout(refresh, freshForMs);
      } catch {
        options = null;
        clearTimeout(timer);
        timer = setTimeout(refresh, 15_000);
      } finally {
        inflight = null;
        if (!stopped) onChange(Boolean(options));
      }
    })();
    return inflight;
  }

  const onVisible = () => { if (document.visibilityState === 'visible' && !fresh()) refresh(); };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  refresh();

  return {
    ready: () => Boolean(fresh()),
    take() {
      if (!fresh()) { refresh(); return null; }
      const taken = options;
      options = null;
      onChange(false);
      return taken;
    },
    refresh,
    stop() {
      stopped = true;
      clearTimeout(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    },
  };
}

export const fetchLoginOptions = () => api.post('/api/auth/passkey/login/options');
export const fetchRegisterOptions = () => api.post('/api/auth/passkey/register/options');

/** Call from a tap. Resolves to the server's verify response; throws a calm Error otherwise. */
export async function signInWithPasskey(optionsJSON) {
  if (!optionsJSON) throw new Error(PASSKEY_ERROR);
  try {
    const credential = await startAuthentication({ optionsJSON });
    return await api.post('/api/auth/passkey/login/verify', credential);
  } catch {
    throw new Error(PASSKEY_ERROR);
  }
}

/** Call from a tap. */
export async function registerPasskey(optionsJSON) {
  if (!optionsJSON) throw new Error(PASSKEY_ERROR);
  let credential;
  try {
    credential = await startRegistration({ optionsJSON });
  } catch (err) {
    // The phone refused because it already has this person's (synced) passkey.
    if (isAlreadyRegistered(err)) return { alreadySetUp: true };
    throw new Error(PASSKEY_RETRY);
  }
  try {
    return await api.post('/api/auth/passkey/register/verify', credential);
  } catch {
    throw new Error(PASSKEY_RETRY);
  }
}
