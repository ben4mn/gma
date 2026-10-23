import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, detectInAppBrowser, installGuide, canOfferPush } from '../app/platform.js';

const UA = {
  safari26: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  safari17: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  chromeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36',
  facebook: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/500.0]',
  instagram: 'Mozilla/5.0 (Linux; Android 15; Pixel 9; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0 Mobile Safari/537.36 Instagram 350.0',
  gmailIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  outlook: 'Mozilla/5.0 (Linux; Android 15; wv) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36 PKeyAuth/1.0 Outlook-Android/4.2',
};

test('detectPlatform reads the phone and browser', () => {
  assert.deepEqual(detectPlatform(UA.safari26), { os: 'ios', browser: 'safari', iosVersion: 18, safariVersion: 26, standalone: false });
  assert.equal(detectPlatform(UA.ipad, { maxTouchPoints: 5 }).os, 'ios');
  assert.equal(detectPlatform(UA.ipad, { maxTouchPoints: 0 }).os, 'other');
  assert.equal(detectPlatform(UA.chromeIos).browser, 'chrome');
  assert.equal(detectPlatform(UA.android).os, 'android');
});

test('in-app browsers are named; real browsers and the installed app are not', () => {
  assert.equal(detectInAppBrowser(UA.facebook), 'Facebook');
  assert.equal(detectInAppBrowser(UA.instagram), 'Instagram');
  assert.equal(detectInAppBrowser(UA.outlook), 'Outlook');
  assert.equal(detectInAppBrowser(UA.gmailIos), 'another app');
  assert.equal(detectInAppBrowser(UA.gmailIos, { standalone: true }), null);
  assert.equal(detectInAppBrowser(UA.safari26), null);
  assert.equal(detectInAppBrowser(UA.chromeIos), null);
  assert.equal(detectInAppBrowser(UA.android), null);
});

test('install steps per platform', () => {
  const ios26 = installGuide(detectPlatform(UA.safari26));
  assert.equal(ios26.kind, 'ios26');
  assert.match(ios26.steps.join(' '), /•••.*Share.*Open as Web App/s);
  assert.equal(installGuide(detectPlatform(UA.safari17)).kind, 'ios');
  // A mail app's built-in Safari view sends Safari's user agent: every Safari guide ends with the way out (F10).
  for (const ua of [UA.safari26, UA.safari17]) {
    assert.match(installGuide(detectPlatform(ua)).steps.at(-1), /inside another app.*Safari compass/);
  }
  assert.equal(installGuide(detectPlatform(UA.android)).kind, 'android');
  assert.equal(installGuide(detectPlatform(UA.android), { canPrompt: true }).kind, 'android-prompt');
  assert.equal(installGuide(detectPlatform(UA.safari17, { standalone: true })).kind, 'installed');
});

test('iPhone push only in the installed app', () => {
  assert.equal(canOfferPush(detectPlatform(UA.safari26), true), false);
  assert.equal(canOfferPush(detectPlatform(UA.safari26, { standalone: true }), true), true);
  assert.equal(canOfferPush(detectPlatform(UA.android), true), true);
  assert.equal(canOfferPush(detectPlatform(UA.android), false), false);
});

test('every phone guide offers Copy link for in-app browsers; installed and desktop do not', () => {
  for (const [ua, browser] of [[UA.safari26, 'Safari'], [UA.safari17, 'Safari'], [UA.android, 'Chrome']]) {
    const guide = installGuide(detectPlatform(ua));
    assert.equal(guide.copyLink?.browser, browser, ua);
    assert.match(guide.copyLink.hint, new RegExp(`Copy link.*${browser}`));
  }
  assert.equal(installGuide(detectPlatform(UA.android), { canPrompt: true }).copyLink?.browser, 'Chrome');
  assert.equal(installGuide(detectPlatform(UA.safari17, { standalone: true })).copyLink, undefined);
  assert.equal(installGuide(detectPlatform('Mozilla/5.0 (Windows NT 10.0)')).copyLink, undefined);
});
