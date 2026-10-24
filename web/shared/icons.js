// Line icons from the Heirloom mocks, as constant SVG markup. Each one is
// decorative (aria-hidden): every icon in the apps sits next to a word.

const stroke = (w, body, box = 28) =>
  `<svg viewBox="0 0 ${box} ${box}" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const fill = (body, box = 20) =>
  `<svg viewBox="0 0 ${box} ${box}" fill="currentColor" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICONS = {
  family: stroke(2.4, '<circle cx="9" cy="9" r="3.5"/><circle cx="19" cy="9" r="3.5"/><path d="M2.5 23a6.5 6.5 0 0 1 13 0M14 18.2A6.5 6.5 0 0 1 25.5 23"/>'),
  feed: stroke(2.4, '<path d="M5 4.5h18a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2h-8l-5.5 4.5V20H5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z"/><path d="M14 16s-4.5-2.6-4.5-5.4A2.3 2.3 0 0 1 14 9.4a2.3 2.3 0 0 1 4.5 1.2C18.5 13.4 14 16 14 16Z"/>'),
  mine: stroke(2.4, '<rect x="3.5" y="5" width="21" height="18" rx="2"/><circle cx="10" cy="11" r="2.2"/><path d="m4 20.5 6-5.5 4.5 4 3.5-3 6 5"/>'),
  camera: stroke(2.6, '<path d="M4 9.5a2 2 0 0 1 2-2h3l2-3h6l2 3h3a2 2 0 0 1 2 2V21a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M14 11.5v7M10.5 15h7"/>'),
  play: fill('<path d="M4 2.5v15l13-7.5z"/>'),
  pause: fill('<path d="M4.5 3h4v14h-4zM11.5 3h4v14h-4z"/>'),
  person: stroke(2.2, '<circle cx="8" cy="5" r="3"/><path d="M2.5 14.5a5.5 5.5 0 0 1 11 0"/>', 16),
  people: stroke(2.2, '<circle cx="5.5" cy="5.5" r="2.5"/><circle cx="11" cy="5.5" r="2.5"/><path d="M1 14a4.5 4.5 0 0 1 9 0M7.5 14a4.5 4.5 0 0 1 7.5-3.4"/>', 16),
  lock: stroke(2, '<rect x="4" y="9" width="12" height="8.5" rx="2"/><path d="M6.5 9V6.5a3.5 3.5 0 0 1 7 0V9"/>', 20),
  close: stroke(2.6, '<path d="M7 7l14 14M21 7 7 21"/>'),
  back: stroke(2.6, '<path d="M17 5 8 14l9 9"/>'),
  next: stroke(2.6, '<path d="m11 5 9 9-9 9"/>'),
  check: stroke(2.8, '<path d="m6 14.5 5 5L22 8.5"/>'),
  share: stroke(2.4, '<path d="M14 3.5v14M8.5 9 14 3.5 19.5 9"/><path d="M7 13H5.5v11.5h17V13H21"/>'),
  plus: stroke(2.6, '<path d="M14 6v16M6 14h16"/>'),
  more: fill('<circle cx="4" cy="10" r="2"/><circle cx="10" cy="10" r="2"/><circle cx="16" cy="10" r="2"/>'),
  bell: stroke(2.4, '<path d="M7 19.5V12a7 7 0 0 1 14 0v7.5l2 2.5H5Z"/><path d="M11.5 24.5a2.5 2.5 0 0 0 5 0"/>'),
  key: stroke(2.4, '<circle cx="9.5" cy="14" r="4.5"/><path d="M14 14h11M21 14v4M25 14v3"/>'),
  copy: stroke(2.4, '<rect x="9" y="9" width="14" height="15" rx="2"/><path d="M5 19V6a2 2 0 0 1 2-2h11"/>'),
  mark: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M0 0h16L0 16z" fill="#B8862B"/></svg>',
};

/** An icon as a DOM node (a span holding the SVG), for use with h(). */
export function icon(name, className = 'icon') {
  const span = document.createElement('span');
  span.className = className;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = ICONS[name] ?? '';
  return span;
}

/** Grandma's four reactions, drawn as Noto emoji so every screen renders them alike. */
export const REACTIONS = {
  love: { label: 'Love', emoji: '/assets/emoji/emoji_u2764.svg' },
  funny: { label: 'Funny', emoji: '/assets/emoji/emoji_u1f602.svg' },
  wow: { label: 'Wow', emoji: '/assets/emoji/emoji_u1f62e.svg' },
  thankful: { label: 'Thankful', emoji: '/assets/emoji/emoji_u1f64f.svg' },
};
