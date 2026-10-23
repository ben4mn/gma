// Keeps secrets out of request logs: the frame's pairing token (?device=),
// confirm-link tokens (?t=), anything called token or code, and invite tokens,
// which travel in the path (/join/<token>, /api/invites/<token>/accept).

const SECRET_PARAMS = new Set(['device', 't', 'token', 'code']);
const SECRET_PATHS = /^(\/join\/|\/api\/invites\/)[^/?#]+/;

export function redactPath(pathPart) {
  return pathPart.replace(SECRET_PATHS, '$1REDACTED');
}

export function redactUrl(url) {
  if (typeof url !== 'string') return url;
  const q = url.indexOf('?');
  if (q === -1) return redactPath(url);
  const pathPart = redactPath(url.slice(0, q));
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
