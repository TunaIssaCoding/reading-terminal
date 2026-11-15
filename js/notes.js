import { renderMarkdown } from './markdown.js';

const HIGHLIGHT_TYPE = 'application/x-reading-highlight';
let nextPaneId = 0;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function position(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : Infinity;
}

function highlightStart(highlight) {
  return position(highlight.start ?? highlight.start_offset ?? highlight.anchor?.start ?? highlight.anchor?.offset);
}

export class NotesPane {
  constructor({ root, onChange, onOpen }) {
    this.root = root;
    this.onChange = onChange;
    this.onOpen = onOpen;
    this.articleId = null;
    this.dragDepth = 0;
    const id = `long-notes-${++nextPaneId}`;
    const editorSection = element('section', 'long-notes-section');
    const heading = element('h2', 'notes-section-heading');
    const label = element('label', '', 'Long notes');
    label.htmlFor = id;
    heading.append(label);
    this.textarea = element('textarea', 'long-notes-editor');
    this.textarea.id = id;
    this.textarea.rows = 12;
    this.textarea.placeholder = 'Your thoughts, questions, and connections…';
    this.textarea.disabled = true;
    this.textarea.spellcheck = true;
    const hint = element('p', 'notes-editor-hint', 'Markdown welcome. Drop a highlighted passage here, or use its Send to notes button.');
    hint.id = `${id}-hint`;
    this.textarea.setAttribute('aria-describedby', hint.id);
    this.dropStatus = element('p', 'notes-drop-status');
    this.dropStatus.setAttribute('role', 'status');
    this.dropStatus.setAttribute('aria-live', 'polite');
    editorSection.append(heading, this.textarea, hint, this.dropStatus);
    const divider = element('hr', 'notes-divider');
    const marginSection = element('section', 'margin-notes-section');
    const marginHeading = element('h2', 'notes-section-heading', 'Margin notes');
    marginHeading.id = `${id}-margins`;
    marginSection.setAttribute('aria-labelledby', marginHeading.id);
    marginSection.append(marginHeading, element('p', 'notes-section-hint', 'In reading order. Edit these notes in the reader.'));
    this.margins = element('div', 'margin-notes-list');
    marginSection.append(this.margins);
    const botSection = element('section', 'bot-summary-section');
    const botHeading = element('h2', 'notes-section-heading', 'Reading bot summary');
    botHeading.id = `${id}-bot`;
    botSection.setAttribute('aria-labelledby', botHeading.id);
    this.bot = element('div', 'bot-summary markdown');
    botSection.append(botHeading, this.bot);
    const connectionsSection = element('section', 'connections-section');
    const connectionsHeading = element('h2', 'notes-section-heading', 'Connections');
    connectionsHeading.id = `${id}-connections`;
    connectionsSection.setAttribute('aria-labelledby', connectionsHeading.id);
    this.connections = element('div', 'bot-connections markdown');
    connectionsSection.append(connectionsHeading, this.connections);
    root.replaceChildren(editorSection, divider, marginSection, botSection, connectionsSection);

    this.textarea.addEventListener('input', () => { this.autogrow(); this.onChange?.(this.textarea.value); });
    let previousWidth = 0;
    this.resize = new ResizeObserver(entries => {
      const width = entries[0].contentRect.width;
      if (width === previousWidth) return;
      previousWidth = width; this.autogrow();
    });
    this.resize.observe(this.textarea);
    document.fonts?.ready.then(() => this.autogrow());
    root.addEventListener('click', event => {
      const target = event.target.nodeType === Node.ELEMENT_NODE ? event.target : event.target.parentElement;
      const link = target?.closest('a[data-article]');
      if (link && root.contains(link)) {
        event.preventDefault();
        this.onOpen?.(link.dataset.article);
      }
    });
    const dropRoot = root.closest('aside') || root;
    dropRoot.addEventListener('dragenter', event => {
      if (!this.accepts(event)) return;
      event.preventDefault();
      this.dragDepth++;
      root.classList.add('is-drag-over');
      this.dropStatus.textContent = 'Drop to append this highlighted passage to your long notes.';
    });
    dropRoot.addEventListener('dragover', event => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = this.accepts(event) ? 'copy' : 'none';
    });
    dropRoot.addEventListener('dragleave', event => {
      if (event.relatedTarget && dropRoot.contains(event.relatedTarget)) return;
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (!this.dragDepth || !event.relatedTarget || !dropRoot.contains(event.relatedTarget)) this.clearDrag();
    });
    dropRoot.addEventListener('drop', event => {
      const accepted = this.accepts(event);
      this.clearDrag();
      event.preventDefault();
      if (!accepted) return;
      try {
        const highlight = JSON.parse(event.dataTransfer.getData(HIGHLIGHT_TYPE));
        if (!highlight || typeof highlight.id !== 'string' || !highlight.id || typeof highlight.quote !== 'string' || !highlight.quote.trim()) {
          this.dropStatus.textContent = 'This drop was not a valid highlighted passage.';
          return;
        }
        this.appendQuote(highlight.quote);
      } catch {
        this.dropStatus.textContent = 'This drop was not a valid highlighted passage.';
      }
    });
    document.addEventListener('dragend', () => this.clearDrag());
    this.updateMargins([]);
    this.renderBot('');
  }

  accepts(event) {
    return this.articleId !== null && Array.from(event.dataTransfer?.types || []).includes(HIGHLIGHT_TYPE);
  }

  clearDrag() {
    this.dragDepth = 0;
    this.root.classList.remove('is-drag-over');
    this.dropStatus.textContent = '';
  }

  autogrow() {
    const pane = this.root.closest('aside') || this.root;
    const scrollTop = pane.scrollTop;
    this.textarea.style.height = '0px';
    this.textarea.style.height = `${this.textarea.scrollHeight}px`;
    pane.scrollTop = scrollTop;
  }

  setArticle(item, notes = {}, botMarkdown = '') {
    this.articleId = item ? String(item.id ?? item.slug) : null;
    this.textarea.disabled = !item;
    const value = String(notes?.long_notes ?? '');
    if (this.textarea.value !== value) this.textarea.value = value;
    this.autogrow();
    this.textarea.setAttribute('aria-label', item ? `Long notes for ${item.title || 'this article'}` : 'Long notes');
    this.clearDrag();
    this.updateMargins(notes?.highlights || []);
    this.renderBot(botMarkdown);
  }

  updateMargins(highlights = []) {
    const notes = highlights.filter(highlight => !highlight.deleted && String(highlight.note || '').trim()).map((highlight, index) => ({ highlight, index }));
    notes.sort((a, b) => {
      const paragraphA = position(a.highlight.para ?? a.highlight.anchor?.para);
      const paragraphB = position(b.highlight.para ?? b.highlight.anchor?.para);
      if (paragraphA !== paragraphB) return paragraphA < paragraphB ? -1 : 1;
      const startA = highlightStart(a.highlight);
      const startB = highlightStart(b.highlight);
      return startA !== startB ? (startA < startB ? -1 : 1) : a.index - b.index;
    });
    const fragment = document.createDocumentFragment();
    if (!notes.length) fragment.append(element('p', 'empty-state margin-notes-empty', 'Your interlinear notes will appear here as you write.'));
    for (const { highlight } of notes) {
      const entry = element('article', 'margin-note');
      entry.dataset.highlightId = String(highlight.id || '');
      const quote = element('blockquote', 'margin-note-quote');
      quote.append(element('p', '', String(highlight.quote || '')));
      const note = element('p', 'margin-note-text', String(highlight.note));
      const send = element('button', 'margin-send-button', 'Send quote to long notes');
      send.type = 'button';
      send.disabled = this.articleId === null || !String(highlight.quote || '').trim();
      send.addEventListener('click', () => this.appendQuote(highlight.quote));
      entry.append(quote, note, send);
      fragment.append(entry);
    }
    this.margins.replaceChildren(fragment);
  }

  renderBot(markdown) {
    const text = String(markdown || '');
    const lines = text.split(/\r?\n/);
    let fence = null;
    let connectionsAt = -1;
    for (let index = 0; index < lines.length; index++) {
      const marker = lines[index].match(/^ {0,3}(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      }
      if (!fence && /^ {0,3}#{1,6}\s+Connections\s*#*\s*$/i.test(lines[index])) { connectionsAt = index; break; }
    }
    const summary = connectionsAt < 0 ? text : lines.slice(0, connectionsAt).join('\n');
    const connections = connectionsAt < 0 ? '' : lines.slice(connectionsAt + 1).join('\n');
    this.bot.innerHTML = summary.trim() ? renderMarkdown(summary) : '<p class="empty-state">No reading bot summary yet.</p>';
    this.connections.innerHTML = connections.trim() ? renderMarkdown(connections) : '<p class="empty-state">No connections from the reading bot yet.</p>';
  }

  focus() {
    this.textarea.focus();
  }

  appendQuote(quote) {
    if (this.articleId === null || typeof quote !== 'string' || !quote.trim()) return false;
    const current = this.textarea.value.trimEnd();
    const quoted = quote.trim().replace(/\r\n?/g, '\n').split('\n').map(line => `> ${line}`).join('\n');
    this.textarea.value = `${current}${current ? '\n\n' : ''}${quoted}`;
    this.autogrow();
    this.onChange?.(this.textarea.value);
    this.focus();
    this.textarea.setSelectionRange(this.textarea.value.length, this.textarea.value.length);
    const pane = this.root.closest('aside') || this.root;
    const bottom = this.textarea.getBoundingClientRect().bottom - pane.getBoundingClientRect().bottom;
    if (bottom > 0) pane.scrollTop += bottom + 16;
    this.dropStatus.textContent = 'Highlighted passage appended to long notes.';
    return true;
  }
}
