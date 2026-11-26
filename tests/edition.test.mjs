import test from 'node:test';
import assert from 'node:assert/strict';
import { localDate, parseEdition, editionMinutes, editionDone, findMargin, setStillAgree, undoStillAgree } from '../js/edition.js';
import { effectiveState, libraryFields } from '../js/model.js';
import { ReadingStore, mergeNotes } from '../js/store.js';
import { demoEdition, demoLibrary, demoNotes, demoState } from '../js/demo.js';

const date = '2026-11-20';
const time = `${date}T08:24:00.000Z`;
const later = `${date}T09:00:00.000Z`;
const library = [
  { id: 'long', slug: 'long', title: 'Fictional long read', read_minutes: 14, progress: 'reading' },
  { id: 'short', slug: 'short', title: 'Fictional short read', words: 231, progress: 'new' },
  { id: 'archive', slug: 'archive', title: 'Fictional archive', progress: 'new' },
  { id: 'arrival', slug: 'arrival', title: 'Fictional arrival', progress: 'new' },
];
const edition = () => ({ date, generated_at: time, bot: 'Fictional reading bot', picks: [
  { slot: 'archive', slug: 'archive', why: 'Saved in March.' },
  { slot: 'short', slug: 'short', why: 'Two minutes on maps.' },
  { slot: 'long', slug: 'long', why: 'Continue your reading at 20%.' },
], margin: { slug: 'archive', highlight_id: 'h1', why: 'You noted this in May.' }, arrivals: ['arrival'] });
const notes = () => ({ long_notes: 'A fictional note.', links: [], hidden_links: [], updated_at: time,
  highlights: [{ id: 'h1', quote: 'A question beside its evidence.', note: 'Keep the reason.', para: 2,
    prefix: 'before', suffix: 'after', start: 7, created_at: time, updated_at: time }] });
const copy = value => structuredClone(value);

test('edition parsing orders slots and preserves attribution, explanations and margin identity', () => {
  const input = edition();
  const before = copy(input);
  const warnings = [];
  const parsed = parseEdition(JSON.stringify(input), library, date, warning => warnings.push(warning));
  assert.deepEqual(parsed, { ...input, picks: [input.picks[2], input.picks[1], input.picks[0]] });
  assert.deepEqual(input, before);
  assert.deepEqual(warnings, []);
});

test('missing optional fields use safe defaults while a missing pick list remains a partial edition', () => {
  const warnings = [];
  const parse = input => parseEdition(input, library, date, warning => warnings.push(warning));
  assert.deepEqual(parse({ picks: [{ slot: 'short', slug: 'short', why: 'Maps.' }] }), {
    date, generated_at: '', bot: 'Reading bot', picks: [{ slot: 'short', slug: 'short', why: 'Maps.' }], margin: null, arrivals: [],
  });
  assert.deepEqual(warnings, []);
  assert.deepEqual(parse({}), { date, generated_at: '', bot: 'Reading bot', picks: [], margin: null, arrivals: [] });
  assert.equal(warnings.length, 1);
});

test('unknown slugs, missing why and duplicate sections are skipped with one warning', () => {
  const input = edition();
  input.picks.push({ slot: 'long', slug: 'unknown', why: 'Missing article.' },
    { slot: 'short', slug: 'arrival' }, input.picks[0], { slot: 'other', slug: 'arrival', why: 'Wrong slot.' });
  input.margin.slug = 'unknown';
  input.arrivals.push('arrival', 'unknown', null);
  const warnings = [];
  const parsed = parseEdition(input, library, date, warning => warnings.push(warning));
  assert.deepEqual(parsed.picks.map(pick => pick.slug), ['long', 'short', 'archive']);
  assert.equal(parsed.margin, null);
  assert.deepEqual(parsed.arrivals, ['arrival']);
  assert.equal(warnings.length, 1);
});

test('malformed independent sections do not discard a valid pick or repeatedly warn on normalized data', () => {
  const warnings = [];
  const parse = input => parseEdition(input, library, date, warning => warnings.push(warning));
  const partial = parse({ date, generated_at: 5, bot: {}, picks: [null, { slot: 'short', slug: 'short', why: 'Maps.' }],
    margin: { slug: 'archive', highlight_id: 'h1' }, arrivals: {} });
  assert.deepEqual(partial, { date, generated_at: '', bot: 'Reading bot', picks: [{ slot: 'short', slug: 'short', why: 'Maps.' }], margin: null, arrivals: [] });
  assert.equal(warnings.length, 1);
  assert.deepEqual(parse(partial), partial);
  assert.equal(warnings.length, 1);
});

test('bad JSON, non-object editions, invalid dates and mismatched dates are unavailable', () => {
  for (const input of ['{broken', 'null', '[]', 12, false, null, [], { date: '2026-11-19' }]) {
    const warnings = [];
    assert.equal(parseEdition(input, library, date, warning => warnings.push(warning)), null);
    assert.equal(warnings.length, 1);
  }
  assert.equal(parseEdition({ picks: [] }, library, '2026-02-30', () => {}), null);
});

test('the edition filename date follows device time on both sides of UTC midnight', t => {
  const previous = process.env.TZ;
  t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
  process.env.TZ = 'America/Los_Angeles';
  assert.equal(localDate(new Date('2026-11-20T01:00:00Z')), '2026-11-19');
  process.env.TZ = 'Asia/Tokyo';
  assert.equal(localDate(new Date('2026-11-20T20:00:00Z')), '2026-11-21');
  assert.equal(localDate(new Date(2026, 0, 2, 12)), '2026-01-02');
});

test('total minutes uses explicit minutes, word-count rounding and the missing-metadata fallback', () => {
  const parsed = parseEdition(edition(), library, date);
  assert.equal(editionMinutes(parsed, library), 16);
  assert.equal(editionMinutes(parsed, library.filter(item => item.slug !== 'long')), 2);
  assert.equal(editionMinutes(null, library), 0);
});

test('done requires every valid pick to be finished or let go, never zero picks', () => {
  const parsed = parseEdition(edition(), library, date);
  assert.equal(editionDone(parsed, library), false);
  const finished = library.map(item => ({ ...item, progress: item.slug === 'short' ? 'let_go' : 'finished' }));
  assert.equal(editionDone(parsed, finished), true);
  assert.equal(editionDone(parsed, finished.filter(item => item.slug !== 'long')), false);
  assert.equal(editionDone({ picks: [] }, finished), false);
  assert.equal(editionDone(null, finished), false);
});

test('margin lookup uses the highlight id and hides missing or removed highlights', () => {
  const parsed = parseEdition(edition(), library, date);
  const source = notes();
  assert.equal(findMargin(parsed, source), source.highlights[0]);
  assert.equal(findMargin(parsed, { highlights: [] }), null);
  assert.equal(findMargin(parsed, null), null);
  assert.equal(findMargin({ margin: null }, source), null);
  assert.equal(findMargin(parsed, { highlights: {} }), null);
  assert.equal(findMargin(parsed, { highlights: [{ ...source.highlights[0], deleted: true }] }), null);
  assert.equal(findMargin(parsed, { ...source, deleted_highlights: { h1: later } }), null);
  assert.equal(findMargin(parsed, { ...source, deleted_highlights: { h1: '2026-01-01' } }), source.highlights[0]);
});

test('agreement and Undo only own the selected highlight agreement field', () => {
  const before = notes();
  before.highlights.push({ ...before.highlights[0], id: 'other' });
  const original = copy(before);
  const after = setStillAgree(before, 'h1', date);
  assert.equal(after.highlights[0].still_agree_at, date);
  assert.equal(after.highlights[1].still_agree_at, undefined);
  assert.deepEqual(before, original);
  const concurrent = copy(after);
  concurrent.long_notes = 'A later thought.';
  Object.assign(concurrent.highlights[0], { note: 'A revised reason.', start: 18, updated_at: later });
  const undone = undoStillAgree(concurrent, before, after, 'h1');
  assert.equal(undone.highlights[0].still_agree_at, undefined);
  assert.equal(undone.highlights[0].note, 'A revised reason.');
  assert.equal(undone.highlights[0].start, 18);
  assert.equal(undone.highlights[0].updated_at, later);
  assert.equal(undone.long_notes, 'A later thought.');
  const newer = setStillAgree(concurrent, 'h1', '2026-11-21');
  assert.deepEqual(undoStillAgree(newer, before, after, 'h1'), newer);
  assert.deepEqual(undoStillAgree({ ...concurrent, highlights: [] }, before, after, 'h1').highlights, []);
});

test('agreement Undo restores a prior date instead of clearing it', () => {
  const before = setStillAgree(notes(), 'h1', '2026-11-01');
  const after = setStillAgree(before, 'h1', date);
  assert.equal(undoStillAgree(after, before, after, 'h1').highlights[0].still_agree_at, '2026-11-01');
});

test('agreement sync and Undo preserve a concurrent highlight note and anchor', () => {
  const base = notes();
  const local = setStillAgree(base, 'h1', date);
  local.highlights[0].updated_at = later;
  const remote = copy(base);
  Object.assign(remote.highlights[0], { note: 'Other device note.', start: 15, updated_at: `${date}T08:30:00Z` });
  const merged = mergeNotes(local, remote, base);
  assert.equal(merged.highlights[0].still_agree_at, date);
  assert.equal(merged.highlights[0].note, 'Other device note.');
  assert.equal(merged.highlights[0].start, 15);
  assert.deepEqual(mergeNotes(remote, local, base), merged);
  const undo = undoStillAgree(merged, base, local, 'h1');
  undo.highlights[0].updated_at = `${date}T10:00:00Z`;
  const editedAgain = copy(merged);
  Object.assign(editedAgain.highlights[0], { note: 'Another independent revision.', updated_at: `${date}T09:30:00Z` });
  const result = mergeNotes(undo, editedAgain, merged);
  assert.equal(result.highlights[0].still_agree_at, undefined);
  assert.equal(result.highlights[0].note, 'Another independent revision.');
});

test('demo slots use eligible unfinished records, an existing annotated margin and untriaged arrivals', () => {
  const fixture = demoEdition(new Date(2026, 10, 24, 8, 24));
  const parsed = parseEdition(fixture, demoLibrary, '2026-11-24');
  const picks = parsed.picks.map(pick => demoLibrary.find(item => item.slug === pick.slug));
  assert.ok(libraryFields(picks[0]).read_minutes >= 12 && libraryFields(picks[0]).read_minutes <= 25);
  assert.ok(libraryFields(picks[1]).read_minutes <= 6);
  assert.ok(Date.parse(libraryFields(picks[2]).added_at) < Date.parse('2026-11-24') - 60 * 86400000);
  assert.equal(effectiveState(picks[2], demoState[picks[2].id]).progress, 'new');
  assert.ok(picks.every(item => !['finished', 'let_go'].includes(effectiveState(item, demoState[item.id]).progress)));
  assert.equal(findMargin(parsed, demoNotes[parsed.margin.slug]).id, 'demo-highlight-question');
  assert.ok(parsed.arrivals.every(slug => !effectiveState(demoLibrary.find(item => item.slug === slug), demoState[slug]).triaged_at));
});

function replaceGlobal(t, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  });
}

function memoryStorage(t) {
  const records = { cache: new Map(), queue: new Map(), backups: new Map() };
  const journal = new Map();
  const request = result => {
    const value = { result: copy(result) };
    queueMicrotask(() => value.onsuccess?.());
    return value;
  };
  const db = {
    objectStoreNames: { contains: name => Object.hasOwn(records, name) }, close() {},
    transaction() {
      const transaction = {
        objectStore(name) {
          const store = records[name];
          return {
            put(value) { store.set(value.key, copy(value)); }, delete(key) { store.delete(key); },
            get(key) { return request(store.get(key)); },
            index() { return {
              getAll(namespace) { return request([...store.values()].filter(value => value.namespace === namespace)); },
              openCursor() { return request(null); },
            }; },
          };
        },
      };
      queueMicrotask(() => transaction.oncomplete?.());
      return transaction;
    },
  };
  replaceGlobal(t, 'indexedDB', { open() { const opened = {}; queueMicrotask(() => { opened.result = db; opened.onsuccess?.(); }); return opened; } });
  replaceGlobal(t, 'localStorage', {
    getItem: key => journal.get(key) || null, setItem: (key, value) => journal.set(key, value), removeItem: key => journal.delete(key),
  });
  if (!globalThis.CustomEvent) replaceGlobal(t, 'CustomEvent', class extends Event {
    constructor(type, options) { super(type); this.detail = options.detail; }
  });
  return records;
}

async function storeFixture(t, initialEdition = undefined) {
  const records = memoryStorage(t);
  const files = new Map();
  const calls = [];
  const events = [];
  let revision = 0;
  const server = {
    files, calls, offline: false,
    set(path, value, raw = false) { files.set(path, { text: raw ? value : JSON.stringify(value), sha: `fiction-${++revision}` }); },
    get(path) { return JSON.parse(files.get(path).text); },
  };
  server.set('library.json', library);
  server.set('user/state.json', {});
  server.set('user/queue.json', { queue: [], arrivals_since: time });
  server.set('bot/meta.json', {});
  if (initialEdition !== undefined) server.set(`bot/editions/${date}.json`, initialEdition);
  replaceGlobal(t, 'fetch', async (url, options = {}) => {
    if (server.offline) throw new TypeError('Fictional offline connection.');
    const target = decodeURIComponent(new URL(url).pathname.split('/contents/')[1] || 'repository');
    const method = options.method || 'GET';
    calls.push({ target, method });
    if (target === 'repository') return Response.json({ private: true });
    if (method === 'PUT') {
      assert.match(target, /^user\/(state\.json|queue\.json|notes\/[^/]+\.json)$/);
      const body = JSON.parse(options.body);
      if ((body.sha || null) !== (files.get(target)?.sha || null)) return new Response('', { status: 409 });
      server.set(target, Buffer.from(body.content, 'base64').toString('utf8'), true);
      return Response.json({ content: { sha: files.get(target).sha } });
    }
    const file = files.get(target);
    return file ? Response.json({ type: 'file', encoding: 'base64', content: Buffer.from(file.text).toString('base64'), sha: file.sha })
      : new Response('', { status: 404 });
  });
  const makeStore = async () => {
    const store = new ReadingStore({ owner: 'fiction', repo: 'reading', branch: 'main', token: 'fictional-token' });
    store._schedule = () => {};
    store.addEventListener('change', event => events.push(event.detail));
    t.after(() => store._stop());
    await store.init();
    return store;
  };
  const store = await makeStore();
  return { store, server, records, events, makeStore };
}

test('real editions fetch lazily, cache independently and refresh without any bot writes', async t => {
  const { store, server, records, makeStore } = await storeFixture(t, edition());
  const path = `bot/editions/${date}.json`;
  assert.equal(server.calls.some(call => call.target === path), false);
  const fetched = await store.getEdition(date);
  assert.equal(fetched.bot, 'Fictional reading bot');
  fetched.picks[0].why = 'Caller-only edit';
  assert.equal((await store.getEdition(date)).picks[0].why, 'Continue your reading at 20%.');
  assert.equal(server.calls.filter(call => call.target === path).length, 1);
  assert.equal(records.cache.get(store._key(path)).content.bot, 'Fictional reading bot');
  const restored = await makeStore();
  assert.equal((await restored.getEdition(date)).bot, 'Fictional reading bot');
  assert.equal(server.calls.filter(call => call.target === path).length, 1);
  server.set(path, { ...edition(), bot: 'Updated fictional writer' });
  assert.equal((await store.getEdition(date, { refresh: true })).bot, 'Updated fictional writer');
  assert.equal(server.calls.some(call => call.method === 'PUT'), false);
  server.offline = true;
  assert.equal((await store.getEdition(date, { refresh: true })).bot, 'Updated fictional writer');
});

test('404 editions are quiet and refresh can discover a later publication', async t => {
  const { store, server, events } = await storeFixture(t);
  assert.equal(await store.getEdition(date), null);
  assert.equal(events.some(event => event.status === 'error'), false);
  server.set(`bot/editions/${date}.json`, edition());
  assert.equal(await store.getEdition(date), null);
  assert.equal((await store.getEdition(date, { refresh: true })).date, date);
});

test('real malformed JSON and invalid sections warn once per fetch without an error status', async t => {
  const { store, server, events } = await storeFixture(t);
  const warnings = [];
  const original = console.warn;
  console.warn = message => warnings.push(message);
  t.after(() => { console.warn = original; });
  const path = `bot/editions/${date}.json`;
  server.set(path, '{broken', true);
  assert.equal(await store.getEdition(date), null);
  assert.equal(warnings.length, 1);
  assert.equal(await store.getEdition(date), null);
  assert.equal(warnings.length, 1);
  server.set(path, { picks: [{ slot: 'short', slug: 'short', why: 'Maps.' }, { slot: 'long', slug: 'unknown' }], generated_at: 'invalid' });
  const partial = await store.getEdition(date, { refresh: true });
  assert.deepEqual(partial.picks, [{ slot: 'short', slug: 'short', why: 'Maps.' }]);
  assert.equal(warnings.length, 2);
  assert.equal((await store.getEdition(date)).generated_at, '');
  assert.equal(warnings.length, 2);
  assert.equal(events.some(event => event.status === 'error'), false);
});

test('agreement persists to notes and Undo survives sync alongside an independent remote note edit', async t => {
  const { store, server } = await storeFixture(t);
  const path = 'user/notes/archive.json';
  server.set(path, notes());
  const before = await store.getNotes('archive');
  const after = setStillAgree(before, 'h1', date);
  await store.saveNotes('archive', after);
  assert.deepEqual(await store.flush(), { pending: 0 });
  assert.equal(server.get(path).highlights[0].still_agree_at, date);
  const current = copy(store._cache.get(path).content);
  const concurrent = server.get(path);
  concurrent.highlights[0].note = 'A concurrent remote revision.';
  concurrent.highlights[0].updated_at = '2099-01-01T00:00:00Z';
  server.set(path, concurrent);
  await store.saveNotes('archive', undoStillAgree(current, before, after, 'h1'));
  assert.deepEqual(await store.flush(), { pending: 0 });
  const saved = server.get(path).highlights[0];
  assert.equal(saved.still_agree_at, undefined);
  assert.equal(saved.note, 'A concurrent remote revision.');
  assert.equal(saved.start, 7);
  assert.ok(server.calls.filter(call => call.method === 'PUT').every(call => call.target === path));
});

test('removing and restoring a kept link persist without losing concurrent links or hidden decisions', async t => {
  const { store, server } = await storeFixture(t);
  const path = 'user/notes/archive.json';
  const base = { ...notes(), links: [{ slug: 'short', title: 'Short' }], hidden_links: ['hidden-before'] };
  server.set(path, base);
  const before = await store.getNotes('archive');
  await store.saveNotes('archive', { ...before, links: [] });
  server.set(path, { ...base, links: [...base.links, { slug: 'long', title: 'Remote long' }], hidden_links: ['hidden-before', 'remote-hidden'] });
  assert.deepEqual(await store.flush(), { pending: 0 });
  assert.deepEqual(server.get(path).links, [{ slug: 'long', title: 'Remote long' }]);
  assert.deepEqual(server.get(path).hidden_links, ['hidden-before', 'remote-hidden']);
  const current = copy(store._cache.get(path).content);
  await store.saveNotes('archive', { ...current, links: [...current.links, ...before.links] });
  const remote = server.get(path);
  remote.links.push({ slug: 'arrival', title: 'Another remote link' });
  server.set(path, remote);
  assert.deepEqual(await store.flush(), { pending: 0 });
  assert.deepEqual(server.get(path).links.map(link => link.slug), ['arrival', 'long', 'short']);
  assert.deepEqual(server.get(path).hidden_links, ['hidden-before', 'remote-hidden']);
});

test('returning demo injects today’s edition without resetting user notes, queue or state', async t => {
  const records = memoryStorage(t);
  const first = new ReadingStore({ token: '' });
  first._schedule = () => {};
  t.after(() => first._stop());
  await first.init();
  await first.saveNotes('the-space-between-observations', { ...demoNotes['the-space-between-observations'], long_notes: 'My returning demo note.' });
  await first.saveState({ 'demo-library': { progress: 'let_go' } });
  await first.saveQueue({ queue: [] });
  await first.flush();
  const path = `bot/editions/${localDate()}.json`;
  records.cache.delete(first._key(path));
  const returning = new ReadingStore({ token: '' });
  returning._schedule = () => {};
  t.after(() => returning._stop());
  const loaded = await returning.init();
  assert.equal((await returning.getEdition()).date, localDate());
  assert.equal((await returning.getNotes('the-space-between-observations')).long_notes, 'My returning demo note.');
  assert.equal(loaded.state['demo-library'].progress, 'let_go');
  assert.deepEqual(loaded.queue.queue, []);
});
