// The frame's only door to the server. In fixture mode (?fixture=1) it reads
// fixtures/state.json and pretends every send worked, so screenshots need no server.

export function createApi({ fixture = false, base = '' } = {}) {
  async function getState() {
    if (fixture) {
      const res = await fetch(new URL('../fixtures/state.json', import.meta.url));
      return { state: await res.json(), cached: false };
    }
    const res = await fetch(`${base}/api/frame/state`, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    // the service worker marks the last good copy it serves while the server is unreachable
    return { state: await res.json(), cached: res.headers.get('X-Gma-Cached') === '1' };
  }

  async function post(path, body) {
    if (fixture) return { status: 200 };
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: isForm ? undefined : { 'Content-Type': 'application/json' },
        body: isForm ? body : JSON.stringify(body),
      });
      let error = null;
      if (!res.ok) error = (await res.json().catch(() => null))?.error?.message ?? `HTTP ${res.status}`;
      return { status: res.status, error };
    } catch (err) {
      return { status: 0, error: String(err?.message ?? err) };
    }
  }

  /** Send one outbox entry. */
  function send(entry) {
    const { kind, payload, client_id } = entry;
    if (kind === 'react') return post('/api/frame/react', { item_id: payload.item_id, reaction: payload.reaction, client_id });
    if (kind === 'preset') return post('/api/frame/preset', { item_id: payload.item_id, preset_id: payload.preset_id, client_id });
    if (kind === 'seen') return post('/api/frame/seen', { item_ids: payload.item_ids });
    if (kind === 'voice') {
      const form = new FormData();
      form.append('client_id', client_id);
      form.append('audio', payload.audio, payload.filename ?? 'voice.webm');
      return post('/api/frame/voice', form);
    }
    return Promise.resolve({ status: 400, error: `Unknown outbox entry: ${kind}` });
  }

  function heartbeat(body) {
    return post('/api/frame/heartbeat', body);
  }

  return { getState, send, heartbeat, fixture };
}
