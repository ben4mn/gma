// You: your name, Face ID / fingerprint sign-ins, notifications, sign out.
import { h, mount, confirmButton } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { api } from '../../shared/api.js';
import { dayLabel } from '../../shared/time.js';
import { session, signOut, setPasskeyHint } from '../session.js';
import { navigate } from '../router.js';
import { canOfferPush } from '../platform.js';
import { pushSupported, pushPermission, isPushOn, turnOffPush } from '../push.js';
import { passkeysSupported, prefetchOptions, fetchRegisterOptions, registerPasskey } from '../passkeys.js';
import { pageHead, errorNote } from './shell.js';
import { currentPlatform, installGuideView, notificationButton } from './prompts.js';

function passkeysCard(stops) {
  const card = h('div', { class: 'card' });
  const status = h('p', { class: 'body-text', role: 'status' });
  let prefetch = null;
  const addBtn = h('button', { type: 'button', class: 'btn btn--secondary btn--block', disabled: true }, icon('key'), 'Add Face ID or fingerprint for this phone');
  if (passkeysSupported()) {
    prefetch = prefetchOptions(fetchRegisterOptions, { onChange: (ready) => { addBtn.disabled = !ready; } });
    stops.push(() => prefetch.stop());
    addBtn.addEventListener('click', async () => {
      const options = prefetch.take();
      if (!options) { status.textContent = 'One moment, then tap again.'; return; }
      try {
        await registerPasskey(options);
        setPasskeyHint(true);
        status.textContent = 'Done. Next time you can sign in with Face ID or your fingerprint.';
        load();
      } catch (err) { status.textContent = err.message; }
      // the next passkey needs a fresh challenge (and the new one in its exclude list)
      prefetch.refresh();
    });
  }

  async function load() {
    let list;
    try {
      const res = await api.get('/api/me/passkeys');
      list = Array.isArray(res) ? res : res?.passkeys ?? [];
    } catch (err) {
      mount(card, errorNote(err.message, load));
      return;
    }
    mount(card,
      list.length
        ? list.map((p) => h('div', { class: 'card-row' },
          h('div', { class: 'card-main' },
            h('p', { class: 'card-name' }, p.label || 'A phone or computer'),
            h('p', { class: 'card-meta' }, p.last_used_at ? `Last used: ${dayLabel(p.last_used_at)}` : `Added: ${dayLabel(p.created_at)}`)),
          confirmButton({
            label: 'Remove',
            confirmLabel: 'Tap again to remove',
            onConfirm: async () => {
              try { await api.del(`/api/me/passkeys/${encodeURIComponent(p.id)}`); load(); } catch (err) { status.textContent = err.message; }
            },
          })))
        : h('p', { class: 'body-text body-text--muted' }, 'None yet. You sign in with a code from your email.'),
      passkeysSupported() ? h('div', { class: 'stack' }, addBtn) : null,
      status);
  }
  load();
  return card;
}

function notificationsCard() {
  const card = h('div', { class: 'card' });
  const status = h('p', { class: 'body-text', role: 'status' });
  const platform = currentPlatform();

  async function draw() {
    if (!canOfferPush(platform, pushSupported())) {
      mount(card,
        h('p', { class: 'body-text' }, platform.os === 'ios'
          ? 'On iPhone, notifications work in the app on your Home Screen. Add it there, open it, and turn them on.'
          : 'This browser can’t show notifications.'),
        platform.os === 'ios' ? installGuideView() : null);
      return;
    }
    if (pushPermission() === 'denied') {
      mount(card, h('p', { class: 'body-text' }, 'Notifications are blocked for this app. You can allow them in your phone’s Settings, then come back here.'));
      return;
    }
    const on = await isPushOn().catch(() => false);
    if (!on) {
      mount(card,
        h('p', { class: 'body-text' }, 'Off. Turn them on to hear when Grandma reacts to your photos or sends a voice message.'),
        notificationButton({ onDone: () => { status.textContent = 'Notifications are on.'; draw(); } }),
        status);
      return;
    }
    mount(card,
      h('p', { class: 'body-text' }, 'On. We’ll tell you when Grandma reacts to your photos or sends a voice message.'),
      h('div', { class: 'stack' },
        h('button', {
          type: 'button', class: 'btn btn--secondary btn--block',
          onclick: async () => {
            try { await api.post('/api/push/test'); status.textContent = 'Sent. It should arrive in a moment.'; } catch (err) { status.textContent = err.message; }
          },
        }, icon('bell'), 'Send me a test'),
        h('button', {
          type: 'button', class: 'btn btn--quiet',
          onclick: async () => {
            try { await turnOffPush(); status.textContent = 'Notifications are off.'; } catch (err) { status.textContent = err.message; }
            draw();
          },
        }, 'Turn notifications off')),
      status);
  }
  draw();
  return card;
}

export function youScreen(main) {
  const user = session.user;
  const stops = [];
  const platform = currentPlatform();
  mount(main,
    pageHead({ eyebrow: user.email, title: user.name, sub: 'Your sign-ins and notifications on this phone.' }),
    h('h2', { class: 'section-title' }, 'Face ID and fingerprint'),
    passkeysCard(stops),
    h('h2', { class: 'section-title' }, 'Notifications'),
    notificationsCard(),
    !platform.standalone && platform.os !== 'other'
      ? [h('h2', { class: 'section-title' }, 'Home Screen'), h('div', { class: 'card' }, installGuideView())]
      : null,
    session.isAdmin ? [h('h2', { class: 'section-title' }, 'Looking after the family app'),
      h('a', { class: 'btn btn--sage btn--block', href: '/admin' }, 'Open admin')] : null,
    h('div', { class: 'stack' },
      h('button', {
        type: 'button', class: 'btn btn--secondary btn--block',
        onclick: async () => { await signOut(); navigate('/signin', { replace: true }); },
      }, 'Sign out')));
  return () => stops.forEach((stop) => stop());
}
