// Keeps secrets out of request logs: the frame's pairing token (?device=),
// confirm-link tokens (?t=) and anything called token or code.

const SECRET_PARAMS = new Set(['device', 't', 'token', 'code']);

export function redactUrl(url) {
  if (typeof url !== 'string') return url;
  const q = url.indexOf('?');
  if (q === -1) return url;
  const pathPart = url.slice(0, q);
  const hashAt = url.indexOf('#', q);
  const query = url.slice(q + 1, hashAt === -1 ? undefined : hashAt);
  const redacted = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const rawName = eq === -1 ? pair : pair.slice(0, eq);
      let name = rawName;
      try {
        name = decodeURIComponent(rawName.replace(/\+/g, ' '));
      } catch {
        // keep the raw name if it isn't valid percent-encoding
      }
      return SECRET_PARAMS.has(name.toLowerCase()) ? `${rawName}=REDACTED` : pair;
    })
    .join('&');
  return `${pathPart}?${redacted}`;
}

// The URL with the secret parameters removed entirely (for redirect targets
// such as /signin?next=…, which would otherwise carry them along).
export function stripSecretParams(url) {
  const parsed = new URL(url, 'http://local');
  for (const name of [...parsed.searchParams.keys()]) {
    if (SECRET_PARAMS.has(name.toLowerCase())) parsed.searchParams.delete(name);
  }
  return parsed.pathname + parsed.search;
}
