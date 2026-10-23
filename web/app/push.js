// Web push: ask from a tap, subscribe with the server's VAPID key, and re-sync
// the subscription every time the app opens (browsers drop them quietly).
import { api } from '../shared/api.js';

const OFF_KEY = 'gma.push.off'; // set when someone turns notifications off here, so a re-sync won't undo it

function rememberOff(off) {
  try { off ? localStorage.setItem(OFF_KEY, '1') : localStorage.removeItem(OFF_KEY); } catch { /* private mode */ }
}

function isRememberedOff() {
  try { return localStorage.getItem(OFF_KEY) === '1'; } catch { return false; }
}

export function pushSupported() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function pushPermission() {
  return pushSupported() ? Notification.permission : 'unsupported';
}

function keyBytes(base64url) {
  const padded = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function sameKey(sub, key) {
  const current = sub.options?.applicationServerKey;
  if (!current) return true;
  const a = new Uint8Array(current);
  return a.length === key.length && a.every((v, i) => v === key[i]);
}

async function serverKey() {
  const res = await api.get('/api/push/key');
  return keyBytes(res?.key ?? res?.publicKey ?? res?.vapid_public_key ?? '');
}

async function subscribeAndSend(reg) {
  const key = await serverKey();
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const json = sub.toJSON();
  await api.post('/api/push/subscribe', { endpoint: json.endpoint, keys: json.keys });
  return sub;
}

/** From a tap: the permission prompt must be the first thing that happens. */
export async function turnOnPush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied'
      ? 'Notifications are turned off for this app. You can turn them on in your phone’s Settings.'
      : 'No problem. You can turn notifications on any time from the You page.');
  }
  const reg = await navigator.serviceWorker.ready;
  await subscribeAndSend(reg);
  rememberOff(false);
}

export async function turnOffPush() {
  rememberOff(true);
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  try { await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }); } finally { await sub.unsubscribe(); }
}

export async function isPushOn() {
  if (pushPermission() !== 'granted') return false;
  const reg = await navigator.serviceWorker.ready;
  return Boolean(await reg.pushManager.getSubscription());
}

/** On every launch: if permission was granted, make sure the server has our current subscription. */
export async function resyncPush() {
  if (pushPermission() !== 'granted' || isRememberedOff()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    await subscribeAndSend(reg);
  } catch { /* try again next launch */ }
}
