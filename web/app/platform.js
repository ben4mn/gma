// Pure user-agent reading for onboarding: which phone, which browser, whether
// we're inside another app's built-in browser, and how to add to Home Screen.

const IN_APP = [
  [/FBAN\/Messenger|MessengerForiOS|FB_IAB\/MESSENGER/i, 'Messenger'],
  [/FBAN|FBAV|FB_IAB|FBIOS|\bFB4A\b/i, 'Facebook'],
  [/Instagram/i, 'Instagram'],
  [/\bGSA\/|\bGmail\b/i, 'Gmail'],
  [/Outlook|\bOWA\b|ms-office/i, 'Outlook'],
  [/Snapchat/i, 'Snapchat'],
  [/LinkedInApp/i, 'LinkedIn'],
  [/musical_ly|BytedanceWebview|TikTok/i, 'TikTok'],
  [/\bLine\//i, 'LINE'],
];

/**
 * → { os: 'ios'|'android'|'other', browser, safariVersion, iosVersion, standalone }.
 * iPadOS asks for the desktop site, so a "Macintosh" with a touch screen is iOS.
 * Safari 26 froze the OS version in its user agent, so Safari's own Version/NN
 * is the number that tells iOS 26 steps from older ones.
 */
export function detectPlatform(ua = '', { maxTouchPoints = 0, standalone = false } = {}) {
  const isIpadDesktop = /Macintosh/.test(ua) && maxTouchPoints > 1;
  const os = /iPhone|iPad|iPod/.test(ua) || isIpadDesktop ? 'ios' : /Android/.test(ua) ? 'android' : 'other';
  let browser = 'other';
  if (/CriOS|Chrome\//.test(ua) && !/EdgiOS|EdgA|Edg\//.test(ua) && !/SamsungBrowser/.test(ua)) browser = 'chrome';
  if (/FxiOS|Firefox\//.test(ua)) browser = 'firefox';
  if (/EdgiOS|EdgA|Edg\//.test(ua)) browser = 'edge';
  if (/SamsungBrowser/.test(ua)) browser = 'samsung';
  if (os !== 'android' && browser === 'other' && /Safari\//.test(ua) && /Version\//.test(ua)) browser = 'safari';
  const iosMatch = ua.match(/OS (\d+)[_.]\d+.* like Mac OS X/);
  const versionMatch = ua.match(/Version\/(\d+)/);
  return {
    os,
    browser,
    iosVersion: iosMatch ? Number(iosMatch[1]) : null,
    safariVersion: browser === 'safari' && versionMatch ? Number(versionMatch[1]) : null,
    standalone: Boolean(standalone),
  };
}

/** The name of the app whose built-in browser we're in, or null. */
export function detectInAppBrowser(ua = '', { standalone = false } = {}) {
  if (standalone) return null;
  for (const [pattern, name] of IN_APP) if (pattern.test(ua)) return name;
  // An iPhone web view that isn't Safari or a known browser has no "Safari/" token.
  if (/iPhone|iPad|iPod/.test(ua) && /AppleWebKit/.test(ua) && !/Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)) return 'another app';
  if (/Android/.test(ua) && /; wv\)/.test(ua)) return 'another app';
  return null;
}

// A mail app's built-in Safari view (Gmail and others) looks like Safari but has
// no Add to Home Screen; the way out is Safari's compass button.
export const IOS_INSIDE_APP_STEP = 'Don’t see Add to Home Screen? You may be inside another app. Tap the Safari compass at the bottom (or ••• then Open in Safari), and try again there.';

// Gmail's or Facebook's built-in browser has no Add to Home Screen, and it isn't
// always detectable, so every phone guide offers the link to paste elsewhere.
function copyLinkFor(os) {
  const browser = os === 'ios' ? 'Safari' : 'Chrome';
  return { browser, hint: `Reading this inside Gmail, Facebook or another app? Tap Copy link, open ${browser} and paste it into the address bar.` };
}

/** Steps to put the app on the Home Screen, for the platform detected above. */
export function installGuide(platform, options = {}) {
  const guide = phoneGuide(platform, options);
  if (platform.standalone || (platform.os !== 'ios' && platform.os !== 'android')) return guide;
  return { ...guide, copyLink: copyLinkFor(platform.os) };
}

function phoneGuide(platform, { canPrompt = false } = {}) {
  if (platform.standalone) return { kind: 'installed', steps: [] };
  if (platform.os === 'ios') {
    if (platform.browser === 'safari' && (platform.safariVersion ?? 0) >= 26) {
      return {
        kind: 'ios26',
        steps: [
          'Tap the ••• button at the bottom of Safari, next to the address bar.',
          'Tap Share.',
          'Scroll down and tap Add to Home Screen. (If you don’t see it, tap View More first.)',
          'Make sure Open as Web App is turned on, then tap Add.',
          IOS_INSIDE_APP_STEP,
        ],
      };
    }
    if (platform.browser === 'safari') {
      return {
        kind: 'ios',
        steps: [
          'Tap the Share button at the bottom of Safari (the square with an arrow pointing up).',
          'Scroll down and tap Add to Home Screen.',
          'Tap Add in the top corner.',
          IOS_INSIDE_APP_STEP,
        ],
      };
    }
    return {
      kind: 'ios-other',
      steps: [
        'Tap the Share button in the address bar (the square with an arrow pointing up).',
        'Tap Add to Home Screen, then Add.',
        'If you can’t find it, open this page in Safari and try there.',
      ],
    };
  }
  if (platform.os === 'android') {
    if (canPrompt) return { kind: 'android-prompt', steps: ['Tap Add to Home Screen below, then Install.'] };
    return {
      kind: 'android',
      steps: [
        'Tap the ⋮ menu at the top right of the browser.',
        'Tap Add to Home screen or Install app.',
        'Tap Install.',
      ],
    };
  }
  return { kind: 'desktop', steps: ['Grandma’s family works best on your phone. Open this page there to add it to your Home Screen.'] };
}

/** Where to send someone stuck in an app's built-in browser. */
export function openInBrowserSteps(platform) {
  const browser = platform.os === 'ios' ? 'Safari' : 'Chrome';
  return {
    browser,
    steps: [
      'Tap the menu button in a corner of this screen (it may look like ••• or ⋮).',
      `Choose Open in ${browser} (or Open in browser).`,
      `If you can’t find it, tap Copy link below, open ${browser} and paste it into the address bar.`,
    ],
  };
}

/** On iPhone and iPad, web push works only inside the installed app. */
export function canOfferPush(platform, support) {
  if (!support) return false;
  return platform.os !== 'ios' || platform.standalone;
}
