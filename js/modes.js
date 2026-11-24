import { splitArrivals, pileThisWeek, libraryShelves } from './model.js';
import { renderMarkdown } from './markdown.js';

const SHELVES = [
  ['started', 'Started, not finished', 'progress = reading'],
  ['keepers', 'Keepers to revisit', 'keeper · last opened > 60 days ago or never'],
  ['short', 'Under 10 minutes', 'read time ≤ 10 min · progress = new'],
  ['pile', 'The pile', 'before arrivals · progress = new · untriaged'],
];
const DECISIONS = [
  ['up-next', 'U', 'Up next'], ['keep', 'K', 'Keep in library'],
  ['let-go', 'L', 'Let go'], ['read', 'Enter', 'Read now'],
];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text) {
  const node = element('button', className, text);
  node.type = 'button';
  return node;
}

function timestamp(item) {
  const value = Date.parse(item.added_at || item.created_at || '');
  return Number.isFinite(value) ? value : 0;
}

function arrivalDate(item) {
  const date = new Date(item.added_at || item.created_at || '');
  if (!Number.isFinite(date.getTime())) return '';
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'arrived today';
  if (date.toDateString() === yesterday.toDateString()) return 'arrived yesterday';
  return `arrived ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

function bodyLede(markdown) {
  // Template contents are inert: even remote markdown images cannot fetch here.
  const template = document.createElement('template');
  template.innerHTML = renderMarkdown(markdown);
  for (const image of template.content.querySelectorAll('img')) image.replaceWith(document.createTextNode(image.alt || ''));
  for (const line of template.content.querySelectorAll('br,hr')) line.replaceWith(document.createTextNode(' '));
  for (const block of template.content.querySelectorAll('p,li,blockquote,h1,h2,h3,h4,h5,h6,pre')) block.append(' ');
  return template.content.textContent.replace(/\s+/g, ' ').trim().slice(0, 300);
}

export class ModeViews {
  constructor({ root, shelves, onDecision, onOpen, onRemove, onReorder, onPile, getBody }) {
    Object.assign(this, { root, shelves, onDecision, onOpen, onRemove, onReorder, onPile, getBody });
    this.mode = '';
    this.namespace = null;
    this.items = [];
    this.byId = new Map();
    this.rows = [];
    this.queueIds = [];
    this.pileIds = [];
    this.focusedId = null;
    this.selection = {};
    this.indices = {};
    this.ledes = new Map();
    this.cardVersion = 0;
    this.drag = null;
    this.pendingRender = null;
    this.restore = null;
    root.addEventListener('click', event => this.click(event));
    root.addEventListener('focusin', event => {
      const row = event.target.closest('.queue-row');
      if (row && root.contains(row)) this.select(row.dataset.id);
    });
    root.addEventListener('pointerdown', event => this.beginDrag(event));
    root.addEventListener('pointermove', event => this.moveDrag(event));
    root.addEventListener('pointerup', event => this.endDrag(event, true));
    root.addEventListener('pointercancel', event => this.endDrag(event, false));
    root.addEventListener('lostpointercapture', event => this.endDrag(event, false));
    shelves.addEventListener('click', event => {
      const heading = event.target.closest('.shelf-heading');
      if (heading && shelves.contains(heading)) {
        // Native toggle is queued; retain the choice before hydration can re-render.
        event.preventDefault();
        const shelf = heading.closest('.shelf');
        shelf.open = !shelf.open;
        this.shelfOpen[shelf.dataset.shelf] = shelf.open;
        try { localStorage.setItem(`reading-shelves:${this.namespace}`, JSON.stringify(this.shelfOpen)); } catch {}
        return;
      }
      const control = event.target.closest('button');
      if (!control || !shelves.contains(control)) return;
      if (control.id === 'triage-pile') this.onPile?.();
      else if (control.classList.contains('shelf-open')) this.onOpen?.(control.dataset.id);
    });
  }

  render(mode, items, options = {}) {
    if (this.drag) {
      this.pendingRender = { mode, items, options };
      return;
    }
    const active = this.root.ownerDocument.activeElement;
    const focusAction = this.mode === mode && this.root.contains(active)
      ? active.dataset.decision || active.dataset.modeAction || active.dataset.move : null;
    if (this.namespace !== options.namespace) {
      this.namespace = options.namespace;
      this.selection = {};
      this.indices = {};
      this.pileIds = [];
      this.restore = null;
      this.ledes.clear();
      this.shelfOpen = {};
      try {
        const saved = JSON.parse(localStorage.getItem(`reading-shelves:${this.namespace}`) || '{}');
        for (const [key] of SHELVES) this.shelfOpen[key] = saved?.[key] !== false;
      } catch {
        for (const [key] of SHELVES) this.shelfOpen[key] = true;
      }
    }
    this.mode = mode;
    this.items = items;
    this.options = options;
    this.byId = new Map(items.map(item => [String(item.id), item]));
    this.queueIds = (options.queue?.queue || []).map(String);
    this.arrivalsSince = options.arrivals_since || options.queue?.arrivals_since;
    this.root.hidden = mode === 'library';
    this.shelves.hidden = mode !== 'library';
    if (mode === 'library') {
      this.rows = [];
      this.focusedId = null;
      this.cardVersion++;
      this.root.replaceChildren();
      this.renderShelves();
      return;
    }
    if (mode === 'queue') this.rows = this.queueIds.map(id => this.byId.get(id)).filter(Boolean);
    else {
      const split = splitArrivals(items, {}, this.arrivalsSince);
      if (mode === 'pile') {
        const remaining = new Set(split.pile.map(item => String(item.id)));
        this.rows = this.pileIds.filter(id => remaining.has(id)).map(id => this.byId.get(id));
      } else this.rows = split.arrivals.sort((a, b) => timestamp(b) - timestamp(a));
    }
    const restored = this.restore?.mode === mode && this.rows.some(item => String(item.id) === this.restore.id);
    const selected = restored ? this.restore.id : this.selection[mode];
    const fallback = Math.min(this.indices[mode] || 0, this.rows.length - 1);
    this.select(this.rows.some(item => String(item.id) === selected) ? selected : this.rows[fallback]?.id ?? null);
    if (restored) this.restore = null;
    if (mode === 'queue') this.renderQueue();
    else this.renderCard();
    if (focusAction) {
      const controls = this.root.querySelectorAll('button');
      for (const control of controls) {
        const row = control.closest('.queue-row');
        if (row && row.dataset.id !== this.focusedId) continue;
        if ((control.dataset.decision || control.dataset.modeAction || control.dataset.move) === focusAction) {
          control.focus({ preventScroll: true });
          break;
        }
      }
    }
  }

  select(id) {
    this.focusedId = id == null ? null : String(id);
    this.selection[this.mode] = this.focusedId;
    const index = this.rows.findIndex(item => String(item.id) === this.focusedId);
    if (index >= 0) this.indices[this.mode] = index;
    for (const row of this.root.querySelectorAll('.queue-row')) row.classList.toggle('is-focused', row.dataset.id === this.focusedId);
  }

  renderCard() {
    const version = ++this.cardVersion;
    const fragment = document.createDocumentFragment();
    const item = this.byId.get(this.focusedId);
    if (!item || !this.rows.length) {
      const empty = element('section', 'mode-empty');
      empty.append(element('p', 'empty-state', this.mode === 'pile'
        ? (this.pileIds.length ? 'Batch complete. These pieces have found their place.' : 'Nothing in the pile to triage.')
        : 'Nothing new. New pieces land here after the morning update.'));
      if (this.mode === 'arrivals') {
        const pile = button('mode-pile-link', 'Triage the pile');
        pile.dataset.modeAction = 'pile';
        empty.append(pile);
      }
      fragment.append(empty);
    } else {
      const card = element('article', 'triage-card');
      card.dataset.id = String(item.id);
      const metadata = element('div', 'triage-meta');
      metadata.append(element('span', 'triage-source', item.source_label || item.source_type || 'Article'));
      if (item.source_type) metadata.append(element('span', 'triage-source-type', item.source_type));
      metadata.append(element('span', 'triage-minutes', `${item.read_minutes} min read`));
      const arrived = arrivalDate(item);
      if (arrived) metadata.append(element('span', 'triage-date', arrived));
      const title = element('h2', 'triage-title', item.title || 'Untitled article');
      title.classList.toggle('title-generated', Boolean(item.title_is_generated));
      card.append(metadata, title);
      const author = [item.author, item.handle].filter(Boolean).join(' ');
      if (author) card.append(element('p', 'triage-author', author));
      if (item.summary) {
        const summary = element('section', 'triage-summary bot-content');
        summary.append(element('div', 'bot-label', `Summary · from intake${item.summary_by ? ` · ${item.summary_by}` : ''}`), element('p', '', item.summary));
        card.append(summary);
      }
      const lede = element('p', 'triage-lede', item.lede || '');
      card.append(lede);
      const actions = element('div', 'triage-actions');
      for (const [decision, key, label] of DECISIONS) {
        const action = button('', '');
        action.dataset.decision = decision;
        action.append(element('kbd', '', key), document.createTextNode(` ${label}`));
        actions.append(action);
      }
      card.append(actions);
      const navigation = element('nav', 'triage-navigation');
      navigation.setAttribute('aria-label', this.mode === 'pile' ? 'Pile batch cards' : 'Arrival cards');
      const index = this.rows.findIndex(row => String(row.id) === this.focusedId);
      const previous = button('triage-previous', '←');
      previous.dataset.move = '-1';
      previous.disabled = index === 0;
      previous.setAttribute('aria-label', 'Previous card');
      const next = button('triage-next', '→');
      next.dataset.move = '1';
      next.disabled = index === this.rows.length - 1;
      next.setAttribute('aria-label', 'Next card');
      const position = element('span', 'triage-position', `${index + 1} of ${this.rows.length}${this.mode === 'pile' ? ' remaining in this batch' : ''}`);
      position.setAttribute('aria-live', 'polite');
      navigation.append(previous, position, next);
      fragment.append(card, navigation);
      if (!String(item.lede || '').trim()) this.loadLede(item, lede, version);
    }
    const week = pileThisWeek(this.items, {}, this.arrivalsSince);
    fragment.append(element('p', 'pile-week', `Pile this week: ${week.start} → ${week.current}`));
    this.root.replaceChildren(fragment);
  }

  loadLede(item, node, version) {
    if (!item.slug || !this.getBody) return;
    const namespace = this.namespace;
    if (!this.ledes.has(item.slug)) {
      const pending = Promise.resolve().then(() => this.getBody(item.slug)).then(bodyLede).catch(() => '');
      this.ledes.set(item.slug, pending);
    }
    this.ledes.get(item.slug).then(text => {
      if (version !== this.cardVersion || namespace !== this.namespace || !this.root.contains(node)) return;
      node.textContent = text;
      node.hidden = !text;
    });
  }

  renderQueue() {
    this.cardVersion++;
    const fragment = document.createDocumentFragment();
    if (!this.rows.length) fragment.append(element('p', 'empty-state mode-empty', 'Nothing up next. Choose a piece from Arrivals or the Library.'));
    else {
      const list = element('ol', 'queue-list');
      list.setAttribute('aria-label', 'Up next reading order');
      for (const item of this.rows) {
        const id = String(item.id);
        const row = element('li', 'queue-row');
        row.dataset.id = id;
        row.classList.toggle('is-focused', id === this.focusedId);
        row.classList.toggle('is-active', id === String(this.options.activeId));
        const title = item.title || 'Untitled article';
        const handle = button('queue-handle', '↕');
        handle.dataset.modeAction = 'handle';
        handle.style.touchAction = 'none';
        handle.setAttribute('aria-label', `Reorder ${title}; drag or use Alt+Up or Alt+Down`);
        const open = button('queue-open', title);
        open.dataset.modeAction = 'open';
        open.classList.toggle('title-generated', Boolean(item.title_is_generated));
        if (id === String(this.options.activeId)) open.setAttribute('aria-current', 'page');
        const content = element('div', 'queue-content');
        const metadata = element('div', 'queue-meta');
        metadata.append(element('span', 'queue-source', item.source_label || item.source_type || 'Article'), element('span', 'queue-minutes', `${item.read_minutes} min`));
        content.append(open, metadata);
        if (item.progress === 'reading') {
          const progress = element('progress', 'queue-progress');
          progress.max = 1;
          progress.value = Math.max(0, Math.min(1, Number(item.position) || 0));
          progress.setAttribute('aria-label', `Reading position for ${title}`);
          content.append(progress);
        }
        const remove = button('queue-remove', '×');
        remove.dataset.modeAction = 'remove';
        remove.setAttribute('aria-label', `Remove ${title} from Up next`);
        row.append(handle, content, remove);
        list.append(row);
      }
      fragment.append(list);
    }
    this.root.replaceChildren(fragment);
  }

  renderShelves() {
    const groups = libraryShelves(this.items, this.arrivalsSince);
    const fragment = document.createDocumentFragment();
    for (const [key, title, rule] of SHELVES) {
      const items = groups[key];
      const shelf = element('details', 'shelf');
      shelf.dataset.shelf = key;
      shelf.open = this.shelfOpen[key] !== false;
      const heading = element('summary', 'shelf-heading');
      heading.append(element('span', '', title), element('span', 'shelf-count', String(items.length)));
      heading.setAttribute('aria-label', `${title}, ${items.length} articles`);
      shelf.append(heading, element('p', 'shelf-rule', rule));
      const list = element('ul', 'shelf-items');
      for (const item of items.slice(0, 3)) {
        const row = element('li', '');
        const open = button('shelf-open', item.title || 'Untitled article');
        open.dataset.id = String(item.id);
        open.classList.toggle('title-generated', Boolean(item.title_is_generated));
        row.append(open);
        list.append(row);
      }
      if (!items.length) shelf.append(element('p', 'shelf-empty', 'No articles on this shelf.'));
      else shelf.append(list);
      if (key === 'pile') {
        const triage = button('shelf-triage', 'Triage 20');
        triage.id = 'triage-pile';
        triage.disabled = !items.length;
        shelf.append(triage);
      }
      fragment.append(shelf);
    }
    this.shelves.replaceChildren(fragment);
  }

  click(event) {
    const row = event.target.closest('.queue-row');
    if (row && this.root.contains(row)) this.select(row.dataset.id);
    const control = event.target.closest('button');
    if (!control || !this.root.contains(control)) return;
    if (control.dataset.decision) this.decide(control.dataset.decision);
    else if (control.dataset.move) this.move(Number(control.dataset.move));
    else if (control.dataset.modeAction === 'pile') this.onPile?.();
    else if (control.dataset.modeAction === 'open') this.openFocused();
    else if (control.dataset.modeAction === 'remove') this.removeFocused();
  }

  move(delta) {
    if (this.drag || !this.rows.length) return null;
    const index = this.rows.findIndex(item => String(item.id) === this.focusedId);
    const next = Math.max(0, Math.min(this.rows.length - 1, index + delta));
    this.select(this.rows[next].id);
    if (this.mode === 'queue') {
      const row = Array.from(this.root.querySelectorAll('.queue-row')).find(node => node.dataset.id === this.focusedId);
      row?.querySelector('.queue-open')?.focus({ preventScroll: true });
      row?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } else this.renderCard();
    return this.focusedId;
  }

  openFocused() {
    if (this.drag || !this.focusedId) return null;
    if (this.mode === 'arrivals' || this.mode === 'pile') return this.decide('read');
    if (this.mode === 'queue') this.onOpen?.(this.focusedId);
    return this.focusedId;
  }

  decide(key) {
    if (this.drag || !this.focusedId || (this.mode !== 'arrivals' && this.mode !== 'pile')) return null;
    const decision = { u: 'up-next', k: 'keep', l: 'let-go', enter: 'read', 'up-next': 'up-next', keep: 'keep', 'let-go': 'let-go', read: 'read' }[String(key).toLowerCase()];
    if (!decision) return null;
    const id = this.focusedId;
    this.onDecision?.(id, decision);
    return id;
  }

  removeFocused() {
    if (this.drag || this.mode !== 'queue' || !this.focusedId) return null;
    const id = this.focusedId;
    this.onRemove?.(id);
    return id;
  }

  reorderFocused(delta) {
    if (this.drag || this.mode !== 'queue') return null;
    const index = this.queueIds.indexOf(this.focusedId);
    const destination = Math.max(0, Math.min(this.queueIds.length - 1, index + delta));
    if (index < 0 || destination === index) return this.focusedId;
    const ids = this.queueIds.slice();
    ids.splice(destination, 0, ids.splice(index, 1)[0]);
    this.onReorder?.(ids);
    return this.focusedId;
  }

  startPile(ids) {
    this.pileIds = Array.from(new Set(ids.map(String))).filter(id => this.byId.has(id))
      .sort((a, b) => timestamp(this.byId.get(a)) - timestamp(this.byId.get(b))).slice(0, 20);
    this.selection.pile = this.pileIds[0] || null;
    this.indices.pile = 0;
    this.restore = null;
    return this.pileIds.slice();
  }

  restoreCard(id) {
    const value = String(id);
    const mode = this.pileIds.includes(value) ? 'pile' : 'arrivals';
    this.restore = { id: value, mode };
    this.selection[mode] = value;
    if (this.mode === mode && this.rows.some(item => String(item.id) === value)) {
      this.select(value);
      this.restore = null;
      this.renderCard();
    }
    return value;
  }

  beginDrag(event) {
    const handle = event.target.closest('.queue-handle');
    if (this.mode !== 'queue' || this.drag || !handle || !this.root.contains(handle) || event.button !== 0 || event.isPrimary === false) return;
    const row = handle.closest('.queue-row');
    const rows = Array.from(this.root.querySelectorAll('.queue-row'));
    this.select(row.dataset.id);
    handle.focus({ preventScroll: true });
    this.drag = {
      pointerId: event.pointerId, handle, row, rows,
      startY: event.clientY, index: rows.indexOf(row), destination: rows.indexOf(row),
      bounds: rows.map(node => node.getBoundingClientRect()),
    };
    row.classList.add('is-dragging');
    try { handle.setPointerCapture(event.pointerId); } catch { this.endDrag(event, false); return; }
    event.preventDefault();
  }

  moveDrag(event) {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    drag.row.style.transform = `translateY(${event.clientY - drag.startY}px)`;
    let destination = 0;
    const others = [];
    drag.rows.forEach((row, index) => {
      row.classList.remove('is-drop-target');
      delete row.dataset.dropPosition;
      if (row === drag.row) return;
      others.push(row);
      const bounds = drag.bounds[index];
      if (event.clientY > bounds.top + bounds.height / 2) destination++;
    });
    drag.destination = destination;
    if (destination === drag.index || !others.length) return;
    const target = others[Math.min(destination, others.length - 1)];
    target.classList.add('is-drop-target');
    target.dataset.dropPosition = destination === others.length ? 'after' : 'before';
  }

  endDrag(event, commit) {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.drag = null;
    drag.row.style.removeProperty('transform');
    for (const row of drag.rows) {
      row.classList.remove('is-dragging', 'is-drop-target');
      delete row.dataset.dropPosition;
    }
    if (drag.handle.hasPointerCapture(event.pointerId)) drag.handle.releasePointerCapture(event.pointerId);
    const pending = this.pendingRender;
    this.pendingRender = null;
    const sameNamespace = !pending || pending.options.namespace === this.namespace;
    if (pending) this.render(pending.mode, pending.items, pending.options);
    if (!commit || !sameNamespace || this.mode !== 'queue' || drag.index === drag.destination) return;
    const id = drag.row.dataset.id;
    if (!this.queueIds.includes(id)) return;
    const ids = this.queueIds.filter(candidate => candidate !== id);
    const otherRows = drag.rows.filter(row => row !== drag.row);
    const before = otherRows[drag.destination]?.dataset.id;
    const insertion = before && ids.includes(before) ? ids.indexOf(before) : ids.length;
    ids.splice(insertion, 0, id);
    this.onReorder?.(ids);
  }
}
