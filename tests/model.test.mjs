import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveState, migrateState, libraryFields, splitArrivals } from '../js/model.js';
import { mergeState, mergeMigratingState, mergeNotes } from '../js/store.js';

const time = '2026-06-15T12:00:00.000Z';
const earlier = '2026-05-01T08:00:00.000Z';
const later = '2026-06-16T12:00:00.000Z';

for (const [name, legacy, progress] of [
  ['unread', { status: 'unread' }, 'new'],
  ['read', { status: 'read' }, 'finished'],
  ['automatically commented unread', { status: 'commented', commented_from: 'unread' }, 'reading'],
  ['automatically commented read', { status: 'commented', commented_from: 'read' }, 'finished'],
  ['manually commented null', { status: 'commented', commented_from: null }, 'finished'],
  ['manually commented missing provenance', { status: 'commented' }, 'finished'],
  ['missing status', {}, 'new'],
  ['null status', { status: null }, 'new'],
]) {
  test(`migration maps ${name} without losing unrelated user fields`, () => {
    const input = { fictional: { ...legacy, starred: true, status_changed_at: earlier,
      status_updated_at: earlier, status_changed_at_updated_at: earlier,
      tuna: { collection: 'Fictional estuary' }, _timestamps: { status: earlier,
        status_changed_at: earlier, commented_from: earlier, tuna: earlier } } };
    const original = structuredClone(input);
    const { state, changed } = migrateState(input, [], time);
    assert.equal(changed, true);
    assert.equal(state.fictional.progress, progress);
    assert.equal(state.fictional.triaged_at, progress === 'new' ? null : time);
    assert.equal(state.fictional.position, 0);
    assert.equal(state.fictional.starred, true);
    assert.equal(state.fictional.progress_changed_at, earlier);
    assert.equal(state.fictional.last_opened_at, null);
    assert.deepEqual(state.fictional.tuna, input.fictional.tuna);
    assert.equal(state.fictional._timestamps.tuna, earlier);
    for (const field of ['status', 'status_changed_at', 'status_updated_at', 'status_changed_at_updated_at', 'commented_from']) {
      assert.equal(Object.hasOwn(state.fictional, field), false);
      assert.equal(Object.hasOwn(state.fictional._timestamps, field), false);
    }
    assert.deepEqual(input, original);
    assert.deepEqual(migrateState(state, [], later), { state, changed: false });
  });
}

test('library legacy state fills missing entries only during legacy cutover', () => {
  const library = [
    { id: 'first', slug: 'first', status: 'read', starred: true },
    { id: 'second', slug: 'second', status: 'commented', commented_from: 'unread', starred: true },
  ];
  const first = migrateState({ first: { status: 'unread', starred: false } }, library, time);
  assert.equal(first.state.first.progress, 'new');
  assert.equal(first.state.first.starred, false);
  assert.equal(first.state.second.progress, 'reading');
  assert.equal(first.state.second.starred, true);
  const grown = [...library, { id: 'arrival', slug: 'arrival', status: 'unread' }];
  assert.deepEqual(migrateState(first.state, grown, later), { state: first.state, changed: false });
  assert.equal(migrateState(null, library, time).state.first.progress, 'finished');
});

for (const starredCount of [0, 2]) {
  test(`migration keeps 1,000 unread records sparse with ${starredCount} starred defaults`, () => {
    const library = Array.from({ length: 1000 }, (_, index) => ({
      id: `fiction-${index}`, status: 'unread', ...(index % 2 ? { starred: false } : {}),
    }));
    for (let index = 0; index < starredCount; index++) library[998 + index].starred = true;
    const input = {
      'fiction-0': { status: 'unread', starred: false },
      'fiction-1': { status: 'read' },
      orphan: { status: 'commented', commented_from: 'unread', custom: { keep: true } },
    };
    const original = structuredClone({ input, library });
    const result = migrateState(input, library, time);
    assert.equal(result.changed, true);
    assert.deepEqual(Object.keys(result.state).sort(),
      ['fiction-0', 'fiction-1', 'orphan', ...library.filter(record => record.starred).map(record => record.id)].sort());
    assert.equal(Object.keys(result.state).length, 3 + starredCount);
    assert.equal(result.state.orphan.progress, 'reading');
    assert.deepEqual(result.state.orphan.custom, { keep: true });
    for (const record of library.slice(2)) {
      for (const state of [input, result.state]) {
        const current = effectiveState(record, state[record.id], time);
        assert.equal(current.progress, 'new');
        assert.equal(current.triaged_at, null);
        assert.equal(current.position, 0);
        assert.equal(current.starred, record.starred === true);
      }
    }
    assert.deepEqual(migrateState(result.state, library, later), { state: result.state, changed: false });
    assert.deepEqual({ input, library }, original);
  });
}

test('an untouched default-only library needs no migration or state write', () => {
  const library = [{ id: 'unread', status: 'unread' }, { id: 'missing' }, { id: 'null', status: null }];
  for (const input of [null, {}]) {
    const result = migrateState(input, library, time);
    assert.deepEqual(result, { state: {}, changed: false });
    assert.deepEqual(migrateState(result.state, library, later), result);
  }
});

test('absent entries retain library legacy defaults before and after an all-v2 load', () => {
  const library = [
    { id: 'read', status: 'read' },
    { id: 'automatic', status: 'commented', commented_from: 'unread', starred: true },
    { id: 'manual', status: 'commented' },
    { id: 'keeper', status: 'unread', starred: true },
  ];
  const state = { existing: { progress: 'new' } };
  const migrated = migrateState(state, library, time);
  assert.deepEqual(migrated, { state, changed: false });
  for (const source of [state, migrated.state]) {
    assert.deepEqual(library.map(record => effectiveState(record, source[record.id], time).progress),
      ['finished', 'reading', 'finished', 'new']);
    assert.deepEqual(library.map(record => effectiveState(record, source[record.id], time).starred),
      [false, true, false, true]);
    assert.equal(effectiveState(library[0], { progress: 'new', starred: false }, time).progress, 'new');
    assert.equal(effectiveState(library[1], { progress: 'let_go', starred: false }, time).starred, false);
  }
  const dated = library.map(record => ({ ...record, added_at: time }));
  assert.deepEqual(splitArrivals(dated, migrated.state, time).arrivals.map(record => record.id), ['keeper']);
});

test('manual state does not inherit automatic commented provenance from library metadata', () => {
  const library = [{ id: 'fiction', status: 'commented', commented_from: 'unread' }];
  const { state } = migrateState({ fiction: { status: 'commented', triaged_at: earlier } }, library, time);
  assert.equal(state.fiction.progress, 'finished');
  assert.equal(state.fiction.triaged_at, time);
});

test('existing v2 entries remain byte-shape equivalent even in a mixed migration', () => {
  const v2 = { progress: 'let_go', position: 0.42, triaged_at: earlier,
    starred: true, progress_changed_at: earlier, last_opened_at: earlier,
    future_tuna_field: ['preserve'], _timestamps: { progress: earlier } };
  const result = migrateState({ kept: v2, old: { status: 'read' } }, [], time);
  assert.deepEqual(result.state.kept, v2);
  assert.equal(result.state.old.progress, 'finished');
  assert.deepEqual(migrateState({ kept: v2 }, [], later), { state: { kept: v2 }, changed: false });
});

test('v2 migration removes legacy residue without changing progress or unrelated timestamps', () => {
  const input = { fiction: { progress: 'reading', position: 0.3, status: 'commented', commented_from: 'read',
    status_changed_at: earlier, _timestamps: { status: earlier, progress: later, tuna: earlier } } };
  const { state, changed } = migrateState(input, [], time);
  assert.equal(changed, true);
  assert.deepEqual(state.fiction, { progress: 'reading', position: 0.3, _timestamps: { progress: later, tuna: earlier } });
  assert.deepEqual(migrateState(state, [], later), { state, changed: false });
});

test('migration retry honors remote legacy edits and unknown fields changed after migration began', () => {
  const base = { fiction: { status: 'unread', starred: false, tuna: { shelf: 'before' }, removed_remote_field: 'old' } };
  const local = migrateState(base, [], time).state;
  const remote = { fiction: { status: 'read', starred: true, status_changed_at: later,
    tuna: { shelf: 'remote' }, remote_only: { keep: true } } };
  const merged = mergeMigratingState(local, remote, base, [], time).fiction;
  assert.equal(merged.progress, 'finished');
  assert.equal(merged.starred, true);
  assert.equal(merged.progress_changed_at, later);
  assert.deepEqual(merged.tuna, { shelf: 'remote' });
  assert.deepEqual(merged.remote_only, { keep: true });
  assert.equal(Object.hasOwn(merged, 'removed_remote_field'), false);
  assert.equal(Object.hasOwn(merged, 'status'), false);
});

test('migration retry preserves local edits while retaining newer independent remote v2 fields', () => {
  const base = { fiction: { status: 'unread', starred: false } };
  const local = migrateState(base, [], time).state;
  local.fiction.starred = true;
  local.fiction._timestamps.starred = later;
  const remote = migrateState(base, [], time).state;
  Object.assign(remote.fiction, { progress: 'reading', position: 0.35, triaged_at: later, progress_changed_at: later, tuna_new: 'retained' });
  Object.assign(remote.fiction._timestamps, { progress: later, position: later, triaged_at: later, progress_changed_at: later });
  const merged = mergeMigratingState(local, remote, base, [], time).fiction;
  assert.equal(merged.starred, true);
  assert.equal(merged.progress, 'reading');
  assert.equal(merged.position, 0.35);
  assert.equal(merged.triaged_at, later);
  assert.equal(merged.tuna_new, 'retained');
});

test('in-flight migration rebase keeps edits queued after the sent snapshot', () => {
  const snapshot = migrateState({ fiction: { status: 'read', starred: false } }, [], time).state;
  const sent = structuredClone(snapshot);
  sent.fiction.tuna = { remote: 'kept' };
  const current = structuredClone(snapshot);
  Object.assign(current.fiction, { progress: 'let_go', position: 0.7, starred: true, progress_changed_at: later, last_opened_at: later });
  for (const field of ['progress', 'position', 'starred', 'progress_changed_at', 'last_opened_at']) current.fiction._timestamps[field] = later;
  const merged = mergeState(current, sent, snapshot).fiction;
  assert.equal(merged.progress, 'let_go');
  assert.equal(merged.position, 0.7);
  assert.equal(merged.starred, true);
  assert.equal(merged.last_opened_at, later);
  assert.deepEqual(merged.tuna, { remote: 'kept' });
});

test('arrivals boundary is inclusive and excludes triaged or non-new items', () => {
  const items = [
    { id: 'older', created_at: '2026-06-15T11:59:59.999Z' },
    { id: 'boundary', added_at: time },
    { id: 'later', added_at: later },
    { id: 'triaged', added_at: later },
    { id: 'reading', added_at: later },
    { id: 'finished', added_at: later },
    { id: 'let-go', added_at: later },
    { id: 'unknown-date' },
  ];
  const state = { triaged: { progress: 'new', triaged_at: time }, reading: { progress: 'reading' },
    finished: { progress: 'finished' }, 'let-go': { progress: 'let_go' } };
  const result = splitArrivals(items, state, time);
  assert.deepEqual(result.arrivals.map(item => item.id), ['boundary', 'later']);
  assert.deepEqual(result.pile.map(item => item.id), ['older']);
  assert.deepEqual(splitArrivals(items, state, 'invalid'), { arrivals: [], pile: [] });
});

test('library fallbacks preserve explicit metadata and leave missing summaries absent', () => {
  const old = { created_at: earlier, words: 231, source_type: 'fictional-web', tuna: true };
  assert.deepEqual(libraryFields(old), { ...old, added_at: earlier, read_minutes: 2, source_label: 'fictional-web' });
  assert.equal(Object.hasOwn(libraryFields(old), 'summary'), false);
  assert.equal(Object.hasOwn(old, 'added_at'), false);
  const explicit = { ...old, added_at: later, read_minutes: 4, source_label: 'Fictional journal', summary: 'A supplied summary.' };
  assert.deepEqual(libraryFields(explicit), explicit);
  assert.equal(libraryFields({ words: 230 }).read_minutes, 1);
  assert.equal(libraryFields({}).read_minutes, 0);
});

test('independent kept and hidden connections merge by slug without dropping notes', () => {
  const base = { long_notes: 'Original fictional note', highlights: [], links: [{ slug: 'known', title: 'Known' }], hidden_links: [] };
  const local = { ...base, links: [...base.links, { slug: 'left', title: 'Left' }], hidden_links: ['hide-left'] };
  const remote = { ...base, long_notes: 'Remote fictional note', links: [...base.links, { slug: 'right', title: 'Right' }], hidden_links: ['hide-right'] };
  const merged = mergeNotes(local, remote, base);
  assert.deepEqual(merged.links.map(link => link.slug), ['known', 'left', 'right']);
  assert.deepEqual(merged.hidden_links, ['hide-left', 'hide-right']);
  assert.equal(merged.long_notes, 'Remote fictional note');
  assert.deepEqual(mergeNotes(remote, local, base), merged);
  assert.deepEqual(mergeNotes(merged, remote, base).links, merged.links);
});

test('Undo of a synced Hide removes only that slug, preserving a concurrent independent Hide', () => {
  const base = { long_notes: '', highlights: [], hidden_links: ['undo-me'] };
  const local = { ...base, hidden_links: [] };
  const remote = { ...base, hidden_links: ['undo-me', 'keep-hidden'] };
  assert.deepEqual(mergeNotes(local, remote, base).hidden_links, ['keep-hidden']);
  assert.deepEqual(mergeNotes(remote, local, base).hidden_links, ['keep-hidden']);
});
