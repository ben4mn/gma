// The upload queue as a pure state machine, so progress, pauses and retries can
// be tested without a network. uploader.js drives it with tus events.

const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|avif)$/i;
const VIDEO_EXT = /\.(mov|mp4|m4v|3gp|webm)$/i;

/** 'photo' | 'video' | null for a picked File-like {name, type}. */
export function kindOf(file) {
  const type = file.type || '';
  if (type.startsWith('image/') || IMAGE_EXT.test(file.name)) return 'photo';
  if (type.startsWith('video/') || VIDEO_EXT.test(file.name)) return 'video';
  return null;
}

/** A sentence explaining why a file can't be sent, or null when it's fine. */
export function rejectReason(file, { maxBytes = 2 * 1024 ** 3 } = {}) {
  if (!kindOf(file)) return `“${file.name}” isn’t a photo or a video, so it can’t be sent.`;
  if (file.size > maxBytes) return `“${file.name}” is too big. Each file can be up to ${Math.round(maxBytes / 1024 ** 3)} GB.`;
  if (file.size === 0) return `“${file.name}” is empty.`;
  return null;
}

export function createQueue(files, { batchId, caption = '' } = {}) {
  return {
    batchId,
    caption,
    online: true,
    entries: files.map((file, index) => ({
      id: `f${index}`,
      name: file.name,
      kind: kindOf(file),
      total: file.size,
      sent: 0,
      status: 'queued', // queued → uploading → done | failed; paused while offline
      error: null,
    })),
  };
}

function update(state, id, patch) {
  return { ...state, entries: state.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)) };
}

export function reduce(state, event) {
  switch (event.type) {
    case 'start':
      return update(state, event.id, { status: 'uploading', error: null });
    case 'progress': {
      const entry = state.entries.find((e) => e.id === event.id);
      if (!entry || entry.status === 'done') return state;
      return update(state, event.id, { sent: Math.min(event.sent, event.total ?? entry.total), total: event.total ?? entry.total, status: state.online ? 'uploading' : 'paused' });
    }
    case 'success': {
      const entry = state.entries.find((e) => e.id === event.id);
      return update(state, event.id, { status: 'done', sent: entry?.total ?? 0, error: null });
    }
    case 'fail':
      return update(state, event.id, { status: 'failed', error: event.message ?? 'It didn’t send.' });
    case 'retry':
      return update(state, event.id, { status: 'queued', error: null });
    case 'offline':
      return {
        ...state,
        online: false,
        entries: state.entries.map((e) => (e.status === 'uploading' ? { ...e, status: 'paused' } : e)),
      };
    case 'online':
      return {
        ...state,
        online: true,
        entries: state.entries.map((e) => (e.status === 'paused' ? { ...e, status: 'uploading' } : e)),
      };
    default:
      return state;
  }
}

/** Which queued entries to start now, keeping at most `concurrency` in flight. */
export function nextToStart(state, concurrency = 1) {
  if (!state.online) return [];
  const inFlight = state.entries.filter((e) => e.status === 'uploading' || e.status === 'paused').length;
  const room = Math.max(0, concurrency - inFlight);
  return state.entries.filter((e) => e.status === 'queued').slice(0, room).map((e) => e.id);
}

export function summary(state) {
  const count = (s) => state.entries.filter((e) => e.status === s).length;
  const bytesTotal = state.entries.reduce((n, e) => n + e.total, 0);
  const bytesSent = state.entries.reduce((n, e) => n + e.sent, 0);
  const done = count('done');
  const failed = count('failed');
  const total = state.entries.length;
  return {
    total,
    done,
    failed,
    active: count('uploading') + count('paused') + count('queued'),
    bytesSent,
    bytesTotal,
    percent: bytesTotal ? Math.floor((bytesSent / bytesTotal) * 100) : 0,
    finished: done + failed === total,
    allSent: done === total,
  };
}

/** The status line under one file. */
export function entryLabel(entry) {
  const pct = entry.total ? Math.floor((entry.sent / entry.total) * 100) : 0;
  switch (entry.status) {
    case 'queued': return 'Waiting its turn';
    case 'uploading': return `Sending… ${pct}%`;
    case 'paused': return `Paused at ${pct}%. No internet right now; it carries on by itself.`;
    case 'done': return 'Sent';
    case 'failed': return entry.error || 'It didn’t send.';
    default: return '';
  }
}
