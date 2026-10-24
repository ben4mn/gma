// The gentle setup prompts: Add to Home Screen, then (in the installed app on
// iPhone, anywhere on Android) Turn on notifications. Each can be put off.
import { h, mount } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { detectPlatform, installGuide, canOfferPush } from '../platform.js';
import { pushSupported, pushPermission, turnOnPush } from '../push.js';

let deferredInstall = null;
addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstall = event;
});
addEventListener('appinstalled', () => { deferredInstall = null; });

export function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

export function currentPlatform() {
  return detectPlatform(navigator.userAgent, { maxTouchPoints: navigator.maxTouchPoints, standalone: isStandalone() });
}

/**
 * A "Copy link" button with the line it leads to. `url` defaults to the app's
 * front door, which sends a signed-out browser to sign in.
 */
export function copyLinkButton({ browser, url = `${location.origin}/`, className = 'btn btn--secondary' }) {
  const status = h('p', { class: 'body-text', role: 'status' });
  const button = h('button', {
    type: 'button',
    class: className,
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(url);
        status.textContent = `Copied. Now open ${browser} and paste it into the address bar.`;
      } catch {
        status.textContent = `Press and hold the address at the top, copy it, then paste it into ${browser}.`;
      }
    },
  }, icon('copy'), 'Copy link');
  return { button, status };
}

/** The Add to Home Screen steps for this phone, with Android's install button when the browser offers one. */
export function installGuideView() {
  const guide = installGuide(currentPlatform(), { canPrompt: Boolean(deferredInstall) });
  if (guide.kind === 'installed') return h('p', { class: 'body-text' }, 'You’re using the app from your Home Screen. You’re all set.');
  const box = h('div', null, h('ol', { class: 'steps' }, guide.steps.map((s) => h('li', null, s))));
  if (guide.copyLink) {
    const { button, status } = copyLinkButton({ browser: guide.copyLink.browser });
    box.append(h('div', { class: 'copy-link' },
      h('p', { class: 'body-text body-text--muted' }, guide.copyLink.hint),
      h('div', { class: 'row' }, button),
      status));
  }
  if (guide.kind === 'android-prompt') {
    box.append(h('button', {
      type: 'button',
      class: 'btn btn--primary btn--block',
      onclick: async () => {
        const prompt = deferredInstall;
        deferredInstall = null;
        await prompt?.prompt();
      },
    }, 'Add to Home Screen'));
  }
  return box;
}

const dismissed = (key) => { try { return localStorage.getItem(key) === '1'; } catch { return false; } };
const dismiss = (key) => { try { localStorage.setItem(key, '1'); } catch { /* fine */ } };

/** A "Turn on notifications" button that asks from the tap itself. */
export function notificationButton({ onDone, className = 'btn btn--primary btn--block' } = {}) {
  const message = h('p', { class: 'form-error', role: 'status', hidden: true });
  const button = h('button', {
    type: 'button',
    class: className,
    onclick: async () => {
      button.disabled = true;
      message.hidden = true;
      try {
        await turnOnPush();
        onDone?.();
      } catch (err) {
        message.textContent = err.message || 'That didn’t work. Please try again.';
        message.hidden = false;
      } finally {
        button.disabled = false;
      }
    },
  }, icon('bell'), 'Turn on notifications');
  return h('div', null, message, button);
}

export function setupPrompts(slot) {
  const platform = currentPlatform();
  const draw = () => {
    if (canOfferPush(platform, pushSupported()) && pushPermission() === 'default' && !dismissed('gma.prompt.push')) {
      mount(slot, h('div', { class: 'note' },
        h('p', { class: 'note-title' }, 'Hear from Grandma'),
        h('p', null, 'Get a notification when Grandma reacts to your photos or sends the family a voice message.'),
        notificationButton({ onDone: () => mount(slot, h('div', { class: 'note note--ok', role: 'status' }, h('p', null, 'Notifications are on. We’ll tell you when Grandma sends something.'))) }),
        h('button', { type: 'button', class: 'btn btn--quiet', onclick: () => { dismiss('gma.prompt.push'); draw(); } }, 'Not now')));
      return;
    }
    if (!platform.standalone && platform.os !== 'other' && !dismissed('gma.prompt.install')) {
      const more = h('div', { hidden: true }, installGuideView(),
        platform.os === 'ios' ? h('p', { class: 'body-text body-text--muted' }, 'On iPhone, notifications from Grandma only work in the app on your Home Screen.') : null);
      mount(slot, h('div', { class: 'note' },
        h('p', { class: 'note-title' }, 'Put Grandma’s family on your Home Screen'),
        h('p', null, 'It opens like an app, and it’s how you get notified when Grandma replies.'),
        more,
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn btn--secondary', onclick: (e) => { more.hidden = false; e.currentTarget.remove(); } }, 'Show me how'),
          h('button', { type: 'button', class: 'btn btn--quiet', onclick: () => { dismiss('gma.prompt.install'); draw(); } }, 'Not now'))));
      return;
    }
    mount(slot);
  };
  draw();
  return () => {};
}
