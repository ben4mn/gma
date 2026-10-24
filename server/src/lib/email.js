// Sends email through SMTP ('smtp': nodemailer, made for Gmail with an app
// password), Resend's REST API ('resend') or prints it ('console', development
// and the first days of a deploy). Templates return { subject, text, html }.
//
// Tests call captureEmails(config) to receive every message sent with that
// config instead of printing or sending it, and useSmtpFactory(config, fn) to
// hand the smtp transport a fake nodemailer.
//
// An EmailError never carries the message, the password or the recipient's
// address (only its domain, as `domain`): the app logs it as it is.

import { createTransport } from 'nodemailer';

const RESEND_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 10_000;

// One connection per message (no pool): a family app sends a few a day.
// Gmail allows about 500 recipients a day from one account.
export const SMTP_TIMEOUTS = Object.freeze({ connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });

const captures = new WeakMap(); // config → array of sent messages
const smtpFactories = new WeakMap(); // config → (options) => nodemailer transport

export function captureEmails(config) {
  let box = captures.get(config);
  if (!box) {
    box = [];
    captures.set(config, box);
  }
  return box;
}

// Tests: the smtp transport builds its nodemailer transport with `factory`.
export function useSmtpFactory(config, factory) {
  smtpFactories.set(config, factory);
}

export class EmailError extends Error {
  constructor(message, { status, code, domain } = {}) {
    super(message);
    this.name = 'EmailError';
    this.status = status;
    if (code) this.code = code;
    if (domain) this.domain = domain;
  }
}

// The part of an address after the @, for logs; never the whole address.
function domainOf(address) {
  const domain = String(address ?? '').split('@').pop().trim().toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : undefined;
}

// What nodemailer is given for config (`pool` stays off).
export function smtpOptions(config) {
  return {
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    // Without implicit TLS (port 587), STARTTLS is required: the password
    // never crosses in the clear.
    requireTLS: !config.smtpSecure,
    auth: { user: config.smtpUser, pass: config.smtpPass },
    ...SMTP_TIMEOUTS,
    logger: false,
    debug: false,
    // The templates never attach anything: no reading files or URLs.
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

// nodemailer's error codes, as a sentence. Its own messages can quote the
// server's reply, the recipient and the AUTH command, so they never pass through.
const SMTP_REASONS = {
  EAUTH: 'The email server refused the sign-in: check SMTP_USER and SMTP_PASS; Gmail needs an app password',
  ENOAUTH: 'The email server wants a sign-in: set SMTP_USER and SMTP_PASS',
  ETIMEDOUT: 'Could not reach the email server',
  ECONNECTION: 'Could not reach the email server',
  ESOCKET: 'Could not reach the email server',
  EDNS: 'Could not reach the email server',
  ETLS: 'Could not make a secure connection to the email server',
  EENVELOPE: 'The email server refused the address',
  EMESSAGE: 'The email server refused the message',
  EPROTOCOL: 'The email server answered something unexpected',
};

function smtpError(err, to) {
  const code = typeof err?.code === 'string' && /^E[A-Z]{2,20}$/.test(err.code) ? err.code : undefined;
  const status = Number.isInteger(err?.responseCode) ? err.responseCode : undefined;
  const reason = SMTP_REASONS[code] ?? 'The email server refused the message';
  const detail = [code, status].filter(Boolean).join(' ');
  return new EmailError(detail ? `${reason} (${detail})` : reason, { status, code, domain: domainOf(to) });
}

async function sendSmtp(config, { from, to, subject, text, html }) {
  const factory = smtpFactories.get(config) ?? createTransport;
  let transport;
  try {
    transport = factory(smtpOptions(config));
    const info = await transport.sendMail({ from, to, subject, text, html });
    return { id: info?.messageId ?? null };
  } catch (err) {
    throw smtpError(err, to);
  } finally {
    try {
      transport?.close?.();
    } catch {
      // nothing to close
    }
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
    // Development, and the first days of a deploy before Gmail is set up: the
    // whole message, so you can copy the code. Nothing was emailed, so callers
    // must not treat it as delivered (`printed: true`): an invite printed here
    // never proves the address.
    console.log(`\n--- email to ${to} ---\nSubject: ${subject}\n\n${text}\n--- end ---\n`);
    return { id: 'console', printed: true };
  }

  // A message SMTP or Resend accepted counts as emailed (no `printed`).
  if (config.emailTransport === 'smtp') return sendSmtp(config, message);

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
    throw new EmailError(`Could not reach the email service: ${err.message}`, { domain: domainOf(to) });
  }
  if (!response.ok) {
    // The response body can echo the message; keep only the status.
    throw new EmailError(`The email service refused the message (HTTP ${response.status})`, {
      status: response.status,
      domain: domainOf(to),
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

// The short message `npm run email:test` sends to check the settings.
export function testEmail({ publicUrl, transport }) {
  const subject = "Test email from Grandma's family";
  const text = [
    'Hi,',
    '',
    `This is a test from ${publicUrl} (EMAIL_TRANSPORT=${transport}). If you can read it, sign-in codes and invites will arrive too.`,
    '',
    'Nothing to do; you can delete it.',
  ].join('\n');
  const html = layout({
    paragraphs: [
      'Hi,',
      `This is a test from ${escapeHtml(publicUrl)} (EMAIL_TRANSPORT=${escapeHtml(transport)}). If you can read it, sign-in codes and invites will arrive too.`,
    ],
    footnote: 'Nothing to do; you can delete it.',
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
