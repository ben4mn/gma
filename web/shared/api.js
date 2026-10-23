// The one way the web apps talk to the server: JSON in, JSON out, and every
// failure becomes an ApiError whose message a person can read.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const OFFLINE_MESSAGE = "We couldn't reach the family app. Check your connection and try again.";

export function messageForStatus(status) {
  if (status === 401) return 'Please sign in again.';
  if (status === 403) return "You don't have access to that.";
  if (status === 404) return "We couldn't find that. It may have been removed.";
  if (status === 413) return 'That file is too big to send.';
  if (status === 429) return 'Too many tries. Wait a few minutes and try again.';
  if (status >= 500) return 'Something went wrong on our side. Please try again in a minute.';
  return 'Something went wrong. Please try again.';
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  const headers = { accept: 'application/json' };
  // The server only accepts JSON bodies on state-changing requests (its CSRF rule).
  const sendsBody = method !== 'GET' && method !== 'HEAD';
  if (sendsBody) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: sendsBody ? JSON.stringify(body ?? {}) : undefined,
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, 'offline', OFFLINE_MESSAGE);
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const error = data?.error;
    throw new ApiError(res.status, error?.code ?? `http_${res.status}`, error?.message || messageForStatus(res.status));
  }
  return data;
}

api.get = (path, opts) => api(path, { ...opts, method: 'GET' });
api.post = (path, body, opts) => api(path, { ...opts, method: 'POST', body });
api.put = (path, body, opts) => api(path, { ...opts, method: 'PUT', body });
api.patch = (path, body, opts) => api(path, { ...opts, method: 'PATCH', body });
api.del = (path, opts) => api(path, { ...opts, method: 'DELETE' });
