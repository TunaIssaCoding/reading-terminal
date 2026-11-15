import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVault, unlockWithPassword, unlockWithPrf, addPasskeySlot, removeSlot,
  changePassword, validateVault, serialize, toBase64Url, fromBase64Url,
} from '../js/vault.js';
import { passkeysAvailable, registerPasskey, unlockPasskey } from '../js/passkey.js';
import { mergeVaultSlots } from '../js/vault-api.js';

const password = 'four fictional river words';
const replacement = 'five other fictional river words';
const payload = Object.freeze({ token: 'fictional-test-token', owner: 'example-owner', repo: 'reading-data', branch: 'main', site_repo: 'reading-terminal', site_branch: 'main' });
const prfOutput = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const prfSalt = new Uint8Array(32).fill(42);
const credentialId = toBase64Url(new Uint8Array(24).fill(7));
const passwordError = { message: 'That password did not unlock the library.' };
const unsupportedError = { message: 'This browser or passkey does not support unlocking with a passkey. Use your password on this device.' };
let created;
let withPasskey;
let passkey;
const clone = value => JSON.parse(JSON.stringify(value));

before(async () => {
  created = await createVault(payload, password);
  withPasskey = await addPasskeySlot(created.vault, created.dek, { credentialId, prfSalt, prfOutput, label: 'Test device' });
  passkey = withPasskey.slots.find(slot => slot.type === 'passkey');
});

test('password roundtrip restores the exact payload and data key through serialized JSON', async () => {
  const restored = JSON.parse(serialize(created.vault));
  assert.deepEqual(await unlockWithPassword(restored, password), { payload, dek: created.dek });
  assert.equal(serialize(restored).includes(payload.token), false);
  assert.equal(serialize(restored).includes(password), false);
});

test('PRF roundtrip restores the same payload and DEK without changing the input vault', async () => {
  assert.deepEqual(await unlockWithPrf(withPasskey, passkey.id, prfOutput), { payload, dek: created.dek });
  assert.deepEqual(created.vault.slots.map(slot => slot.type), ['password']);
  assert.deepEqual(withPasskey.payload, created.vault.payload);
  await assert.rejects(unlockWithPrf(withPasskey, passkey.id, new Uint8Array(32)), { message: 'This passkey did not unlock the library.' });
});

test('wrong password and tampered ciphertext have the same password failure', async () => {
  await assert.rejects(unlockWithPassword(created.vault, 'not the right password'), passwordError);
  for (const target of ['payload', 'wrap']) {
    const tampered = clone(created.vault);
    const ciphertext = target === 'payload' ? tampered.payload : tampered.slots[0].wrap;
    const data = fromBase64Url(ciphertext.ct);
    data[0] ^= 1;
    ciphertext.ct = toBase64Url(data);
    await assert.rejects(unlockWithPassword(tampered, password), passwordError);
  }
});

test('vault identity and password slot identity are bound by AAD', async () => {
  const movedVault = clone(created.vault);
  movedVault.vault_id = toBase64Url(new Uint8Array(16));
  await assert.rejects(unlockWithPassword(movedVault, password), passwordError);
  const movedSlot = clone(created.vault);
  movedSlot.slots[0].id = toBase64Url(new Uint8Array(16));
  await assert.rejects(unlockWithPassword(movedSlot, password), passwordError);
});

test('swapped PRF wraps fail even with identical PRF-derived keys', async () => {
  const two = await addPasskeySlot(withPasskey, created.dek, {
    credentialId: toBase64Url(new Uint8Array(24).fill(8)), prfSalt, prfOutput, label: 'Second device',
  });
  const slots = two.slots.filter(slot => slot.type === 'passkey');
  [slots[0].wrap, slots[1].wrap] = [slots[1].wrap, slots[0].wrap];
  await assert.rejects(unlockWithPrf(two, slots[0].id, prfOutput));
  await assert.rejects(unlockWithPrf(two, slots[1].id, prfOutput));
});

test('weak password KDFs are refused before an unlock can succeed', async () => {
  for (const iterations of [599999, 0, -1, 600000.5, '600000', 2 ** 32]) {
    const weak = clone(created.vault);
    weak.slots[0].iterations = iterations;
    assert.throws(() => validateVault(weak));
    await assert.rejects(unlockWithPassword(weak, password), passwordError);
  }
});

test('changing password preserves working passkeys and leaves the original vault intact', async () => {
  const original = serialize(withPasskey);
  const changed = await changePassword(withPasskey, created.dek, replacement);
  await assert.rejects(unlockWithPassword(changed, password), passwordError);
  assert.deepEqual(await unlockWithPassword(changed, replacement), { payload, dek: created.dek });
  assert.deepEqual(await unlockWithPrf(changed, passkey.id, prfOutput), { payload, dek: created.dek });
  assert.deepEqual(changed.slots.find(slot => slot.type === 'passkey'), passkey);
  assert.equal(serialize(withPasskey), original);
});

test('removing a passkey removes its unlock path but never the password backup', async () => {
  const removed = removeSlot(withPasskey, passkey.id);
  assert.deepEqual(removed.slots.map(slot => slot.type), ['password']);
  assert.deepEqual(await unlockWithPassword(removed, password), { payload, dek: created.dek });
  await assert.rejects(unlockWithPrf(removed, passkey.id, prfOutput));
  assert.throws(() => removeSlot(withPasskey, withPasskey.slots[0].id));
  assert.throws(() => removeSlot(withPasskey, 'missing-slot'));
  assert.deepEqual(await unlockWithPrf(withPasskey, passkey.id, prfOutput), { payload, dek: created.dek });
});

test('validation rejects malformed structures, duplicate slots, and invalid encodings', () => {
  const mutations = [
    vault => { vault.version = 2; },
    vault => { vault.payload.alg = 'AES-CBC'; },
    vault => { vault.payload.iv = toBase64Url(new Uint8Array(11)); },
    vault => { vault.slots[0].wrap.ct = toBase64Url(new Uint8Array(47)); },
    vault => { vault.slots[0].salt = toBase64Url(new Uint8Array(15)); },
    vault => { vault.vault_id += '='; },
    vault => { vault.slots = []; },
    vault => { vault.slots.push(clone(vault.slots[0])); },
    vault => { vault.slots[1].prf_salt = toBase64Url(new Uint8Array(31)); },
    vault => { vault.slots[1].hkdf_info = 'other-app'; },
    vault => { vault.updated_at = 'not a date'; },
    vault => { vault.slots[1].credential_id = ''; },
    vault => { vault.slots[1].label = ''; },
  ];
  for (const mutate of mutations) {
    const malformed = clone(withPasskey);
    mutate(malformed);
    assert.throws(() => validateVault(malformed));
    assert.throws(() => serialize(malformed));
  }
  assert.throws(() => validateVault(null));
  assert.throws(() => fromBase64Url('AB')); // Nonzero trailing pad bits are not canonical.
  assert.throws(() => fromBase64Url('AA=='));
  assert.throws(() => fromBase64Url('A'));
  assert.deepEqual(fromBase64Url('AA'), new Uint8Array([0]));
});

test('invalid payloads and key lengths cannot create or corrupt a vault', async () => {
  for (const invalidPayload of [null, { ...payload, token: '' }, { ...payload, branch: 1 }, { ...payload, extra: 'unexpected' }]) {
    await assert.rejects(createVault(invalidPayload, password));
  }
  await assert.rejects(createVault(payload, 'short'));
  await assert.rejects(changePassword(withPasskey, new Uint8Array(32), replacement));
  await assert.rejects(addPasskeySlot(created.vault, created.dek, { credentialId, prfSalt, prfOutput: new Uint8Array(31), label: 'Device' }));
  await assert.rejects(addPasskeySlot(withPasskey, created.dek, { credentialId, prfSalt, prfOutput, label: 'Duplicate' }));
});

test('authenticated but malformed decrypted payload is rejected with the same password error', async () => {
  const malformed = clone(created.vault);
  const key = await crypto.subtle.importKey('raw', created.dek, 'AES-GCM', false, ['encrypt']);
  const iv = new Uint8Array(12).fill(3);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(malformed.vault_id) }, key, new TextEncoder().encode('{"token":"invalid incomplete payload"}'));
  malformed.payload = { alg: 'AES-256-GCM', iv: toBase64Url(iv), ct: toBase64Url(new Uint8Array(ct)) };
  await assert.rejects(unlockWithPassword(malformed, password), passwordError);
});

function browserFixture(t, credentials, capabilities) {
  const values = {
    PublicKeyCredential: capabilities === undefined ? class {} : class { static async getClientCapabilities() { return capabilities(); } },
    navigator: { credentials }, location: { hostname: 'localhost' },
  };
  for (const [name, value] of Object.entries(values)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
  }
}
function credential(prf, id = credentialId) {
  return { rawId: fromBase64Url(id).buffer, getClientExtensionResults: () => ({ prf }) };
}

test('registration with a second PRF prompt produces a passkey that unlocks the vault', async t => {
  const states = [];
  browserFixture(t, {
    async create() { states.push('created'); return credential({ enabled: true }); },
    async get() { states.push('asserted'); return credential({ results: { first: prfOutput.buffer } }); },
  });
  const registration = await registerPasskey(message => {
    assert.match(message, /second passkey prompt/);
    states.push('notified');
  });
  const vault = await addPasskeySlot(created.vault, created.dek, { ...registration, label: 'Registered device' });
  assert.deepEqual(states, ['created', 'notified', 'asserted']);
  assert.deepEqual(await unlockPasskey(vault), { payload, dek: created.dek });
});

test('registration PRF unsupported and absent assertion outputs use the password fallback', async t => {
  let result;
  browserFixture(t, { async create() { return credential(result); }, async get() { return credential({}); } });
  for (result of [undefined, { enabled: false }, { enabled: true }, { enabled: true, results: { first: new Uint8Array(31).buffer } }]) {
    await assert.rejects(registerPasskey(), unsupportedError);
  }
  await assert.rejects(unlockPasskey(withPasskey), unsupportedError);
});

test('passkey requests distinguish invalid addresses from cancellation and unsupported PRF', async t => {
  let name;
  const reject = async () => { throw new DOMException('Browser credential failure', name); };
  browserFixture(t, { create: reject, get: reject });
  for (const [errorName, message] of [
    ['SecurityError', 'Passkeys are not available on this address.'],
    ['NotAllowedError', 'The passkey prompt was cancelled or timed out. Try again or use your password.'],
    ['AbortError', 'The passkey prompt was cancelled or timed out. Try again or use your password.'],
    ['NotSupportedError', unsupportedError.message],
    ['UnknownError', unsupportedError.message],
  ]) {
    name = errorName;
    await assert.rejects(registerPasskey(), { message });
    await assert.rejects(unlockPasskey(withPasskey), { message });
  }
});

test('unlock rejects an assertion from a credential outside the vault', async t => {
  browserFixture(t, { async get() { return credential({ results: { first: prfOutput.buffer } }, toBase64Url(new Uint8Array(24).fill(99))); } });
  await assert.rejects(unlockPasskey(withPasskey), unsupportedError);
});

test('passkey availability respects explicit PRF rejection but tolerates unavailable discovery', async t => {
  let mode = 'unsupported';
  browserFixture(t, {}, () => {
    if (mode === 'error') throw new Error('Discovery unavailable');
    return mode === 'unsupported' ? { 'extension:prf': false } : {};
  });
  assert.equal(await passkeysAvailable(withPasskey), false);
  mode = 'unknown';
  assert.equal(await passkeysAvailable(withPasskey), true);
  mode = 'error';
  assert.equal(await passkeysAvailable(withPasskey), true);
  assert.equal(await passkeysAvailable(created.vault), false);
});

test('concurrent additions survive a merge without resurrecting a remotely removed passkey', async () => {
  const changed = await addPasskeySlot(withPasskey, created.dek, {
    credentialId: toBase64Url(new Uint8Array(24).fill(18)), prfSalt, prfOutput, label: 'New local key',
  });
  const remote = removeSlot(withPasskey, passkey.id);
  const merged = mergeVaultSlots(withPasskey, changed, remote);
  const added = changed.slots.find(slot => slot.type === 'passkey' && slot.id !== passkey.id);
  assert.deepEqual(merged.slots.filter(slot => slot.type === 'passkey'), [added]);
  assert.deepEqual(await unlockWithPrf(merged, added.id, prfOutput), { payload, dek: created.dek });
  await assert.rejects(unlockWithPrf(merged, passkey.id, prfOutput));
});

test('passkey removal preserves a concurrent password change', async () => {
  const changed = removeSlot(withPasskey, passkey.id);
  const remote = await changePassword(withPasskey, created.dek, replacement);
  const merged = mergeVaultSlots(withPasskey, changed, remote);
  assert.deepEqual(await unlockWithPassword(merged, replacement), { payload, dek: created.dek });
  await assert.rejects(unlockWithPassword(merged, password), passwordError);
  assert.equal(merged.slots.some(slot => slot.id === passkey.id), false);
});

test('concurrent password changes and replacement vaults cannot be silently overwritten', async () => {
  const local = await changePassword(withPasskey, created.dek, replacement);
  const remote = await changePassword(withPasskey, created.dek, 'a different fictional password');
  assert.throws(() => mergeVaultSlots(withPasskey, local, remote), /password changed on another device/);
  const replacementVault = await createVault(payload, replacement);
  assert.throws(() => mergeVaultSlots(withPasskey, local, replacementVault.vault), /vault was replaced/);
});
