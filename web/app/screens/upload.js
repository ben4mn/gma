// Share photos or a video: pick, add an optional caption, then watch each file
// go. iPhones can't upload in the background, so we ask people to keep this open.
import { h, mount } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { createQueue, reduce, nextToStart, summary, rejectReason, entryLabel } from '../upload-queue.js';
import { sendFile, newBatchId } from '../uploader.js';
import { pageHead } from './shell.js';
import { navigate } from '../router.js';

const CAPTION_MAX = 280;
let active = null; // the queue in flight, kept across screens so leaving doesn't stop it

export function uploadInProgress() {
  return Boolean(active && !summary(active.state).finished);
}

function previewTile(file) {
  if (file.type.startsWith('image/') && !/heic|heif/i.test(file.type)) {
    const url = URL.createObjectURL(file);
    return h('div', { class: 'print' }, h('img', { src: url, alt: file.name, onload: () => URL.revokeObjectURL(url) }));
  }
  return h('div', { class: 'print' }, h('div', { class: 'picked-video' }, icon(file.type.startsWith('video/') ? 'play' : 'mine'), file.name));
}

function startQueue(files, caption) {
  const queue = { files, state: createQueue(files, { batchId: newBatchId(), caption }), handles: new Map(), listeners: new Set(), wakeLock: null };
  const emit = () => queue.listeners.forEach((fn) => fn(queue.state));
  const dispatch = (event) => {
    queue.state = reduce(queue.state, event);
    pump();
    emit();
  };
  function pump() {
    for (const id of nextToStart(queue.state)) {
      const file = files[Number(id.slice(1))];
      queue.state = reduce(queue.state, { type: 'start', id });
      queue.handles.set(id, sendFile(file, {
        caption: queue.state.caption,
        batchId: queue.state.batchId,
        onProgress: (sent, total) => dispatch({ type: 'progress', id, sent, total }),
        onSuccess: () => dispatch({ type: 'success', id }),
        onError: (message) => dispatch({ type: 'fail', id, message }),
      }));
    }
    if (summary(queue.state).finished) releaseWake(queue);
  }
  queue.retry = (id) => dispatch({ type: 'retry', id });
  queue.onOffline = () => dispatch({ type: 'offline' });
  queue.onOnline = () => dispatch({ type: 'online' });
  addEventListener('offline', queue.onOffline);
  addEventListener('online', queue.onOnline);
  holdWake(queue);
  pump();
  return queue;
}

// Keep the screen awake while sending, where the browser allows it.
async function holdWake(queue) {
  try { queue.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported or refused */ }
}
function releaseWake(queue) {
  queue.wakeLock?.release?.().catch(() => {});
  queue.wakeLock = null;
  removeEventListener('offline', queue.onOffline);
  removeEventListener('online', queue.onOnline);
}

addEventListener('beforeunload', (event) => {
  if (uploadInProgress()) event.preventDefault();
});

function progressView(main, queue) {
  const rows = new Map();
  const headline = h('p', { class: 'note-title', role: 'status', 'aria-live': 'polite' });
  const detail = h('p');
  const doneActions = h('div', { class: 'stack' });
  const list = h('div');
  const thumbs = queue.files.map(previewTile);

  for (const entry of queue.state.entries) {
    const bar = h('i');
    const status = h('p', { class: 'uprow-status' });
    const retry = h('button', { type: 'button', class: 'btn btn--secondary', hidden: true, onclick: () => queue.retry(entry.id) }, 'Try again');
    const progress = h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': `Sending ${entry.name}` }, bar);
    const row = h('div', { class: 'uprow' },
      thumbs[Number(entry.id.slice(1))],
      h('div', null, h('p', { class: 'uprow-name' }, entry.name), status, progress, retry));
    rows.set(entry.id, { row, bar, status, retry, progress });
    list.append(row);
  }

  const update = (state) => {
    const s = summary(state);
    for (const entry of state.entries) {
      const r = rows.get(entry.id);
      const pct = entry.total ? Math.floor((entry.sent / entry.total) * 100) : 0;
      r.bar.style.width = `${entry.status === 'done' ? 100 : pct}%`;
      r.progress.setAttribute('aria-valuenow', String(pct));
      r.status.textContent = entryLabel(entry);
      r.retry.hidden = entry.status !== 'failed';
      r.row.classList.toggle('uprow--failed', entry.status === 'failed');
    }
    if (!s.finished) {
      headline.textContent = `Sending ${s.total === 1 ? 'your file' : `${s.total} files`}… ${s.percent}%`;
      detail.textContent = 'Keep this open until it finishes. Your phone can’t send in the background. If it stops, open this page again and pick the same files: it carries on where it left off.';
      mount(doneActions);
    } else if (s.allSent) {
      headline.textContent = 'All sent!';
      detail.textContent = 'They’ll show on Grandma’s frame and in the family feed as soon as they’re ready.';
      mount(doneActions,
        h('a', { class: 'btn btn--primary btn--block', href: '/mine' }, 'See them in Mine'),
        h('button', { type: 'button', class: 'btn btn--secondary btn--block', onclick: () => { active = null; navigate('/upload', { replace: true }); } }, 'Share more'));
    } else {
      headline.textContent = `${s.done} of ${s.total} sent`;
      detail.textContent = 'Some didn’t send. Tap Try again on each one.';
      mount(doneActions, h('a', { class: 'btn btn--secondary btn--block', href: '/mine' }, 'Go to Mine'));
    }
  };

  mount(main,
    pageHead({ title: 'Sharing with Grandma' }),
    h('div', { class: 'note keep-open' }, h('div', null, headline, detail)),
    list,
    doneActions);
  queue.listeners.clear();
  queue.listeners.add(update);
  update(queue.state);
}

export function uploadScreen(main) {
  if (active && !summary(active.state).finished) {
    progressView(main, active);
    return () => active?.listeners.clear();
  }
  active = null;
  let files = [];
  const errors = h('div', { 'aria-live': 'polite' });
  const picked = h('div', { class: 'picked' });
  const input = h('input', { type: 'file', multiple: true, accept: 'image/*,video/*,.heic,.heif', 'aria-label': 'Choose photos or videos' });
  const caption = h('textarea', { class: 'textarea', id: 'caption', maxlength: String(CAPTION_MAX), rows: '3', placeholder: 'Lily at the farm today…' });
  const send = h('button', { type: 'button', class: 'btn btn--primary btn--block', disabled: true }, 'Send to Grandma and the family');
  const pickLabel = h('span', null, 'Choose photos or videos');
  const picker = h('label', { class: 'upload-cta picker' }, icon('camera'), pickLabel, input);
  const captionField = h('div', { class: 'field', hidden: true },
    h('label', { for: 'caption' }, 'Add a few words (optional)'),
    caption,
    h('small', null, 'Grandma sees this next to your photos.'));

  input.addEventListener('change', () => {
    const chosen = [...input.files];
    const problems = chosen.map((f) => rejectReason(f)).filter(Boolean);
    files = chosen.filter((f) => !rejectReason(f));
    mount(errors, problems.length ? h('div', { class: 'note note--error' }, problems.map((p) => h('p', null, p))) : null);
    mount(picked, files.map(previewTile));
    pickLabel.textContent = files.length ? 'Choose different ones' : 'Choose photos or videos';
    captionField.hidden = !files.length;
    send.disabled = !files.length;
    send.textContent = files.length > 1 ? `Send ${files.length} to Grandma and the family` : 'Send to Grandma and the family';
  });
  send.addEventListener('click', () => {
    if (!files.length) return;
    active = startQueue(files, caption.value.trim().slice(0, CAPTION_MAX));
    progressView(main, active);
  });

  mount(main,
    pageHead({ eyebrow: 'For Grandma’s frame', title: 'Share photos or a video', sub: 'They go to Grandma’s frame and the family feed. Videos can be up to 3 minutes.' }),
    picker, errors, picked, captionField, send,
    h('p', { class: 'row' }, h('a', { class: 'btn btn--quiet', href: '/' }, 'Cancel')));
  return () => active?.listeners.clear();
}
