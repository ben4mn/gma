// Live updates from GET /api/events. Each event arrives named by its topic
// (`event: item.ready`). EventSource resumes with Last-Event-ID on its own while
// the connection is merely interrupted; when the server closes it for good (a
// restart, a 5xx) we open a new one with a gentle backoff. Either way, and when
// the server says `resync` (we missed too much), the caller refetches what it shows.

export const TOPICS = ['item.ready', 'item.removed', 'item.failed', 'grandma.event', 'settings.changed', 'frame.reload'];

export function connectEvents({ url = '/api/events', topics = TOPICS, onEvent, onReconnect } = {}) {
  let source = null;
  let closed = false;
  let retryMs = 1000;
  let timer = null;
  let opened = false;

  const dispatch = (topic) => (event) => {
    let payload = null;
    try { payload = event.data ? JSON.parse(event.data) : null; } catch { payload = event.data; }
    const name = topic ?? payload?.topic ?? 'message';
    onEvent?.(name, payload?.payload ?? payload, event);
  };

  function open() {
    source = new EventSource(url, { withCredentials: true });
    source.onmessage = dispatch(null);
    for (const topic of topics) source.addEventListener(topic, dispatch(topic));
    source.addEventListener('resync', () => onReconnect?.());
    source.onopen = () => {
      if (opened) onReconnect?.();
      opened = true;
      retryMs = 1000;
    };
    source.onerror = () => {
      if (closed || source.readyState !== EventSource.CLOSED) return;
      timer = setTimeout(open, retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
    };
  }

  open();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      source?.close();
    },
  };
}
