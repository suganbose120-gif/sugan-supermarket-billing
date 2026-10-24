import assert from 'node:assert/strict';
import test from 'node:test';
import { installF2Shortcut } from '../src/shortcuts.js';

function keyEvent(key) {
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperty(event, 'key', { value: key });
  return event;
}

test('F2 prevents the browser default and invokes the shared new-bill action', () => {
  const target = new EventTarget();
  let starts = 0;
  const cleanup = installF2Shortcut(target, () => { starts += 1; });
  const event = keyEvent('F2');

  target.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(starts, 1);
  cleanup();
});

test('F2 is swallowed but does not start a bill while a blocking modal is active', () => {
  const target = new EventTarget();
  let starts = 0;
  installF2Shortcut(target, () => { starts += 1; }, () => true);
  const event = keyEvent('F2');

  target.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(starts, 0);
});

test('F2 listener cleanup prevents duplicate or stale starts after unmount', () => {
  const target = new EventTarget();
  let starts = 0;
  const cleanup = installF2Shortcut(target, () => { starts += 1; });

  target.dispatchEvent(keyEvent('Escape'));
  assert.equal(starts, 0);
  cleanup();
  target.dispatchEvent(keyEvent('F2'));
  assert.equal(starts, 0);
});
