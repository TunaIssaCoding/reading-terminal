import { editionMinutes, editionDone, findMargin } from './edition.js';

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}
function button(className, label, action) {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
function progress(item) {
  return item.progress === 'reading' ? `Reading · ${Math.round((item.position || 0) * 100)}%`
    : ({ finished: 'Finished', let_go: 'Let go', new: 'New' }[item.progress] || 'New');
}

export class EditionView {
  constructor({ root, onOpen, onDecision, onAgree, onRevise, onMode }) {
    Object.assign(this, { root, onOpen, onDecision, onAgree, onRevise, onMode });
    this.rows = [];
    this.focusedId = null;
    root.addEventListener('focusin', event => {
      const row = event.target.closest('.edition-pick');
      if (row) this.select(row.dataset.id);
    });
  }

  render(edition, items, marginNotes) {
    const focused = this.root.contains(document.activeElement) ? document.activeElement : null;
    const focusClass = focused?.className;
    const focusSlug = focused?.closest('[data-slug]')?.dataset.slug;
    const focusDecision = focused?.dataset.decision;
    this.root.replaceChildren();
    this.rows = [];
    if (!edition) return;
    const bySlug = new Map(items.map(item => [item.slug, item]));
    const masthead = element('header', 'edition-masthead');
    const date = new Date(`${edition.date}T12:00:00`);
    masthead.append(element('p', 'section-eyebrow', 'TODAY’S EDITION'),
      element('h2', '', date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })));
    masthead.append(element('p', 'edition-count', `${edition.picks.length} ${edition.picks.length === 1 ? 'piece' : 'pieces'} · ${editionMinutes(edition, items)} min`));
    const generated = new Date(edition.generated_at);
    const time = Number.isFinite(generated.getTime())
      ? `, ${String(generated.getHours()).padStart(2, '0')}:${String(generated.getMinutes()).padStart(2, '0')}` : '';
    masthead.append(element('p', 'bot-label', `Proposed by ${edition.bot || 'Reading bot'}${time}`));
    this.root.append(masthead);
    const picks = element('ol', 'edition-picks');
    picks.setAttribute('aria-label', 'Edition picks');
    for (const pick of edition.picks) {
      const item = bySlug.get(pick.slug);
      if (!item) continue;
      this.rows.push(item);
      const row = element('li', 'edition-pick');
      row.dataset.slug = item.slug;
      row.dataset.id = String(item.id);
      const open = button('edition-open', item.title, () => { this.select(item.id); this.onOpen(item.id); });
      open.classList.toggle('title-generated', Boolean(item.title_is_generated));
      row.append(element('span', 'edition-slot', pick.slot), open,
        element('p', 'edition-meta', `${item.source_label || item.source_type || 'Article'} · ${item.read_minutes} min`),
        element('span', 'edition-progress', progress(item)), element('p', 'edition-why bot-content', pick.why));
      picks.append(row);
    }
    this.root.append(picks);
    if (!this.rows.length) this.root.append(element('p', 'empty-state', 'No picks available in this edition.'));
    if (editionDone(edition, items)) {
      const done = element('section', 'edition-done');
      done.setAttribute('role', 'status');
      done.append(element('p', '', "You're done for today."),
        button('edition-next', 'Up next', () => this.onMode('queue')),
        document.createTextNode(' / '), button('edition-library', 'Library', () => this.onMode('library')));
      this.root.append(done);
    }
    const highlight = findMargin(edition, marginNotes);
    if (highlight) {
      const margin = element('section', 'edition-margin');
      margin.dataset.slug = edition.margin.slug;
      margin.append(element('h2', '', 'From your margins'));
      if (edition.margin.why) margin.append(element('p', 'edition-margin-why bot-content', edition.margin.why));
      margin.append(element('blockquote', 'edition-quote', highlight.quote), element('p', 'edition-note', highlight.note));
      if (highlight.still_agree_at) margin.append(element('p', 'edition-agreed', `Still agree · ${highlight.still_agree_at}`));
      const actions = element('div', 'edition-actions');
      actions.append(button('edition-agree', 'Still agree', () => this.onAgree()),
        button('edition-revise', 'Revise it', () => this.onRevise()));
      margin.append(actions);
      this.root.append(margin);
    }
    const arrivals = edition.arrivals.map(slug => bySlug.get(slug)).filter(item => item && !item.triaged_at);
    if (arrivals.length) {
      const section = element('section', 'edition-arrivals');
      section.append(element('h2', '', 'Arrivals'));
      for (const item of arrivals) {
        const row = element('div', 'edition-arrival');
        row.dataset.slug = item.slug;
        row.dataset.id = String(item.id);
        row.append(button('edition-arrival-open', item.title, () => this.onOpen(item.id)));
        for (const [action, label] of [['up-next', 'Up next'], ['let-go', 'Let go']]) {
          const control = button('edition-decision', label, () => this.onDecision(item.id, action));
          control.dataset.decision = action;
          row.append(control);
        }
        section.append(row);
      }
      this.root.append(section);
    }
    this.select(this.rows.some(item => String(item.id) === this.focusedId) ? this.focusedId : this.rows[0]?.id);
    if (focusClass) {
      for (const control of this.root.querySelectorAll('button')) {
        if (control.className === focusClass && control.closest('[data-slug]')?.dataset.slug === focusSlug
          && control.dataset.decision === focusDecision) { control.focus({ preventScroll: true }); break; }
      }
    }
  }

  select(id) {
    this.focusedId = id == null ? null : String(id);
    for (const row of this.root.querySelectorAll('.edition-pick')) row.classList.toggle('is-focused', row.dataset.id === this.focusedId);
  }
  move(delta) {
    if (!this.rows.length) return;
    const index = this.rows.findIndex(item => String(item.id) === this.focusedId);
    const next = Math.max(0, Math.min(this.rows.length - 1, index + delta));
    this.select(this.rows[next].id);
    const row = this.root.querySelectorAll('.edition-pick')[next];
    row.querySelector('.edition-open').focus({ preventScroll: true });
    row.scrollIntoView({ block: 'nearest' });
  }
  openFocused() { if (this.focusedId !== null) this.onOpen(this.focusedId); }
}
