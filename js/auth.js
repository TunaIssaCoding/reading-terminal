import { createVault, unlockWithPassword, addPasskeySlot, removeSlot, changePassword } from './vault.js';
import { passkeysAvailable, registerPasskey, unlockPasskey, defaultPasskeyLabel } from './passkey.js';
import { saveRemembered, loadRemembered, deleteRemembered } from './session.js';
import { fetchPublicVault, publishVault, commitVault } from './vault-api.js';
import { getSettings, saveSettings, checkPrivateRepository } from './store.js';

const $ = selector => document.querySelector(selector);
const PASSWORD_ERROR = 'That password did not unlock the library.';
const SAVED = 'Vault saved. GitHub Pages may take a minute to publish it; this device is already unlocked.';

function strength(password) {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].filter(pattern => pattern.test(password)).length;
  let score = password.length * (classes + 1);
  if (/(password|qwerty|letmein|1234|abcd)/i.test(password)) score *= .35;
  if (/(.)\1{2,}/.test(password) || /^(.{1,6})\1+$/.test(password)) score *= .35;
  if (new Set(password).size < 6) score *= .5;
  return password.length < 12 || score < 35 ? 'Weak' : score < 55 ? 'Fair' : score < 85 ? 'Strong' : 'Very strong';
}
function passwordRules(password, confirm) {
  if (password.length < 12) throw new Error('Use a password of at least 12 characters. Try 4 or 5 random words.');
  if (password !== confirm) throw new Error('The passwords do not match.');
}
function clearInputs(...ids) { for (const id of ids) $(id).value = ''; }

export class VaultAccess {
  constructor({ connect, disconnect, notify }) {
    this.connect = connect; this.disconnect = disconnect; this.notify = notify;
    this.session = null; this.vault = null; this.remember = false; this.busy = false; this.generation = 0;
    this.pendingRemovals = new Map();
    $('#unlock-form').addEventListener('submit', event => { event.preventDefault(); void this.unlock(false); });
    $('#unlock-passkey').addEventListener('click', () => { void this.unlock(true); });
    $('#unlock-retry').addEventListener('click', () => { void this.start(); });
    $('#setup-form').addEventListener('submit', event => { event.preventDefault(); void this.setup(); });
    $('#lock-button').addEventListener('click', () => { void this.lock(); });
    $('#add-passkey').addEventListener('click', () => { void this.addPasskey(); });
    $('#change-password').addEventListener('submit', event => { event.preventDefault(); void this.changePassword(); });
    for (const [input, hint] of [['#setup-password', '#setup-strength'], ['#new-password', '#password-strength']]) {
      $(input).addEventListener('input', () => { $(hint).textContent = `${strength($(input).value)} · Use 4 or 5 random words.`; });
    }
    document.querySelectorAll('[data-demo]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); void this.demo(); }));
    document.querySelectorAll('[data-auth-back]').forEach(link => link.addEventListener('click', event => {
      event.preventDefault();
      if (this.busy) return;
      history.replaceState(null, '', location.pathname + location.search); void this.start();
    }));
    $('#settings-setup').addEventListener('click', event => {
      event.preventDefault();
      if (this.busy) return;
      $('#settings-dialog').close();
      if (location.hash !== '#setup') history.pushState(null, '', '#setup');
      void this.openSetup();
    });
    window.addEventListener('hashchange', () => {
      if (location.hash === '#setup' || location.hash === '#replace') void this.openSetup(location.hash === '#replace');
      else if (location.hash === '#demo') void this.demo();
      else if (this.blocked) void this.start();
    });
    $('#settings-dialog').addEventListener('close', () => {
      clearInputs('#current-password', '#new-password', '#confirm-password');
      $('#advanced-connection').open = false;
    });
  }
  get unlocked() { return Boolean(this.session); }
  get blocked() { return document.body.classList.contains('auth-blocked'); }
  message(error, fallback = 'The operation could not be completed. Please try again.') {
    let message = error instanceof Error ? error.message : fallback;
    if (message === PASSWORD_ERROR) return PASSWORD_ERROR;
    if (message.startsWith('A vault already exists.')) return 'A vault already exists. Use Replace vault to replace it; setup never overwrites an existing vault.';
    // Never show an accidentally echoed credential, including errors from a browser API.
    for (const secret of [this.session?.payload.token, ...[...document.querySelectorAll('input[type="password"]')].map(input => input.value)]) {
      if (secret) message = message.split(secret).join('[redacted]');
    }
    return message || fallback;
  }
  show(screen) {
    $('#lock-screen').hidden = screen !== 'lock'; $('#setup-screen').hidden = screen !== 'setup'; $('#replace-screen').hidden = screen !== 'replace';
    if (screen === 'setup' || screen === 'replace') {
      const replacing = screen === 'replace';
      $(replacing ? '#replace-form-host' : '#setup-form-host').append($('#vault-form-content'));
      $('#vault-form-content').hidden = !replacing && Boolean(this.vault);
      $('#setup-existing').hidden = !this.vault;
      $('#replace-fields').hidden = !replacing;
      $('#replace-confirm').disabled = !replacing;
      $('#replace-confirm').value = '';
      $('#setup-submit').textContent = replacing ? 'Replace vault and unlock' : 'Create vault and unlock';
      $('#setup-error').textContent = ''; $('#setup-status').textContent = '';
    }
    document.body.classList.toggle('auth-blocked', Boolean(screen));
    $('.topbar').inert = Boolean(screen); $('.workspace').inert = Boolean(screen);
    if (screen) {
      document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
      $('#selection-actions').hidden = true;
    }
    $('#lock-button').hidden = !this.unlocked;
    this.renderSecurity();
  }
  async showLock(message = '') {
    this.show('lock'); $('#unlock-error').textContent = message;
    $('#lock-other-options').open = false;
    $('#unlock-submit').disabled = !this.vault; $('#unlock-password').disabled = !this.vault;
    $('#unlock-retry').hidden = !message;
    $('#unlock-passkey').hidden = true;
    const vault = this.vault;
    if (vault && navigator.credentials && await passkeysAvailable(vault) && this.blocked && !$('#lock-screen').hidden && this.vault === vault) $('#unlock-passkey').hidden = false;
  }
  async start() {
    if (this.busy) return;
    this.cancelPendingRemovals();
    if (location.hash === '#demo' || location.hash.startsWith('#demo&article=')) return this.demo();
    const generation = ++this.generation;
    $('#unlock-error').textContent = 'Loading vault…';
    const restored = this.session || await loadRemembered();
    if (generation !== this.generation) return;
    if (restored && location.hash !== '#setup' && location.hash !== '#replace') {
      await this.accept(restored, true);
      if (generation !== this.generation) return;
      // A remembered library opens first; publication/replacement is checked in the background.
      void fetchPublicVault().then(async fresh => {
        if (generation !== this.generation || !this.session) return;
        if (fresh && fresh.vault_id !== this.vault.vault_id) {
          await this.lock('The vault was replaced. Unlock the new vault to continue.', fresh, true);
        } else if (fresh && fresh.updated_at >= this.vault.updated_at) {
          this.vault = fresh; this.session.vault = fresh; this.renderSecurity(); await this.persistRemembered();
        }
      }).catch(() => { /* The encrypted remembered session remains usable offline. */ });
      return;
    }
    try {
      const vault = await fetchPublicVault();
      if (generation !== this.generation) return;
      this.vault = vault;
      if (location.hash === '#setup' || location.hash === '#replace') this.show(location.hash.slice(1));
      else if (vault) await this.showLock();
      else if (getSettings().token) { this.show(null); await this.connect(getSettings()); }
      else this.show('setup');
    } catch (error) { if (generation === this.generation) await this.showLock(this.message(error)); }
  }
  async persistRemembered() {
    try {
      if (this.remember && this.session) await saveRemembered(this.session);
      else await deleteRemembered();
    } catch {
      this.remember = false;
      try { await deleteRemembered(); } catch { /* Browser storage may be disabled. */ }
      this.notify('This browser could not remember the device. You will need to unlock after reloading.');
    }
  }
  async accept(result, remember) {
    this.cancelPendingRemovals();
    this.vault = result.vault; this.session = result; this.remember = remember;
    // Migrate an old manual token out of persistent settings after a successful vault unlock.
    const settings = getSettings();
    if (settings.token) { try { saveSettings({ ...settings, token: '' }); } catch { this.notify('Remove the old manual token from browser storage on this device.'); } }
    await this.persistRemembered();
    this.renderSecurity(); this.show(null);
    await this.connect(result.payload);
  }
  setBusy(value, area, label) {
    this.busy = value;
    $(area).setAttribute('aria-busy', String(value));
    $(area).querySelectorAll('button,input').forEach(control => {
      control.disabled = value || (control.id === 'replace-confirm' && $('#replace-fields').hidden);
    });
    $('#security-controls').querySelectorAll('button,input').forEach(control => { control.disabled = value || !this.session; });
    $('#lock-button').disabled = value;
    if (label) label.element.textContent = value ? label.busy : label.normal;
  }
  async unlock(passkey) {
    if (this.busy || !this.vault) return;
    const label = { element: $('#unlock-submit'), normal: 'Unlock', busy: 'Unlocking…' };
    this.setBusy(true, '#lock-screen', label); $('#unlock-error').textContent = '';
    try {
      const result = passkey ? await unlockPasskey(this.vault) : await unlockWithPassword(this.vault, $('#unlock-password').value);
      await this.accept({ ...result, vault: this.vault }, $('#unlock-remember').checked);
    } catch (error) { $('#unlock-error').textContent = passkey ? this.message(error) : PASSWORD_ERROR; }
    finally { clearInputs('#unlock-password'); this.setBusy(false, '#lock-screen', label); }
  }
  async setup() {
    if (this.busy) return;
    const replacing = !$('#replace-screen').hidden, area = replacing ? '#replace-screen' : '#setup-screen';
    const label = { element: $('#setup-submit'), normal: replacing ? 'Replace vault and unlock' : 'Create vault and unlock', busy: 'Encrypting and saving…' };
    this.setBusy(true, area, label); $('#setup-error').textContent = ''; $('#setup-status').textContent = '';
    let created;
    try {
      if (replacing && $('#replace-confirm').value !== 'REPLACE') throw new Error('Type REPLACE exactly to replace the vault.');
      if (!replacing && this.vault) throw new Error('A vault already exists. Use Replace vault instead.');
      passwordRules($('#setup-password').value, $('#setup-confirm').value);
      const payload = {
        token: $('#setup-token').value.trim(), owner: $('#setup-owner').value.trim(), repo: $('#setup-repo').value.trim(), branch: $('#setup-branch').value.trim(),
        site_repo: $('#setup-site-repo').value.trim(), site_branch: $('#setup-site-branch').value.trim(),
      };
      if (!payload.token) throw new Error('Enter the GitHub access token.');
      const repository = await checkPrivateRepository(payload);
      if (repository.permissions?.push === false) throw new Error('The token needs Contents read and write on reading-data to sync your notes.');
      created = await createVault(payload, $('#setup-password').value);
      if (replacing && $('#replace-confirm').value !== 'REPLACE') throw new Error('Type REPLACE exactly to replace the vault.');
      await publishVault(payload, created.vault, replacing);
      await this.accept(created, $('#setup-remember').checked);
      clearInputs('#setup-token');
      this.notify(SAVED);
    } catch (error) { $('#setup-error').textContent = this.message(error); if (created && created !== this.session) created.dek.fill(0); }
    finally { clearInputs('#setup-password', '#setup-confirm', '#replace-confirm'); this.setBusy(false, area, label); }
  }
  async openSetup(replacing = false) {
    if (this.busy) return;
    ++this.generation; this.cancelPendingRemovals();
    const transition = this.session ? this.lock() : this.disconnect(), generation = this.generation;
    await transition;
    if (generation !== this.generation) return;
    this.show(replacing ? 'replace' : 'setup');
  }
  async demo() {
    if (this.busy) return;
    ++this.generation; this.cancelPendingRemovals();
    const transition = this.session ? this.lock() : null, generation = this.generation;
    await transition;
    if (generation !== this.generation) return;
    this.show(null);
    if (!location.hash.startsWith('#demo&article=')) history.replaceState(null, '', '#demo');
    await this.connect({ ...getSettings(), token: '' });
  }
  async lock(message = '', nextVault = this.vault, force = false) {
    if (this.busy && !force) return;
    ++this.generation; this.cancelPendingRemovals(); this.busy = true;
    $('#lock-button').disabled = true; $('#lock-button').textContent = 'Locking…';
    $('.workspace').inert = true;
    $('#unlock-submit').disabled = true; $('#unlock-passkey').hidden = true;
    try { await this.disconnect(); }
    catch (error) { this.notify(this.message(error)); }
    try { await deleteRemembered(); }
    catch { this.notify('Device storage could not be cleared. Clear this site’s browser data before leaving a shared device.'); }
    if (this.session) { this.session.dek.fill(0); this.session.payload.token = ''; }
    this.session = null; this.remember = false; this.vault = nextVault;
    clearInputs('#unlock-password', '#current-password', '#new-password', '#confirm-password');
    $('#passkey-list').replaceChildren(); $('#security-status').textContent = '';
    this.setBusy(false, '#security-section'); $('#lock-button').textContent = 'Lock';
    await this.showLock(message);
  }
  async leaveVault() {
    this.cancelPendingRemovals();
    if (this.session) await this.lock('', this.vault, true); else await deleteRemembered();
    this.show(null);
  }
  renderSecurity() {
    $('#security-section').hidden = false;
    $('#security-controls').hidden = !this.session;
    $('#security-controls').inert = !this.session;
    $('#security-controls').querySelectorAll('button,input').forEach(control => { control.disabled = !this.session || this.busy; });
    $('#security-unavailable').hidden = Boolean(this.session);
    $('#security-unavailable-message').textContent = this.vault
      ? 'Unlock your vault to manage its password and passkeys.'
      : 'Set up a vault to protect your connection with a password and passkeys.';
    if (!this.session) return;
    $('#passkey-label').value ||= defaultPasskeyLabel();
    const list = $('#passkey-list'); list.replaceChildren();
    for (const slot of this.vault.slots.filter(slot => slot.type === 'passkey' && !this.pendingRemovals.has(slot.id))) {
      const row = document.createElement('li'), label = document.createElement('span'), remove = document.createElement('button');
      label.textContent = `${slot.label} · ${new Date(slot.created_at).toLocaleDateString()}`;
      remove.textContent = 'Remove'; remove.type = 'button'; remove.dataset.slotId = slot.id; remove.disabled = this.busy;
      remove.setAttribute('aria-label', `Remove ${slot.label}`);
      remove.addEventListener('click', () => this.removePasskey(slot));
      row.append(label, remove); list.append(row);
    }
  }
  cancelPendingRemovals() {
    for (const removal of this.pendingRemovals.values()) removal.cancelNotice?.();
    this.pendingRemovals.clear();
    this.renderSecurity();
  }
  removePasskey(slot) {
    if (this.busy || !this.session || this.pendingRemovals.has(slot.id)) return;
    const removal = { id: slot.id, session: this.session, generation: this.generation, ready: false };
    this.pendingRemovals.set(slot.id, removal);
    this.renderSecurity();
    removal.cancelNotice = this.notify('Passkey removed. Undo to keep it.', {
      undo: () => {
        if (this.pendingRemovals.get(slot.id) !== removal) return;
        this.pendingRemovals.delete(slot.id); this.renderSecurity();
      },
      commit: () => {
        if (this.pendingRemovals.get(slot.id) !== removal) return;
        removal.ready = true; void this.flushRemovals();
      },
    });
  }
  async flushRemovals() {
    if (this.busy || !this.session) return;
    const removal = [...this.pendingRemovals.values()].find(item => item.ready && item.session === this.session && item.generation === this.generation);
    if (!removal) return;
    await this.securityChange(base => removeSlot(base, removal.id), 'Passkey removed. GitHub Pages may take a minute to publish the change.', { removal });
  }
  async securityChange(makeVault, successMessage, { removal, clearPasswords = false } = {}) {
    if (this.busy || !this.session?.dek) return;
    const generation = this.generation, base = this.vault, session = this.session;
    this.setBusy(true, '#security-controls'); $('#security-status').textContent = '';
    try {
      const changed = await makeVault(base, session);
      if (generation !== this.generation || session !== this.session) return;
      const updated = await commitVault(session.payload, base, changed);
      if (generation !== this.generation || session !== this.session) return;
      this.vault = updated; this.session.vault = updated;
      await this.persistRemembered();
      if (generation !== this.generation || session !== this.session) return;
      this.notify(successMessage);
    } catch (error) {
      if (generation === this.generation && session === this.session) this.notify(this.message(error));
    } finally {
      if (generation === this.generation && session === this.session) {
        if (removal) this.pendingRemovals.delete(removal.id);
        this.setBusy(false, '#security-controls');
        if (clearPasswords) clearInputs('#current-password', '#new-password', '#confirm-password');
        this.renderSecurity();
        // Expired removals wait for an active password/passkey change instead of being dropped.
        void this.flushRemovals();
      }
    }
  }
  async addPasskey() {
    await this.securityChange(async (base, session) => {
      const registration = await registerPasskey(message => this.notify(message));
      try { return await addPasskeySlot(base, session.dek, { ...registration, label: $('#passkey-label').value.trim() || defaultPasskeyLabel() }); }
      finally { registration.prfOutput.fill(0); }
    }, 'Passkey added. GitHub Pages may take a minute to publish the change.');
  }
  async changePassword() {
    await this.securityChange(async base => {
      const password = $('#new-password').value;
      passwordRules(password, $('#confirm-password').value);
      const verified = await unlockWithPassword(base, $('#current-password').value);
      try { return await changePassword(base, verified.dek, password); }
      finally { verified.dek.fill(0); }
    }, 'Password changed. GitHub Pages may take a minute to publish the change.', { clearPasswords: true });
  }
}
