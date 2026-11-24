import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadingStore, mergeQueue } from '../js/store.js';

const boundary = '2026-06-01T00:00:00.000Z';
const path = 'user/queue.json';
const queue = (ids, extra = {}) => ({ queue: ids, arrivals_since: boundary, ...extra });
const copy = value => structuredClone(value);

function replaceGlobal(t, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  });
}

function memoryStorage(t) {
  const journal = new Map();
  const records = { cache: new Map(), queue: new Map(), backups: new Map() };
  const request = result => {
    const value = { result: copy(result) };
    queueMicrotask(() => value.onsuccess?.());
    return value;
  };
  const db = {
    objectStoreNames: { contains: name => Object.hasOwn(records, name) },
    close() {},
    transaction() {
      const transaction = {
        objectStore(name) {
          const store = records[name];
          return {
            put(value) { store.set(value.key, copy(value)); },
            delete(key) { store.delete(key); },
            get(key) { return request(store.get(key)); },
            index() { return { getAll(namespace) { return request([...store.values()].filter(value => value.namespace === namespace)); } }; },
          };
        },
      };
      queueMicrotask(() => transaction.oncomplete?.());
      return transaction;
    },
  };
  replaceGlobal(t, 'indexedDB', { open() { const opened = {}; queueMicrotask(() => { opened.result = db; opened.onsuccess?.(); }); return opened; } });
  replaceGlobal(t, 'localStorage', {
    getItem: key => journal.get(key) || null,
    setItem: (key, value) => journal.set(key, value),
    removeItem: key => journal.delete(key),
  });
  if (!globalThis.CustomEvent) replaceGlobal(t, 'CustomEvent', class extends Event {
    constructor(type, options) { super(type); this.detail = options.detail; }
  });
  return { records, journal };
}

async function fixture(t, initial = queue(['a'])) {
  const storage = memoryStorage(t);
  const server = { content: copy(initial), sha: initial ? 'sha-1' : null, puts: [], beforePut: null, failure: null };
  const makeStore = async () => {
    const store = new ReadingStore({ owner: 'fiction', repo: 'reading', branch: 'main', token: 'fictional-token' });
    store._schedule = () => {};
    await store._ensureReady();
    store._initialized = true;
    store._checkRepository = async () => {};
    store._fetchRemote = async target => {
      assert.equal(target, path);
      return { content: copy(server.content), sha: server.sha };
    };
    store._request = async (url, options) => {
      assert.equal(options.method, 'PUT');
      const body = JSON.parse(options.body);
      if (server.beforePut) await server.beforePut(body);
      if (server.failure) throw Object.assign(new Error('Fictional repository temporarily unavailable.'), { status: server.failure });
      if ((body.sha || null) !== server.sha) throw Object.assign(new Error('Fictional SHA conflict.'), { status: 409 });
      server.content = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      server.puts.push({ content: copy(server.content), sha: body.sha || null });
      server.sha = `sha-${server.puts.length + 2}`;
      return { content: { sha: server.sha } };
    };
    t.after(() => store._stop());
    return store;
  };
  const store = await makeStore();
  store._putCache(path, copy(initial), server.sha);
  return { store, server, makeStore, ...storage };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('queue merge preserves remote ordering, appends local additions and applies local removals', () => {
  const base = queue(['a', 'b', 'c'], { annotation: { old: true } });
  const local = queue(['c', 'a', 'local'], { annotation: { old: true }, local_field: true });
  const remote = queue(['b', 'c', 'remote', 'a'], { annotation: { updated: true }, remote_field: true });
  const before = copy([local, remote, base]);
  assert.deepEqual(mergeQueue(local, remote, base), queue(['c', 'remote', 'a', 'local'], {
    annotation: { updated: true }, local_field: true, remote_field: true,
  }));
  assert.deepEqual([local, remote, base], before);
});

test('uncontested reorder wins, while a real concurrent reorder keeps remote order', () => {
  const base = queue(['a', 'b', 'c']);
  assert.deepEqual(mergeQueue(queue(['c', 'a', 'b']), base, base).queue, ['c', 'a', 'b']);
  assert.deepEqual(mergeQueue(queue(['c', 'a', 'b']), queue(['b', 'a', 'c']), base).queue, ['b', 'a', 'c']);
  assert.deepEqual(mergeQueue(queue(['c', 'a', 'b']), queue(['a', 'b', 'c'], { metadata: 'changed' }), base).queue, ['c', 'a', 'b']);
});

test('remote removals are not resurrected and independent creations retain the remote arrival boundary', () => {
  assert.deepEqual(mergeQueue(queue(['a', 'b', 'local']), queue(['b', 'remote']), queue(['a', 'b'])).queue, ['b', 'remote', 'local']);
  const remote = queue(['remote'], { arrivals_since: '2026-05-01T00:00:00.000Z' });
  assert.deepEqual(mergeQueue(queue(['local']), remote), { ...remote, queue: ['remote', 'local'] });
  assert.deepEqual(mergeQueue(queue(['local']), null), queue(['local']));
});

test('concurrent queue overflow keeps ten deterministically with remote priority', () => {
  const base = queue(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  const local = queue([...base.queue, 'local-first', 'local-tail']);
  const remote = queue([...base.queue, 'remote']);
  assert.deepEqual(mergeQueue(local, remote, base).queue, [...base.queue, 'remote', 'local-first']);
  assert.deepEqual(mergeQueue(local, queue([...base.queue, 'remote-1', 'remote-2']), base).queue,
    [...base.queue, 'remote-1', 'remote-2']);
});

test('queue boundaries reject malformed ids, dates and oversized input without mutating arguments', () => {
  for (const malformed of [null, [], {}, queue(['']), queue([4]), queue(['__proto__']), queue(new Array(1)),
    queue(['a'], { arrivals_since: 'invalid' }), queue(Array.from({ length: 11 }, (_, index) => `item-${index}`))]) {
    assert.throws(() => mergeQueue(malformed, queue([])), /Invalid reading queue|Up next is full/);
  }
  assert.throws(() => mergeQueue(queue([]), queue([null])), /Invalid reading queue/);
  assert.throws(() => mergeQueue(queue([]), queue([]), queue(['constructor'])), /Invalid reading queue/);
  assert.deepEqual(mergeQueue(queue(['a', 'a', 'b']), null).queue, ['a', 'b']);
});

test('eleventh local save changes neither visible queue, durable recovery, events nor pending work', async t => {
  const ids = Array.from({ length: 10 }, (_, index) => `item-${index}`);
  const { store, records, journal } = await fixture(t, queue(ids));
  await store.saveQueue(queue(ids));
  const before = copy({ cache: store._cache.get(path), pending: store._queue.get(path), records: [...records.queue], journal: [...journal] });
  const events = [];
  store.addEventListener('queue-updated', event => events.push(event.detail));
  assert.throws(() => store.saveQueue(queue([...ids, 'eleventh'])), { message: 'Up next is full. Finish or remove one first.' });
  assert.deepEqual({ cache: store._cache.get(path), pending: store._queue.get(path), records: [...records.queue], journal: [...journal] }, before);
  assert.deepEqual(events, []);
});

test('local queue save is durable, publishes an isolated snapshot and retains metadata and boundary', async t => {
  const { store, records, server } = await fixture(t, queue(['a'], { custom: { keep: true } }));
  let notified;
  store.addEventListener('queue-updated', event => { notified = copy(event.detail.queue); event.detail.queue.queue.push('listener-only'); });
  await store.saveQueue({ queue: ['b', 'a', 'b'], arrivals_since: '2026-11-01T00:00:00.000Z' });
  const expected = queue(['b', 'a'], { custom: { keep: true } });
  assert.deepEqual(notified, expected);
  assert.deepEqual(store._cache.get(path).content, expected);
  assert.deepEqual(records.queue.get(store._key(path)).content, expected);
  assert.equal(records.queue.get(store._key(path)).createOnly, false);
  assert.deepEqual(await store.flush(), { pending: 0 });
  assert.deepEqual(server.content, expected);
  assert.equal(server.puts[0].sha, 'sha-1');
  assert.equal(records.queue.size, 0);
});

test('saved queue survives recovery and a failed flush, then retries normally', async t => {
  const { store, makeStore, server, journal } = await fixture(t);
  await store.saveQueue({ queue: ['a', 'local'] });
  store._stop();
  const recovered = await makeStore();
  assert.deepEqual(recovered._cache.get(path).content.queue, ['a', 'local']);
  assert.equal(recovered._queue.get(path).createOnly, false);
  server.failure = 503;
  assert.deepEqual(await recovered.flush(), { pending: 1 });
  assert.deepEqual(server.content.queue, ['a']);
  assert.equal(journal.has(recovered._journalKey), true);
  server.failure = null;
  assert.deepEqual(await recovered.flush(), { pending: 0 });
  assert.deepEqual(server.content.queue, ['a', 'local']);
  assert.equal(journal.has(recovered._journalKey), false);
});

test('SHA conflict fetches a fresh queue and reapplies local additions and removals', async t => {
  const { store, server } = await fixture(t, queue(['a', 'b']));
  await store.saveQueue({ queue: ['b', 'local'] });
  server.beforePut = async () => {
    server.beforePut = null;
    server.content = queue(['remote', 'a', 'b']);
    server.sha = 'concurrent-sha';
  };
  assert.deepEqual(await store.flush(), { pending: 0 });
  assert.deepEqual(server.content.queue, ['remote', 'b', 'local']);
  assert.equal(server.puts[0].sha, 'concurrent-sha');
});

test('bounded SHA retries retain unsynced edits for a later successful flush', async t => {
  const { store, server } = await fixture(t);
  await store.saveQueue({ queue: ['a', 'local'] });
  let attempts = 0;
  server.beforePut = async () => { server.sha = `conflict-${++attempts}`; };
  assert.deepEqual(await store.flush(), { pending: 1 });
  assert.equal(attempts, 4);
  assert.deepEqual(store._cache.get(path).content.queue, ['a', 'local']);
  server.beforePut = null;
  assert.deepEqual(await store.flush(), { pending: 0 });
  assert.deepEqual(server.content.queue, ['a', 'local']);
});

test('refresh retains actual local edits and emits the merged queue before flush', async t => {
  const { store, server } = await fixture(t, queue(['a', 'b']));
  await store.saveQueue({ queue: ['b', 'local'] });
  server.content = queue(['remote', 'a', 'b'], { note: 'remote metadata' });
  server.sha = 'remote-refresh';
  const events = [];
  store.addEventListener('queue-updated', event => events.push(event.detail.queue));
  assert.deepEqual(await store._refresh(path, null), queue(['remote', 'b', 'local'], { note: 'remote metadata' }));
  assert.equal(store._queue.has(path), true);
  assert.deepEqual(events, [queue(['remote', 'b', 'local'], { note: 'remote metadata' })]);
  await store.flush();
  assert.deepEqual(server.content.queue, ['remote', 'b', 'local']);
});

test('edits during an in-flight PUT are rebased and flushed without losing either device additions', async t => {
  const { store, server } = await fixture(t, queue(['a', 'b']));
  await store.saveQueue({ queue: ['a', 'b', 'first-local'] });
  server.content = queue(['a', 'b', 'remote']);
  server.sha = 'remote-before-put';
  const started = deferred();
  const release = deferred();
  server.beforePut = async () => { server.beforePut = null; started.resolve(); await release.promise; };
  const flushing = store.flush();
  await started.promise;
  await store.saveQueue({ queue: ['b', 'later-local'] });
  release.resolve();
  assert.deepEqual(await flushing, { pending: 0 });
  assert.deepEqual(server.content.queue, ['b', 'remote', 'later-local']);
  assert.deepEqual(store._cache.get(path).content, server.content);
  assert.deepEqual(server.puts.map(entry => entry.content.queue), [['a', 'b', 'remote', 'first-local'], ['b', 'remote', 'later-local']]);
});

for (const legacy of [false, true]) test(`${legacy ? 'legacy recovered' : 'explicit'} create-only intent never overwrites an existing remote queue`, async t => {
  const { store, server, makeStore, journal, records } = await fixture(t, null);
  const fetch = store._fetchRemote;
  store._initialized = false;
  store._now = () => boundary;
  store._fetchRemote = async target => target === path ? fetch(target)
    : { content: target === 'library.json' ? [] : {}, sha: 'fictional-initial-state' };
  await store.init();
  store._fetchRemote = fetch;
  if (legacy) {
    const entry = copy(store._queue.get(path));
    delete entry.createOnly;
    journal.set(store._journalKey, JSON.stringify([entry]));
    records.queue.clear();
  }
  store._stop();
  const recovered = await makeStore();
  server.content = queue(['remote'], { arrivals_since: '2026-05-01T00:00:00.000Z', custom: true });
  server.sha = 'existing-queue';
  assert.equal(recovered._queue.get(path).createOnly, true);
  assert.deepEqual(await recovered.flush(), { pending: 0 });
  assert.deepEqual(server.puts, []);
  assert.deepEqual(recovered._cache.get(path).content, server.content);
});

test('a real save upgrades pending create-only intent, including a save during its remote lookup', async t => {
  const { store, server } = await fixture(t, null);
  await store._queueEdit(path, queue([]), { createOnly: true });
  server.content = queue(['remote']);
  server.sha = 'existing-queue';
  const started = deferred();
  const release = deferred();
  const fetch = store._fetchRemote;
  store._fetchRemote = async target => { store._fetchRemote = fetch; started.resolve(); await release.promise; return fetch(target); };
  const flushing = store.flush();
  await started.promise;
  await store.saveQueue({ queue: ['local'] });
  release.resolve();
  assert.deepEqual(await flushing, { pending: 0 });
  assert.deepEqual(server.content.queue, ['remote', 'local']);
});

test('an uncontested reorder made during PUT survives the subsequent flush', async t => {
  const { store, server } = await fixture(t, queue(['a', 'b']));
  await store.saveQueue({ queue: ['a', 'b', 'c'] });
  const started = deferred();
  const release = deferred();
  server.beforePut = async () => { server.beforePut = null; started.resolve(); await release.promise; };
  const flushing = store.flush();
  await started.promise;
  await store.saveQueue({ queue: ['c', 'b', 'a'] });
  release.resolve();
  assert.deepEqual(await flushing, { pending: 0 });
  assert.deepEqual(server.content.queue, ['c', 'b', 'a']);
});

test('a local save during refresh is merged rather than discarded as migration creation', async t => {
  const { store, server } = await fixture(t, queue(['a']));
  const started = deferred();
  const release = deferred();
  const fetch = store._fetchRemote;
  store._fetchRemote = async target => { store._fetchRemote = fetch; started.resolve(); await release.promise; return fetch(target); };
  const refreshing = store._refresh(path, null);
  await started.promise;
  await store.saveQueue({ queue: ['a', 'local'] });
  server.content = queue(['a', 'remote']);
  server.sha = 'refreshed-sha';
  release.resolve();
  assert.deepEqual((await refreshing).queue, ['a', 'remote', 'local']);
  assert.equal(store._queue.has(path), true);
  await store.flush();
  assert.deepEqual(server.content.queue, ['a', 'remote', 'local']);
});

test('refresh accepts an existing remote queue without treating migration creation as an edit', async t => {
  const { store, server } = await fixture(t, null);
  await store._queueEdit(path, queue([]), { createOnly: true });
  server.content = queue(['remote'], { arrivals_since: '2026-05-01T00:00:00.000Z' });
  server.sha = 'existing-queue';
  assert.deepEqual(await store._refresh(path, null), server.content);
  assert.equal(store._queue.has(path), false);
  assert.deepEqual(await store.flush(), { pending: 0 });
  assert.deepEqual(server.puts, []);
});
