// Rate-limit keys for routes. app.js works out request.clientIp once per
// request (lib/client-ip.js: CF-Connecting-IP only from a trusted proxy, else
// request.ip); every per-IP limit and every stored ip uses it.

import { clientIp as resolveClientIp, rateLimitKey } from './client-ip.js';

// The client's address, for storing (login_codes.ip) and logs.
export function clientIp(request) {
  return request.clientIp ?? resolveClientIp(request);
}

// Route config for a per-IP limit: { config: perIp(20, '1 hour') }. An IPv6
// client's whole /64 counts as one.
export function perIp(max, timeWindow) {
  return { rateLimit: { max, timeWindow, keyGenerator: rateLimitKey } };
}
