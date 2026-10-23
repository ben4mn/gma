// A list that loads by cursor as you scroll: GET …?before=<id>&limit=. The
// screen supplies load() and onPage(); this owns the sentinel, the "loading
// more" line, errors with a retry, and refreshing from the top.
import { h, mount } from '../../shared/dom.js';

export function infiniteList({ container, load, onPage, onEmpty, onReset }) {
  const status = h('div', { class: 'list-status', 'aria-live': 'polite' });
  const sentinel = h('div', { class: 'list-sentinel', 'aria-hidden': 'true' });
  container.after(status, sentinel);

  let cursor = null;
  let done = false;
  let loading = false;
  let generation = 0;
  let count = 0;

  async function more() {
    if (loading || done) return;
    loading = true;
    const gen = generation;
    if (count) mount(status, h('p', { class: 'list-end' }, 'Loading more…'));
    try {
      const { list, next } = await load(cursor);
      if (gen !== generation) return;
      count += list.length;
      cursor = next;
      done = !next || list.length === 0;
      mount(status);
      if (list.length) onPage(list);
      if (!count) onEmpty?.();
      else if (done) mount(status, h('p', { class: 'list-end' }, 'That’s everything.'));
    } catch (err) {
      if (gen !== generation) return;
      mount(status, h('div', { class: 'note note--error', role: 'alert' },
        h('p', null, err.message),
        h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => more() }, 'Try again')));
    } finally {
      if (gen === generation) loading = false;
    }
    // A short first page may not fill the screen; keep going while the sentinel shows.
    if (!done && gen === generation && sentinel.getBoundingClientRect().top < innerHeight + 800) more();
  }

  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) more();
  }, { rootMargin: '800px 0px' });
  observer.observe(sentinel);

  return {
    first: more,
    /** Start again from the newest (after a live event or a reconnect). */
    async refresh() {
      generation += 1;
      cursor = null;
      done = false;
      loading = false;
      count = 0;
      onReset?.();
      mount(status);
      await more();
    },
    destroy() {
      generation += 1;
      observer.disconnect();
      status.remove();
      sentinel.remove();
    },
  };
}
