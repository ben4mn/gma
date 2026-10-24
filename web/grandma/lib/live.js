// Live updates over SSE. EventSource reconnects by itself after a dropped
// connection (sending Last-Event-ID), but gives up for good after an HTTP error
// such as the tunnel's 502; then we open a new one, backing off up to a minute.
// Every (re)connect is followed by onOpen, so the frame can refetch its state.

const TOPICS = ['item.ready', 'item.removed', 'settings.changed', 'frame.reload', 'reload', 'resync'];

export function connectLive({ url = '/api/events', onEvent, onOpen, onDown }) {
  let source = null;
  let retryMs = 2000;
  let timer = null;
  let stopped = false;

  function dispatch(topic, raw) {
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
    onEvent(topic, data);
  }

  function open() {
    source = new EventSource(url, { withCredentials: true });
    source.onopen = () => { retryMs = 2000; onOpen?.(); };
    for (const topic of TOPICS) source.addEventListener(topic, (e) => dispatch(topic, e.data));
    // a server that sends unnamed events puts the topic in the payload
    source.onmessage = (e) => {
      let data = null;
      try { data = JSON.parse(e.data); } catch { return; }
      if (data?.topic) onEvent(data.topic, data.payload ?? data);
    };
    source.onerror = () => {
      onDown?.();
      if (source.readyState !== EventSource.CLOSED || stopped) return;
      clearTimeout(timer);
      timer = setTimeout(open, retryMs);
      retryMs = Math.min(retryMs * 2, 60_000);
    };
  }

  open();
  return { close() { stopped = true; clearTimeout(timer); source?.close(); } };
}
