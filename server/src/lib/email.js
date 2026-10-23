// Sends email through Resend's REST API ('resend') or prints it ('console',
// development only). Templates return { subject, text, html }.
//
// Tests call captureEmails(config) to receive every message sent with that
// config instead of printing or sending it.

const RESEND_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 10_000;

const captures = new WeakMap(); // config → array of sent messages

export function captureEmails(config) {
  let box = captures.get(config);
  if (!box) {
    box = [];
    captures.set(config, box);
  }
  return box;
}

export class EmailError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'EmailError';
    this.status = status;
  }
}

export async function sendEmail(config, { to, subject, text, html }) {
  if (!to || !subject || !text) throw new TypeError('sendEmail needs to, subject and text');
  const message = { from: config.emailFrom, to, subject, text, html };

  const box = captures.get(config);
  if (box) {
    box.push(message);
    return { id: `captured-${box.length}` };
  }

  if (config.emailTransport === 'console') {
    // Development, and the first days of a deploy before Resend is set up: the
    // whole message, so you can copy the code. Nothing was emailed, so callers
    // must not treat it as delivered (`printed: true`): an invite printed here
    // never proves the address.
    console.log(`\n--- email to ${to} ---\nSubject: ${subject}\n\n${text}\n--- end ---\n`);
    return { id: 'console', printed: true };
  }

  let response;
  try {
    response = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.resendApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from: message.from, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    throw new EmailError(`Could not reach the email service: ${err.message}`);
  }
  if (!response.ok) {
    // The response body can echo the message; keep only the status.
    throw new EmailError(`The email service refused the message (HTTP ${response.status})`, {
      status: response.status,
    });
  }
  const body = await response.json().catch(() => ({}));
  return { id: body.id ?? null };
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// `paragraphs` are trusted HTML fragments (escape anything user-supplied first).
function layout({ paragraphs, button, footnote }) {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${p}</p>`).join('');
  const cta = button
    ? `<p style="margin:24px 0"><a href="${escapeHtml(button.href)}" style="display:inline-block;background:#8A3517;color:#FFF8EC;padding:14px 22px;border-radius:10px;text-decoration:none;font-weight:bold">${escapeHtml(button.label)}</a></p>`
    : '';
  const note = footnote ? `<p style="margin:0;color:#57473A;font-size:15px">${footnote}</p>` : '';
  return `<!doctype html><html><body style="margin:0;background:#F5EEE2;padding:24px;font-family:Georgia,serif;color:#2B2119;font-size:17px;line-height:1.5"><div style="max-width:520px;margin:0 auto;background:#FFFDF8;border-radius:12px;padding:28px">${body}${cta}${note}</div></body></html>`;
}

function greeting(name) {
  return name ? `Hi ${name},` : 'Hi,';
}

// The sign-in email: a 6-digit code to type in the app, plus a confirm link
// (the /confirm page needs a tap, so mail scanners can't use it up).
export function signInCodeEmail({ name, code, confirmUrl, minutes = 15 }) {
  const subject = `${code} is your code for Grandma's family`;
  const text = [
    greeting(name),
    '',
    `Your sign-in code is ${code}. Type it into the app. It works for ${minutes} minutes.`,
    '',
    'Using the app on your Home Screen? Type the code there.',
    'On a computer, or in your web browser, you can open this link and tap the button instead:',
    confirmUrl,
    '',
    "If you didn't ask for this, you can ignore this email.",
  ].join('\n');
  const html = layout({
    paragraphs: [
      escapeHtml(greeting(name)),
      `Your sign-in code is<br><strong style="font-size:32px;letter-spacing:6px">${escapeHtml(code)}</strong>`,
      `Type it into the app. It works for ${minutes} minutes.`,
      'Using the app on your Home Screen? Type the code there. On a computer, or in your web browser, you can tap this button instead:',
    ],
    button: { href: confirmUrl, label: 'Sign in with this link' },
    footnote: "If you didn't ask for this, you can ignore this email.",
  });
  return { subject, text, html };
}

// The invite: who it's from, what the app is, and the link to join.
export function inviteEmail({ name, inviterName, joinUrl, days = 14 }) {
  const from = inviterName || 'Your family';
  const subject = `${from} invited you to Grandma's family`;
  const text = [
    greeting(name),
    '',
    `${from} invited you to Grandma's family, a private place to send Grandma photos and videos and to see what she sends back.`,
    '',
    'Tap this link on your phone to join:',
    joinUrl,
    '',
    `The link works for ${days} days and only for you, so please don't forward it.`,
  ].join('\n');
  const html = layout({
    paragraphs: [
      escapeHtml(greeting(name)),
      `${escapeHtml(from)} invited you to Grandma's family, a private place to send Grandma photos and videos and to see what she sends back.`,
      'Tap the button on your phone to join.',
    ],
    button: { href: joinUrl, label: 'Join the family' },
    footnote: `The link works for ${days} days and only for you, so please don't forward it.`,
  });
  return { subject, text, html };
}
