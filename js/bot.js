import { renderMarkdown } from './markdown.js';

const SLUG = /^[a-z\d][a-z\d_-]*$/i;
const META = new Set(['summary_by', 'connections_by', 'date', 'updated_at', 'notes_updated_at']);

function scalar(value) {
  const text = value.trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text); } catch { return text.slice(1, -1); }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return text.replace(/\s+#.*$/, '').trim();
}

// Split the small YAML-like flow syntax without breaking quoted commas or maps.
function flowParts(text) {
  const parts = [];
  let start = 0;
  let quote = '';
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === '\\' && quote === '"') index++;
      else if (char === quote) {
        if (quote === "'" && text[index + 1] === "'") index++;
        else quote = '';
      }
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    else if (char === ',' && depth === 0) { parts.push(text.slice(start, index)); start = index + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

function flowMap(text) {
  const result = {};
  for (const part of flowParts(text.trim().replace(/^\{([\s\S]*)\}$/, '$1'))) {
    const field = part.match(/^\s*(slug|title|why)\s*:\s*([\s\S]*)$/);
    if (field) result[field[1]] = scalar(field[2]);
  }
  return result;
}

function articleSlug(destination) {
  let slug = destination.trim().replace(/^<|>$/g, '');
  if (/^article:/i.test(slug)) slug = slug.slice(8);
  else if (slug.startsWith('#article=')) slug = slug.slice(9);
  else if (/^(?:(?:\.\.\/|\.\/)*articles\/|\.\/)?[^?#:]+\.md$/i.test(slug)) {
    slug = slug.replace(/^(?:\.\.\/|\.\/)*articles\//, '').replace(/^\.\//, '').slice(0, -3);
  }
  try { slug = decodeURIComponent(slug); } catch { return null; }
  return SLUG.test(slug) ? slug : null;
}

function outsideCode(lines, visit) {
  let fence = null;
  for (let index = 0; index < lines.length; index++) {
    const marker = lines[index].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) { fence = marker[1]; continue; }
    if (!/^ {4}|^\t/.test(lines[index])) visit(lines[index], index);
  }
}

export function parseBotSummary(markdown) {
  let text = String(markdown ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const summary = { summary_by: 'Reading bot', connections_by: 'Reading bot', date: '', updated_at: '', notes_updated_at: '', about: '', connections: [] };
  const candidates = [];
  const header = text.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (header) {
    let inConnections = false;
    let current = null;
    for (const line of header[1].split('\n')) {
      const top = line.match(/^([a-z_]+)\s*:\s*(.*)$/i);
      if (top) {
        inConnections = top[1] === 'connections';
        current = null;
        if (META.has(top[1])) summary[top[1]] = scalar(top[2]);
        if (inConnections && top[2].trim()) {
          const inline = top[2].trim();
          for (const part of flowParts(inline.replace(/^\[([\s\S]*)\]$/, '$1'))) candidates.push(flowMap(part));
        }
        continue;
      }
      if (!inConnections) continue;
      const item = line.match(/^\s*-\s*(.*)$/);
      if (item) { current = flowMap(item[1]); candidates.push(current); }
      else {
        const field = line.match(/^\s+(slug|title|why)\s*:\s*(.*)$/);
        if (current && field) current[field[1]] = scalar(field[2]);
      }
    }
    text = text.slice(header[0].length);
  }
  summary.summary_by ||= 'Reading bot';
  summary.connections_by ||= 'Reading bot';
  const lines = text.split('\n');
  const headings = [];
  outsideCode(lines, (line, index) => {
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) headings.push({ index, level: heading[1].length, title: heading[2].toLowerCase() });
  });
  const section = heading => {
    const next = headings.find(candidate => candidate.index > heading.index && candidate.level <= heading.level);
    return lines.slice(heading.index + 1, next?.index ?? lines.length);
  };
  const about = headings.find(heading => heading.title === 'about your notes');
  const connections = headings.filter(heading => heading.title === 'connections' || heading.title === 'suggested connections');
  summary.about = (about ? section(about) : lines.slice(0, connections[0]?.index ?? lines.length)).join('\n').trim();
  for (const heading of connections) {
    outsideCode(section(heading), line => {
      // Code spans are not suggestions, even when they contain link syntax.
      const content = line.replace(/(`+)[\s\S]*?\1/g, '');
      const pattern = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\)/g;
      for (const match of content.matchAll(pattern)) {
        if (content[match.index - 1] === '!') continue;
        const slug = articleSlug(match[1] ?? match[4]);
        if (!slug) continue;
        candidates.push({ slug, title: match[2] || match[3] || slug, why: content.slice(match.index + match[0].length).replace(/^\s*(?:[—–:-]\s*)?/, '').trim() });
      }
    });
  }
  const seen = new Set();
  for (const connection of candidates) {
    if (typeof connection.slug !== 'string') continue;
    const slug = articleSlug(connection.slug);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    summary.connections.push({ slug, title: String(connection.title || slug), why: String(connection.why || '') });
  }
  return summary;
}

export function isSummaryStale(summary, notes) {
  const written = Date.parse(summary?.notes_updated_at);
  const changed = Date.parse(notes?.updated_at);
  return Number.isFinite(written) && Number.isFinite(changed) && written < changed;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function markdownContent(markdown) {
  const node = element('div', 'markdown');
  node.innerHTML = renderMarkdown(markdown);
  for (const link of node.querySelectorAll('a[data-article]')) {
    if (!SLUG.test(link.dataset.article)) link.replaceWith(...link.childNodes);
  }
  return node;
}

export class BotBox {
  constructor({ root, getItem, onKeep, onUnkeep, onHide, onOpen }) {
    this.root = root;
    this.getItem = getItem;
    this.onUnkeep = onUnkeep;
    this.markdown = null;
    this.showHidden = false;
    this.onKeep = onKeep;
    this.onHide = onHide;
    this.onOpen = onOpen;
    root.classList.add('bot-content');
    root.hidden = true;
    root.addEventListener('click', event => {
      const target = event.target.nodeType === Node.ELEMENT_NODE ? event.target : event.target.parentElement;
      const link = target?.closest('a[data-article]');
      if (!link || !root.contains(link)) return;
      event.preventDefault();
      this.onOpen?.(link.dataset.article);
    });
  }

  render(markdown, notes = {}) {
    if (markdown !== this.markdown) this.showHidden = false;
    this.markdown = markdown;
    this.root.replaceChildren();
    this.root.hidden = !String(markdown ?? '').trim();
    if (this.root.hidden) return;
    const summary = parseBotSummary(markdown);
    const date = new Date(summary.date || summary.updated_at);
    const stamp = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    this.root.append(element('p', 'bot-attribution', `${summary.summary_by}${stamp ? ` · ${stamp}` : ''} · about your notes`));
    if (isSummaryStale(summary, notes)) this.root.append(element('p', 'bot-stale', 'Your notes changed since this was written.'));
    if (summary.about) {
      this.root.append(element('h2', 'bot-heading', 'About your notes'), markdownContent(summary.about));
    }
    const hidden = new Set(notes?.hidden_links || []);
    const kept = new Set((notes?.links || []).map(link => link.slug));
    const hiddenCount = summary.connections.filter(connection => hidden.has(connection.slug)).length;
    const suggestions = summary.connections.filter(connection => this.showHidden || !hidden.has(connection.slug));
    if (!summary.connections.length) return;
    this.root.append(element('h2', 'bot-connections-heading', `Suggested by ${summary.connections_by}`));
    if (hiddenCount) {
      const toggle = element('button', 'bot-show-hidden', `${this.showHidden ? 'Hide hidden' : 'Show hidden'} (${hiddenCount})`);
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', String(this.showHidden));
      toggle.addEventListener('click', () => {
        this.showHidden = !this.showHidden;
        this.render(markdown, notes);
        this.root.querySelector('.bot-show-hidden')?.focus();
      });
      this.root.append(toggle);
    }
    const list = element('ul', 'bot-connections');
    for (const connection of suggestions) {
      const row = element('li', 'bot-connection');
      row.dataset.slug = connection.slug;
      const item = this.getItem?.(connection.slug);
      const title = item?.title || connection.title || connection.slug;
      const link = element(item ? 'a' : 'span', 'bot-connection-link', title);
      if (item) {
        link.href = `#article=${encodeURIComponent(connection.slug)}`;
        link.dataset.article = connection.slug;
      }
      row.append(link);
      if (!item) row.append(element('span', 'connection-missing', 'not in your library'));
      if (hidden.has(connection.slug)) row.append(element('span', 'connection-hidden', 'Hidden'));
      if (connection.why) row.append(markdownContent(connection.why));
      const keep = element('button', 'bot-keep', kept.has(connection.slug) ? 'Kept ✓' : 'Keep link');
      keep.type = 'button';
      keep.dataset.action = 'keep';
      keep.dataset.slug = connection.slug;
      keep.disabled = !item || kept.has(connection.slug);
      keep.addEventListener('click', () => {
        const current = this.getItem?.(connection.slug);
        if (current) this.onKeep?.({ slug: connection.slug, title: current.title || connection.slug });
      });
      row.append(keep);
      if (kept.has(connection.slug)) {
        const unkeep = element('button', 'bot-unkeep', 'Unkeep');
        unkeep.type = 'button';
        unkeep.dataset.slug = connection.slug;
        unkeep.addEventListener('click', () => this.onUnkeep?.(connection.slug));
        row.append(unkeep);
      }
      const hide = element('button', 'bot-hide', 'Hide');
      hide.type = 'button';
      hide.dataset.action = 'hide';
      hide.dataset.slug = connection.slug;
      hide.disabled = hidden.has(connection.slug);
      hide.addEventListener('click', () => this.onHide?.(connection.slug));
      row.append(hide);
      list.append(row);
    }
    this.root.append(list);
  }
}
