// What the join page says when an invite can't be used, one message for each
// reason GET /api/invites/:token gives (unknown, expired, revoked, used).
// Relatives often tap the invite email again later to open the app, so a used
// invite is good news, not a dead end.

const SIGN_IN = { label: 'Sign in', href: '/signin' };

const COPY = {
  used: {
    title: 'You’ve already joined',
    sub: 'This invite has done its job. Sign in to see the family photos.',
    line: null,
  },
  revoked: {
    title: 'This invite was cancelled',
    sub: 'Ben may have sent you a newer invite. Look for it in your email or texts, or ask Ben for a new one.',
    line: 'Already joined? You can sign in instead.',
  },
  expired: {
    title: 'This invite has expired',
    sub: 'Invites work for 14 days. Ask Ben to send you a new one.',
    line: 'Already joined? You can sign in instead.',
  },
  unknown: {
    title: 'We couldn’t find this invite',
    sub: 'Check that you opened the whole link from your email or text, or ask Ben for a new one.',
    line: 'Already joined? You can sign in instead.',
  },
};

/** → { title, sub, line, action: {label, href} } for an invite that can't be used. */
export function inviteProblemCopy(reason) {
  const copy = COPY[reason] ?? COPY.unknown;
  return { ...copy, action: SIGN_IN };
}
