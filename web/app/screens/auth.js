// Getting in: the invite page, sign in (Face ID or fingerprint, or an email
// code), the /confirm page from the email, then the passkey offer and the Home
// Screen guide. No passwords anywhere.
import { h, mount } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { api } from '../../shared/api.js';
import { navigate, safeNext } from '../router.js';
import { hasPasskeyHint, setPasskeyHint } from '../session.js';
import { detectInAppBrowser, openInBrowserSteps } from '../platform.js';
import { passkeysSupported, platformPasskeysAvailable, prefetchOptions, fetchLoginOptions, fetchRegisterOptions, signInWithPasskey, registerPasskey, registrationFailure } from '../passkeys.js';
import { pageHead } from './shell.js';
import { inviteProblemCopy } from '../invite-copy.js';
import { MAX_SHORT_NAME, shortNameFor } from '../../shared/names.js';
import { copyLinkButton, currentPlatform, installGuideView, isStandalone } from './prompts.js';

function errorLine() {
  return h('p', { class: 'form-error', role: 'alert', hidden: true });
}
function showError(el, message) {
  el.textContent = message;
  el.hidden = !message;
}

function busy(button, label) {
  const before = button.textContent;
  button.disabled = true;
  button.textContent = label;
  return () => { button.disabled = false; button.textContent = before; };
}

/** If we're in Gmail's, Facebook's (…) built-in browser, say how to get to the real one. */
function inAppNotice() {
  const app = detectInAppBrowser(navigator.userAgent, { standalone: isStandalone() });
  if (!app) return null;
  const { browser, steps } = openInBrowserSteps(currentPlatform());
  const copy = copyLinkButton({ browser, url: location.href });
  const note = h('div', { class: 'note' },
    h('p', { class: 'note-title' }, `Open this in ${browser}`),
    h('p', null, `You’re looking at this inside ${app === 'another app' ? 'another app' : `the ${app} app`}. Setting up works best in ${browser}, so you stay signed in and can add it to your Home Screen.`),
    h('ol', { class: 'steps' }, steps.map((s) => h('li', null, s))),
    h('div', { class: 'row' },
      copy.button,
      h('button', { type: 'button', class: 'btn btn--quiet', onclick: () => note.remove() }, 'Continue here anyway')),
    copy.status);
  return note;
}

/** After any sign-in: offer a passkey if the server asks, then the Home Screen guide, then home. */
function afterSignIn(main, ctx, res) {
  ctx.signedIn(res);
  const next = safeNext(ctx.url.searchParams.get('next'), location.origin);
  const finish = () => {
    const platform = currentPlatform();
    if (!platform.standalone && platform.os !== 'other' && !sessionStorageFlag('gma.install.shown')) return installStep(main, next);
    navigate(next, { replace: true });
  };
  // Only offered where the phone can actually make one (a screen lock is set).
  if (res?.offer_passkey && passkeysSupported()) {
    return platformPasskeysAvailable().then((ok) => (ok ? passkeyOffer(main, finish) : finish()));
  }
  finish();
}

function sessionStorageFlag(key) {
  try {
    const was = sessionStorage.getItem(key) === '1';
    sessionStorage.setItem(key, '1');
    return was;
  } catch { return false; }
}

function passkeyOffer(main, done) {
  const error = errorLine();
  const setUp = h('button', { type: 'button', class: 'btn btn--primary btn--block', disabled: true }, 'Getting ready…');
  const prefetch = prefetchOptions(fetchRegisterOptions, {
    onChange: (ready) => {
      setUp.disabled = !ready;
      setUp.textContent = ready ? 'Set it up' : 'Getting ready…';
    },
  });
  let failures = 0;
  const later = h('button', { type: 'button', class: 'btn btn--quiet', onclick: () => { prefetch.stop(); done(); } }, 'Not now');
  setUp.addEventListener('click', async () => {
    showError(error, '');
    const options = prefetch.take();
    if (!options) return showError(error, 'One moment, then tap again.');
    try {
      const result = await registerPasskey(options);
      setPasskeyHint(true);
      prefetch.stop();
      mount(main,
        pageHead({ title: 'All set' }),
        h('p', { class: 'body-text' }, result?.alreadySetUp
          ? 'This phone already has Face ID sign-in set up. Next time, sign in with Face ID or your fingerprint.'
          : 'Next time, sign in with Face ID or your fingerprint. No code needed.'),
        h('button', { type: 'button', class: 'btn btn--primary btn--block', onclick: done }, 'Continue'));
    } catch {
      failures += 1;
      const { message, canRetry } = registrationFailure({ os: currentPlatform().os, failures });
      showError(error, message);
      if (canRetry) prefetch.refresh();
      else {
        // two tries is enough: only the way on is left
        prefetch.stop();
        setUp.remove();
        later.textContent = 'Continue';
        later.className = 'btn btn--primary btn--block';
      }
    }
  });
  mount(main,
    pageHead({ eyebrow: 'One more thing', title: 'Use Face ID or your fingerprint next time', sub: 'Sign in with a glance or a touch instead of waiting for an email code. Your face and fingerprint never leave your phone.' }),
    error,
    h('div', { class: 'stack' },
      setUp,
      later));
}

function installStep(main, next) {
  const platform = currentPlatform();
  mount(main,
    pageHead({ eyebrow: 'Last step', title: 'Put Grandma’s family on your Home Screen', sub: 'It opens like an app, and it’s how you hear when Grandma replies.' }),
    h('div', { class: 'note' }, installGuideView()),
    platform.os === 'ios'
      ? h('p', { class: 'body-text' }, 'Then open it from your Home Screen. You’ll sign in there once more, with Face ID, your fingerprint or an email code, and it will offer to turn on notifications.')
      : null,
    h('div', { class: 'stack' },
      h('button', { type: 'button', class: 'btn btn--secondary btn--block', onclick: () => navigate(next, { replace: true }) }, 'Maybe later')));
}

/** The 6-digit code from the email. */
// Codes only go to an address someone was invited with: said on both screens,
// so a typo never leaves a relative waiting for a code that isn't coming.
export const ONLY_INVITED_LINE = 'We only send codes to the email address you were invited with. No code after a few minutes? Check your spam folder, or ask Ben.';

// `onDifferentEmail`: from an invite, "Use a different email" goes back to the
// invite form (accepting again fixes the address); elsewhere it goes to /signin.
function codeStep(main, ctx, email, { onDifferentEmail = null } = {}) {
  const error = errorLine();
  const input = h('input', {
    class: 'input input--code', id: 'code', name: 'code',
    inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]*', maxlength: '6',
    'aria-describedby': 'code-help', required: true,
  });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary btn--block' }, 'Sign in');
  const resent = h('p', { class: 'body-text body-text--muted', role: 'status' });
  const form = h('form', { novalidate: true },
    h('div', { class: 'field' }, h('label', { for: 'code' }, 'Your code'), input),
    error, submit);

  const verify = async () => {
    const code = input.value.replace(/\D/g, '');
    if (code.length !== 6) return showError(error, 'The code has 6 numbers. Check the email and try again.');
    showError(error, '');
    const done = busy(submit, 'Signing in…');
    try {
      afterSignIn(main, ctx, await api.post('/api/auth/code/verify', { email, code }));
    } catch (err) {
      done();
      showError(error, err.status === 0 ? err.message : (err.message || 'That code didn’t work. Check it, or ask for a new one.'));
      input.select();
    }
  };
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 6);
    if (input.value.length === 6) verify();
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); verify(); });

  mount(main,
    pageHead({ title: 'Check your email', sub: '' }),
    h('p', { class: 'body-text', id: 'code-help' }, 'We sent a 6-digit code to ', h('b', null, email), '. Type it here. It works for 15 minutes.'),
    form,
    h('div', { class: 'stack' },
      h('button', {
        type: 'button', class: 'btn btn--quiet',
        onclick: async () => {
          try {
            await api.post('/api/auth/code/request', { email });
            resent.textContent = 'We sent a new code. Use the newest one.';
          } catch (err) { resent.textContent = err.message; }
        },
      }, 'Send me a new code'),
      resent,
      h('p', { class: 'body-text body-text--muted' }, ONLY_INVITED_LINE),
      onDifferentEmail
        ? h('button', { type: 'button', class: 'btn btn--quiet', onclick: onDifferentEmail }, 'Use a different email')
        : h('a', { class: 'btn btn--quiet', href: '/signin' }, 'Use a different email')));
  input.focus();
}

function emailForm({ onSubmit, label = 'Email me a code', primary = true, email = '' }) {
  const error = errorLine();
  const input = h('input', { class: 'input', id: 'email', type: 'email', name: 'email', autocomplete: 'email', inputmode: 'email', autocapitalize: 'off', spellcheck: 'false', required: true, value: email });
  const submit = h('button', { type: 'submit', class: `btn ${primary ? 'btn--primary' : 'btn--secondary'} btn--block` }, label);
  const form = h('form', { novalidate: true },
    h('div', { class: 'field' }, h('label', { for: 'email' }, 'Your email'), input),
    error, submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return showError(error, 'Please check your email address.');
    showError(error, '');
    const done = busy(submit, 'Sending…');
    try { await onSubmit(value); } catch (err) { done(); showError(error, err.message); }
  });
  return form;
}

export function signinScreen(main, ctx) {
  // The installed iPhone app doesn't share Safari's storage, so it can't know
  // about the passkey made during onboarding; the only way into it led through
  // that offer, so Face ID leads there.
  const hint = hasPasskeyHint() || (isStandalone() && currentPlatform().os === 'ios');
  const canPasskey = passkeysSupported();
  const error = errorLine();
  let prefetch = null;
  const passkeyBtn = h('button', { type: 'button', class: `btn ${hint ? 'btn--primary' : 'btn--secondary'} btn--block`, disabled: true }, icon('key'), 'Sign in with Face ID or fingerprint');

  if (canPasskey) {
    prefetch = prefetchOptions(fetchLoginOptions, { onChange: (ready) => { passkeyBtn.disabled = !ready; } });
    passkeyBtn.addEventListener('click', async () => {
      showError(error, '');
      const options = prefetch.take();
      if (!options) return showError(error, 'One moment, then tap again.');
      try {
        const res = await signInWithPasskey(options);
        setPasskeyHint(true);
        prefetch.stop();
        afterSignIn(main, ctx, { ...res, offer_passkey: false });
      } catch (err) {
        showError(error, err.message);
        prefetch.refresh();
      }
    });
  }

  const form = emailForm({
    primary: !hint || !canPasskey,
    onSubmit: async (email) => {
      await api.post('/api/auth/code/request', { email });
      prefetch?.stop();
      codeStep(main, ctx, email);
    },
  });

  mount(main,
    inAppNotice(),
    pageHead({ eyebrow: 'Grandma’s family', title: 'Welcome back', sub: 'Sign in to see the family photos and share your own.' }),
    error,
    canPasskey && hint ? h('div', { class: 'stack' }, passkeyBtn, h('p', { class: 'body-text body-text--muted' }, 'Or get a code by email:')) : null,
    form,
    h('p', { class: 'body-text body-text--muted' }, ONLY_INVITED_LINE),
    canPasskey && !hint ? h('div', { class: 'stack' }, h('p', { class: 'body-text body-text--muted' }, 'Set up Face ID or your fingerprint already?'), passkeyBtn) : null);
  return () => prefetch?.stop();
}

export function joinScreen(main, ctx) {
  const token = ctx.params.token;
  mount(main, h('p', { class: 'quiet-line' }, 'Opening your invite…'));
  let stopped = false;
  (async () => {
    let invite;
    try {
      invite = await api.get(`/api/invites/${encodeURIComponent(token)}`);
    } catch (err) {
      invite = err.status === 404 ? { valid: false } : null;
      if (!invite) {
        mount(main, pageHead({ title: 'We couldn’t open your invite' }), h('p', { class: 'body-text' }, err.message),
          h('button', { type: 'button', class: 'btn btn--primary', onclick: () => ctx.rerender() }, 'Try again'));
        return;
      }
    }
    if (stopped) return;
    if (!invite?.valid) {
      const copy = inviteProblemCopy(invite?.reason);
      mount(main,
        pageHead({ title: copy.title, sub: copy.sub }),
        copy.line ? h('p', { class: 'body-text' }, copy.line) : null,
        h('a', { class: 'btn btn--primary btn--block', href: copy.action.href }, copy.action.label));
      return;
    }
    const error = errorLine();
    const name = h('input', { class: 'input', id: 'name', name: 'name', autocomplete: 'name', required: true, value: invite.name ?? '' });
    // What the frame calls them. It follows the name until they change it themselves.
    const short = h('input', { class: 'input', id: 'short-name', name: 'short_name', autocomplete: 'off', autocapitalize: 'words', maxlength: String(MAX_SHORT_NAME), 'aria-describedby': 'short-name-help', value: shortNameFor(invite.name ?? '') });
    let shortEdited = false;
    name.addEventListener('input', () => { if (!shortEdited) short.value = shortNameFor(name.value); });
    short.addEventListener('input', () => { shortEdited = true; });
    const email = h('input', { class: 'input', id: 'email', type: 'email', name: 'email', autocomplete: 'email', inputmode: 'email', autocapitalize: 'off', spellcheck: 'false', required: true, value: invite.email ?? '' });
    const submit = h('button', { type: 'submit', class: 'btn btn--primary btn--block' }, 'Continue');
    const form = h('form', { novalidate: true },
      h('div', { class: 'field' }, h('label', { for: 'name' }, 'Your name'), name, h('small', null, 'Your first and last name, like “Sarah Lee”.')),
      h('div', { class: 'field' },
        h('label', { for: 'short-name' }, 'What does Grandma call you?'),
        short,
        h('small', { id: 'short-name-help' }, 'Her frame says “Photo from Sarah” or “Photo from Uncle Mike”. You can leave it as it is.')),
      h('div', { class: 'field' }, h('label', { for: 'email' }, 'Your email'), email, h('small', null, 'We’ll send you a code to sign in. No password.')),
      error, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = { name: name.value.trim(), email: email.value.trim() };
      const shortName = short.value.trim().replace(/\s+/g, ' ');
      if (shortName) values.short_name = shortName;
      if (!values.name) return showError(error, 'Please tell us your name.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) return showError(error, 'Please check your email address.');
      showError(error, '');
      const done = busy(submit, 'One moment…');
      try {
        const res = await api.post(`/api/invites/${encodeURIComponent(token)}/accept`, values);
        // When the invite was emailed to this address, the server signs them in straight away.
        if (res?.user) return afterSignIn(main, ctx, res);
        // A typo is fixed by accepting the invite again with the right address.
        codeStep(main, ctx, values.email, { onDifferentEmail: () => ctx.rerender() });
      } catch (err) {
        done();
        showError(error, err.message);
      }
    });
    mount(main,
      inAppNotice(),
      pageHead({ eyebrow: 'You’re invited', title: 'Welcome to Grandma’s family', sub: 'Share photos and videos with Grandma. She sees them on her frame and can send you love right back.' }),
      form);
  })();
  return () => { stopped = true; };
}

export function confirmScreen(main, ctx) {
  const token = ctx.url.searchParams.get('t');
  const error = errorLine();
  if (!token) {
    mount(main, pageHead({ title: 'This link is missing a piece', sub: 'Open the link from your email again, or type the code from the email instead.' }),
      h('a', { class: 'btn btn--primary btn--block', href: '/signin' }, 'Sign in with a code'));
    return;
  }
  const button = h('button', { type: 'button', class: 'btn btn--primary btn--block' }, 'Sign me in');
  button.addEventListener('click', async () => {
    showError(error, '');
    const done = busy(button, 'Signing in…');
    try {
      const res = await api.post('/api/auth/link/confirm', { token });
      history.replaceState(null, '', '/confirm');
      afterSignIn(main, ctx, res);
    } catch (err) {
      done();
      showError(error, err.status === 0 ? err.message : 'This link has expired or was already used. You can ask for a new code.');
    }
  });
  // Mail opens links in Safari, never in the app on the Home Screen.
  const inSafariOnIphone = currentPlatform().os === 'ios' && !isStandalone();
  mount(main,
    inAppNotice(),
    pageHead({ eyebrow: 'Grandma’s family', title: 'One more tap', sub: 'Tap the button to sign in here.' }),
    inSafariOnIphone
      ? h('p', { class: 'body-text' }, 'If you’re signing in to the app on your Home Screen, go back to it and type the code from the email instead.')
      : null,
    error,
    h('div', { class: 'stack' }, button, h('a', { class: 'btn btn--quiet', href: '/signin' }, 'Use a code instead')));
}
