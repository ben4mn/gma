// A tiny element builder. Text always goes in as textContent, so nothing a
// relative typed can become markup. Styles go through the CSSOM (CSP-safe).

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'html') el.innerHTML = value; // only for the static icons below
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** An <img> that never shows a broken-image box: a failed load hides it. */
export function photo(src, { alt = '', className = 'photo' } = {}) {
  const img = h('img', { class: className, alt, src, decoding: 'async', draggable: 'false' });
  img.addEventListener('error', () => img.classList.add('is-missing'), { once: true });
  return img;
}

export function icon(name) {
  return h('span', { class: `icon icon-${name}`, 'aria-hidden': 'true', html: ICONS[name] });
}

const stroke = (d, w = 3.6, box = 40) =>
  `<svg viewBox="0 0 ${box} ${box}" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

export const ICONS = {
  home: stroke('<path d="M5 19.5 20 7l15 12.5"/><path d="M9.5 16.5V34h21V16.5"/><path d="M17 34v-9h6v9"/>'),
  prev: stroke('<path d="M25 7 12 20l13 13"/>', 5),
  next: stroke('<path d="M15 7l13 13-13 13"/>', 5),
  back: stroke('<path d="M17 9 6 20l11 11"/><path d="M7 20h27"/>', 4.5),
  message: stroke('<path d="M8 10h32a3 3 0 0 1 3 3v18a3 3 0 0 1-3 3H22l-9 7v-7H8a3 3 0 0 1-3-3V13a3 3 0 0 1 3-3Z"/><path d="M14 19h20M14 25h13"/>', 3.8, 48),
  mic: stroke('<rect x="14.5" y="4.5" width="11" height="19" rx="5.5"/><path d="M8.5 19.5a11.5 11.5 0 0 0 23 0"/><path d="M20 31v5"/>'),
  play: '<svg viewBox="0 0 40 40" fill="currentColor"><path d="M8 4.5v31L35 20z"/></svg>',
  stop: '<svg viewBox="0 0 40 40" fill="currentColor"><rect x="8" y="8" width="24" height="24" rx="4"/></svg>',
  check: stroke('<circle cx="20" cy="20" r="16"/><path d="m12.5 20.5 5 5 10-11"/>', 4.5),
  person: stroke('<circle cx="16" cy="10.5" r="5.5"/><path d="M5.5 28a10.5 10.5 0 0 1 21 0"/>', 3.2, 32),
  family: stroke('<circle cx="13" cy="12" r="5"/><circle cx="28" cy="13" r="4"/><path d="M3.5 33a9.5 9.5 0 0 1 19 0"/><path d="M22.5 26.5A7.5 7.5 0 0 1 36 31"/>', 3.2),
  again: stroke('<path d="M8 20a12 12 0 1 0 3.5-8.5"/><path d="M8 6v7h7"/>', 4),
  offline: stroke('<path d="M11 30h18a7 7 0 0 0 1-13.9A10 10 0 0 0 11.2 15 7.5 7.5 0 0 0 11 30Z"/><path d="M6 6l28 28"/>', 3.2),
  moon: '<svg viewBox="0 0 40 40" fill="currentColor"><path d="M27.5 27.8A13 13 0 0 1 16.3 6.2a14 14 0 1 0 17.5 17.4 13 13 0 0 1-6.3 4.2Z"/></svg>',
};
