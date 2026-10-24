// The frame around every screen: the top bar (Share and your initial) and the
// three tabs. Public pages (join, sign in) get a plain page.
import { h, mount } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { session } from '../session.js';
import { colourFor, initialOf } from '../data.js';

const TABS = [
  { name: 'family', href: '/', label: 'Family', icon: 'family' },
  { name: 'grandma', href: '/from-grandma', label: 'Grandma’s Feed', icon: 'feed' },
  { name: 'mine', href: '/mine', label: 'Mine', icon: 'mine' },
];

function appBar() {
  const user = session.user;
  const me = h('a', { class: 'appbar-me', href: '/you', 'aria-label': `You: ${user.name}` }, initialOf(user.name));
  me.style.background = colourFor(user);
  return h('header', { class: 'appbar' },
    h('p', { class: 'appbar-name' }, 'Grandma’s family'),
    h('a', { class: 'appbar-share', href: '/upload' }, icon('camera'), 'Share'),
    me);
}

function tabBar(active) {
  return h('nav', { class: 'tabs', 'aria-label': 'Sections' },
    TABS.map((t) => h('a', { class: 'tab', href: t.href, 'aria-current': t.name === active ? 'page' : null },
      h('span', { class: 'ic' }, icon(t.icon)), t.label)));
}

/** Draw the chrome for a route and return the empty <main> the screen fills. */
export function renderChrome(route) {
  const app = document.getElementById('app');
  const main = h('main', { id: 'main', class: 'page', tabindex: '-1' });
  const signedIn = Boolean(session.user) && !route?.public;
  if (!signedIn) {
    main.classList.add('page--plain');
    mount(app, main);
    return main;
  }
  const showTabs = route?.name !== 'upload';
  if (!showTabs) main.classList.add('page--plain');
  mount(app, appBar(), main, showTabs ? tabBar(route?.tab) : null);
  return main;
}

/** The eyebrow, title and subtitle at the top of a screen. */
export function pageHead({ eyebrow, title, sub, id = 'page-title' }) {
  return h('header', { class: 'head' },
    eyebrow ? h('p', { class: 'eyebrow' }, icon('mark', 'icon'), eyebrow) : null,
    h('h1', { class: 'title', id }, title),
    sub ? h('p', { class: 'sub' }, sub) : null);
}

export function uploadButton() {
  return h('a', { class: 'upload-cta', href: '/upload' }, icon('camera'), 'Share photos or a video');
}

export function errorNote(message, retry) {
  return h('div', { class: 'note note--error', role: 'alert' },
    h('p', null, message),
    retry ? h('button', { class: 'btn btn--secondary', type: 'button', onclick: retry }, 'Try again') : null);
}
