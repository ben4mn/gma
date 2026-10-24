// Who is asking: the client's IP address, for rate limits and the sign-in log.
//
// Behind the tunnel every request arrives from cloudflared, so the socket's
// address is the proxy's. Cloudflare puts the real client in CF-Connecting-IP
// (and overwrites whatever the client sent), but anyone who can reach the app
// directly could send that header too. So it is believed only when the
// request came from a trusted proxy (TRUST_PROXY: true, or a list of
// addresses and ranges); otherwise the answer is `request.ip`.
//
// app.js sets `request.clientIp` for every request in an onRequest hook, so
// routes read that. `clientIp(request)` works anywhere a request is at hand,
// and `rateLimitKey` is the default rate-limit key for every route.

import net from 'node:net';

const MAX_HEADER_LENGTH = 64;

// "::ffff:10.35.0.3" (an IPv4 peer on a dual-stack socket) → "10.35.0.3".
export function normalizeAddress(address) {
  if (typeof address !== 'string') return '';
  const trimmed = address.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  return mapped ? mapped[1] : trimmed;
}

// config.trustProxy (true | false | ['10.35.0.3', '10.35.0.0/24', …]) →
// (address) => is this peer a trusted proxy?
export function compileTrust(trustProxy) {
  if (trustProxy === true) return () => true;
  if (!Array.isArray(trustProxy) || trustProxy.length === 0) return () => false;
  const list = new net.BlockList();
  for (const entry of trustProxy) {
    const [address, prefix] = entry.split('/');
    const family = net.isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(prefix), family);
  }
  return (address) => {
    const peer = normalizeAddress(address);
    const family = net.isIP(peer);
    if (family === 0) return false;
    return list.check(peer, family === 6 ? 'ipv6' : 'ipv4');
  };
}

const compiled = new WeakMap(); // config → trust function

function trustFor(config) {
  if (!config || typeof config !== 'object') return () => false;
  let trust = compiled.get(config);
  if (!trust) {
    trust = compileTrust(config.trustProxy);
    compiled.set(config, trust);
  }
  return trust;
}

function peerAddress(request) {
  return request.raw?.socket?.remoteAddress ?? request.socket?.remoteAddress ?? '';
}

// Did this request reach the app through a trusted proxy (TRUST_PROXY)? Only
// then are the proxy's headers (CF-Connecting-IP, X-Forwarded-Proto) believed.
// `trust` defaults to the app's TRUST_PROXY.
export function fromTrustedProxy(request, trust = trustFor(request.server?.config)) {
  return trust(peerAddress(request));
}

// The client's address, worked out from scratch. `trust` defaults to the
// app's TRUST_PROXY.
export function resolveClientIp(request, trust = trustFor(request.server?.config)) {
  const header = request.headers?.['cf-connecting-ip'];
  if (typeof header === 'string' && header.length > 0 && header.length <= MAX_HEADER_LENGTH) {
    const candidate = normalizeAddress(header);
    if (net.isIP(candidate) !== 0 && fromTrustedProxy(request, trust)) return candidate;
  }
  return normalizeAddress(request.ip);
}

// The scheme the visitor used, as a trusted proxy reports it in
// X-Forwarded-Proto ('http' or 'https'), or null when no trusted proxy said.
// The first entry is the one the visitor's own request came in on.
export function forwardedProto(request, trust = trustFor(request.server?.config)) {
  const header = request.headers?.['x-forwarded-proto'];
  if (typeof header !== 'string' || header.length === 0 || header.length > MAX_HEADER_LENGTH) return null;
  if (!fromTrustedProxy(request, trust)) return null;
  const proto = header.split(',')[0].trim().toLowerCase();
  return proto === 'http' || proto === 'https' ? proto : null;
}

// The client's address: what the onRequest hook worked out, or the same
// answer worked out now (for code that runs before the hook, like tests).
export function clientIp(request) {
  return request.clientIp || resolveClientIp(request);
}

// IPv6 clients usually hold a whole /64, so they are limited as one.
function ipv6Prefix64(address) {
  const [head, tail = ''] = address.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  // An embedded IPv4 tail ("::ffff:1.2.3.4") counts as two groups.
  const groups = (parts) => parts.reduce((n, part) => n + (part.includes('.') ? 2 : 1), 0);
  const fill = address.includes('::') ? 8 - groups(left) - groups(right) : 0;
  const full = [...left, ...Array(Math.max(fill, 0)).fill('0'), ...right];
  return `${full
    .slice(0, 4)
    .map((part) => (part.includes('.') ? part : part.replace(/^0+(?=.)/, '')))
    .join(':')}::/64`;
}

// The default rate-limit key: the client's address (an IPv6 client's /64).
export function rateLimitKey(request) {
  const ip = clientIp(request);
  return net.isIP(ip) === 6 ? ipv6Prefix64(ip) : ip;
}
