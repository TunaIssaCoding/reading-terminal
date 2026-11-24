import test from 'node:test';
import assert from 'node:assert/strict';
import { splitArrivals, defaultView, pileThisWeek, libraryShelves } from '../js/model.js';

const boundary = '2026-06-01T00:00:00.000Z';
const older = '2026-05-31T23:59:59.999Z';
const ids = items => items.map(item => item.id);

test('arrivals boundary is inclusive and falls back to created_at without mutating records', () => {
  const items = [
    { id: 'old', added_at: older },
    { id: 'boundary', added_at: boundary },
    { id: 'fallback-old', created_at: older },
    { id: 'fallback-boundary', created_at: boundary },
    { id: 'explicit-new', added_at: boundary, created_at: older },
    { id: 'explicit-old', added_at: older, created_at: boundary },
    { id: 'undated' },
    { id: 'invalid', added_at: 'not a date' },
  ];
  const before = structuredClone(items);
  const result = splitArrivals(items, {}, boundary);
  assert.deepEqual(ids(result.arrivals), ['boundary', 'fallback-boundary', 'explicit-new']);
  assert.deepEqual(ids(result.pile), ['old', 'fallback-old', 'explicit-old']);
  assert.deepEqual(items, before);
  assert.deepEqual(splitArrivals(items, {}, 'invalid'), { arrivals: [], pile: [] });
});

test('untriaged arrivals include reading and other progress, but the pile includes only new untriaged records', () => {
  const items = [];
  const state = {};
  for (const progress of ['new', 'reading', 'finished', 'let_go']) {
    for (const age of ['old', 'arrival']) {
      for (const triaged of [false, true]) {
        const id = `${age}-${progress}-${triaged}`;
        items.push({ id, added_at: age === 'old' ? older : boundary });
        state[id] = { progress, triaged_at: triaged ? boundary : null };
      }
    }
  }
  const result = splitArrivals(items, state, boundary);
  assert.deepEqual(ids(result.arrivals), ['arrival-new-false', 'arrival-reading-false', 'arrival-finished-false', 'arrival-let_go-false']);
  assert.deepEqual(ids(result.pile), ['old-new-false']);
});

test('default view prioritizes Up next, then Arrivals, then Library', () => {
  assert.equal(defaultView(['queued'], [{ id: 'arrived' }]), 'queue');
  assert.equal(defaultView(['queued'], []), 'queue');
  assert.equal(defaultView([], [{ id: 'arrived' }]), 'arrivals');
  assert.equal(defaultView([], []), 'library');
});

test('pile counter uses local Monday midnight and excludes future or post-boundary triage', () => {
  const monday = new Date(2026, 5, 15, 0, 0, 0, 0);
  const now = new Date(2026, 5, 17, 12, 0, 0, 0);
  const iso = time => new Date(time).toISOString();
  const items = [
    { id: 'waiting', added_at: older },
    { id: 'fallback-waiting', created_at: older },
    { id: 'kept-monday', added_at: older },
    { id: 'finished', added_at: older },
    { id: 'let-go-now', added_at: older },
    { id: 'before-monday', added_at: older },
    { id: 'future', added_at: older },
    { id: 'reading-untriaged', added_at: older },
    { id: 'new-arrival-triaged', added_at: boundary },
    { id: 'missing-date' },
  ];
  const state = {
    'kept-monday': { progress: 'new', triaged_at: monday.toISOString() },
    finished: { progress: 'finished', triaged_at: iso(monday.getTime() + 1) },
    'let-go-now': { progress: 'let_go', triaged_at: now.toISOString() },
    'before-monday': { progress: 'new', triaged_at: iso(monday.getTime() - 1) },
    future: { progress: 'new', triaged_at: iso(now.getTime() + 1) },
    'reading-untriaged': { progress: 'reading', triaged_at: null },
    'new-arrival-triaged': { progress: 'new', triaged_at: monday.toISOString() },
    'missing-date': { progress: 'finished', triaged_at: monday.toISOString() },
  };
  assert.deepEqual(pileThisWeek(items, state, boundary, now), { start: 5, current: 2 });
  assert.deepEqual(pileThisWeek(items, state, boundary, monday), { start: 3, current: 2 });
});

test('pile week rolls over at Monday rather than Sunday or a UTC boundary', () => {
  const monday = new Date(2026, 5, 15, 0, 0, 0, 0);
  const sunday = new Date(monday.getTime() - 1);
  const items = [
    { id: 'waiting', added_at: older },
    { id: 'sunday-first', added_at: older },
    { id: 'sunday-second', added_at: older },
    { id: 'monday', added_at: older },
  ];
  const state = {
    'sunday-first': { progress: 'finished', triaged_at: new Date(sunday.getTime() - 1).toISOString() },
    'sunday-second': { progress: 'let_go', triaged_at: sunday.toISOString() },
    monday: { progress: 'new', triaged_at: monday.toISOString() },
  };
  assert.deepEqual(pileThisWeek(items, state, boundary, sunday), { start: 3, current: 1 });
  assert.deepEqual(pileThisWeek(items, state, boundary, monday), { start: 2, current: 1 });
});

test('keepers use a strict sixty-day last-opened boundary independently of progress', () => {
  const now = new Date('2026-08-01T12:00:00.000Z');
  const cutoff = now.getTime() - 60 * 24 * 60 * 60 * 1000;
  const items = [
    { id: 'old-finished', progress: 'finished', starred: true, last_opened_at: new Date(cutoff - 1).toISOString() },
    { id: 'at-boundary', progress: 'new', starred: true, last_opened_at: new Date(cutoff).toISOString() },
    { id: 'recent', progress: 'new', starred: true, last_opened_at: new Date(cutoff + 1).toISOString() },
    { id: 'missing-reading', progress: 'reading', starred: true },
    { id: 'null-let-go', progress: 'let_go', starred: true, last_opened_at: null },
    { id: 'not-starred', progress: 'new', starred: false },
    { id: 'invalid-date', progress: 'new', starred: true, last_opened_at: 'invalid' },
  ];
  const before = structuredClone(items);
  assert.deepEqual(ids(libraryShelves(items, boundary, now).keepers), ['old-finished', 'missing-reading', 'null-let-go']);
  assert.deepEqual(items, before);
});

test('started, short and pile shelves use their independent state and time rules', () => {
  const items = [
    { id: 'reading', progress: 'reading', read_minutes: 3, added_at: older },
    { id: 'exact-ten', progress: 'new', read_minutes: 10, added_at: older },
    { id: 'over-ten', progress: 'new', read_minutes: 10.01, added_at: older },
    { id: 'word-fallback', progress: 'new', words: 2300, added_at: boundary },
    { id: 'long-fallback', progress: 'new', words: 2301, added_at: boundary },
    { id: 'kept-short', progress: 'new', read_minutes: 2, added_at: older, triaged_at: boundary },
    { id: 'finished-short', progress: 'finished', read_minutes: 2, added_at: older },
    { id: 'let-go-short', progress: 'let_go', read_minutes: 2, added_at: older },
  ];
  const shelves = libraryShelves(items, boundary, new Date('2026-06-17T12:00:00.000Z'));
  assert.deepEqual(ids(shelves.started), ['reading']);
  assert.deepEqual(ids(shelves.short), ['exact-ten', 'word-fallback', 'kept-short']);
  assert.deepEqual(ids(shelves.pile), ['exact-ten', 'over-ten']);
});
