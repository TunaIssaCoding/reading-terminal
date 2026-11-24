import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoFinish } from '../js/progress.js';

test('90% auto-finish offers Undo, restores reading and re-arms only below 90%', () => {
  const tracker = createAutoFinish();
  assert.equal(tracker.observe('reading', 0.899), null);
  const change = tracker.observe('reading', 0.9);
  assert.equal(change.progress, 'finished');
  assert.match(change.message, /Marked finished/);
  assert.equal(change.undo(), 'reading');
  assert.equal(tracker.observe('reading', 0.95), null);
  assert.equal(tracker.observe('reading', 0.9), null);
  assert.equal(tracker.observe('reading', 0.89), null);
  assert.equal(tracker.observe('reading', 0.91).progress, 'finished');
});

test('scroll never changes finished, let-go or unopened progress', () => {
  for (const progress of ['new', 'finished', 'let_go']) {
    assert.equal(createAutoFinish().observe(progress, 1), null);
  }
});

test('automatic finish stays disarmed across repeated scrolls without Undo', () => {
  const tracker = createAutoFinish();
  tracker.observe('reading', 0.95);
  assert.equal(tracker.observe('reading', 1), null);
});
