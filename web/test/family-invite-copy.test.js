import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inviteProblemCopy } from '../app/invite-copy.js';

test('a used invite says they already joined and offers sign in, never "expired"', () => {
  const copy = inviteProblemCopy('used');
  assert.equal(copy.title, 'You’ve already joined');
  assert.match(copy.sub, /Sign in to see the family photos/);
  assert.doesNotMatch(`${copy.title} ${copy.sub} ${copy.line ?? ''}`, /expired/i);
  assert.equal(copy.action.href, '/signin');
});

test('a cancelled invite has its own words and points to a newer one', () => {
  const copy = inviteProblemCopy('revoked');
  assert.equal(copy.title, 'This invite was cancelled');
  assert.match(copy.sub, /newer invite/);
  assert.doesNotMatch(copy.title + copy.sub, /expired/i);
});

test('expired keeps the 14 days; unknown asks to check the link', () => {
  assert.equal(inviteProblemCopy('expired').title, 'This invite has expired');
  assert.match(inviteProblemCopy('expired').sub, /14 days/);
  assert.equal(inviteProblemCopy('unknown').title, 'We couldn’t find this invite');
  assert.match(inviteProblemCopy('unknown').sub, /whole link/);
});

test('a reason the app doesn’t know reads like an unknown invite', () => {
  assert.deepEqual(inviteProblemCopy(undefined), inviteProblemCopy('unknown'));
  assert.deepEqual(inviteProblemCopy('something-new'), inviteProblemCopy('unknown'));
});

test('every reason lets someone who already joined sign in', () => {
  for (const reason of ['used', 'revoked', 'expired', 'unknown']) {
    assert.equal(inviteProblemCopy(reason).action.href, '/signin', reason);
  }
});
