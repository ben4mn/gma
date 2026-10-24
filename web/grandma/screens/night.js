// The resting night screen (Lantern's, in Heirloom's night palette): a big calm
// clock, the slideshow resting on one dimmed print. The first tap only wakes the
// frame; it never opens anything underneath.
import { h, photo } from '../lib/dom.js';
import { fitBox } from '../lib/layout.js';

const REST_BOX = { width: 520, height: 600 };

export function renderRest({ item, onWake }) {
  const time = h('span', { class: 'rest-time-digits' });
  const period = h('span', { class: 'rest-time-period' });
  const date = h('p', { class: 'rest-date' });
  const timeLine = h('p', { class: 'rest-time' }, time, period);
  const title = document.createTextNode('Good night.');
  const line = document.createTextNode('The photos will be back in the morning.');
  let print = null;
  if (item?.display) {
    const box = fitBox(item.width, item.height, REST_BOX.width, REST_BOX.height);
    print = h('figure', { class: 'print rest-print' },
      h('div', { class: 'print-photo', style: { width: `${box.width}px`, height: `${box.height}px` } }, photo(item.display)));
  }
  const el = h('div', { class: 'rest', role: 'button', 'aria-label': 'Wake the screen' },
    h('div', { class: 'rest-clock' },
      timeLine,
      date,
      h('p', { class: 'rest-line' }, title, h('br'), line)),
    print);
  el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onWake(); });
  return {
    el,
    /** clock: "9:30 pm", or '' when the frame's clock can't be trusted; words: lib/time.js nightWords */
    setClock(clock, dateText, words) {
      const [digits = '', ampm = ''] = clock ? clock.split(' ') : [];
      time.textContent = digits;
      period.textContent = ampm;
      date.textContent = dateText;
      timeLine.hidden = !digits; // no time at all rather than a wrong one
      date.hidden = !dateText;
      if (words) {
        title.textContent = words.restTitle;
        line.textContent = words.restLine;
      }
    },
  };
}
