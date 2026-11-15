function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function safeURL(value, image = false) {
  const url = String(value).trim();
  if (!url || /[\u0000-\u0020\u007f\\]/.test(url) || url.startsWith('//')) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (!image && /^mailto:/i.test(url)) return url;
  if (/^[a-z][a-z\d+.-]*:/i.test(url)) return null;
  return url;
}

function articleTarget(value) {
  let target = null;
  if (/^article:/i.test(value)) target = value.slice(value.indexOf(':') + 1);
  else if (value.startsWith('#article=')) target = value.slice(9);
  else if (/^(?:(?:\.\.\/|\.\/)*articles\/|\.\/)?[^?#:]+\.md(?:[?#].*)?$/i.test(value)) {
    target = value.replace(/[?#].*$/, '').replace(/^(?:\.\.\/|\.\/)*articles\//, '').replace(/^\.\//, '').replace(/\.md$/i, '');
  }
  if (target === null) return null;
  try { target = decodeURIComponent(target); } catch { return null; }
  return target && !/[\u0000-\u0020\u007f<>"'\\]/.test(target) ? target : null;
}

function anchor(label, destination, title = '') {
  const target = articleTarget(destination);
  const titleAttribute = title ? ` title="${escapeHTML(title)}"` : '';
  if (target !== null) return `<a href="#article=${encodeURIComponent(target)}" data-article="${escapeHTML(target)}"${titleAttribute}>${label}</a>`;
  const url = safeURL(destination);
  if (url === null) return label;
  const external = /^https?:\/\//i.test(url) ? ' target="_blank" rel="noopener noreferrer"' : '';
  return `<a href="${escapeHTML(url)}"${external}${titleAttribute}>${label}</a>`;
}

function readLink(text, start, image) {
  const labelStart = start + (image ? 2 : 1);
  let depth = 1;
  let end = labelStart;
  for (; end < text.length; end++) {
    if (text[end] === '\\') { end++; continue; }
    if (text[end] === '[') depth++;
    if (text[end] === ']' && --depth === 0) break;
  }
  if (end >= text.length || text[end + 1] !== '(') return null;
  let close = end + 2;
  let parentheses = 1;
  for (; close < text.length; close++) {
    if (text[close] === '\\') { close++; continue; }
    if (text[close] === '(') parentheses++;
    if (text[close] === ')' && --parentheses === 0) break;
  }
  if (close >= text.length) return null;
  const raw = text.slice(end + 2, close).trim();
  const match = raw.match(/^(?:<([^<>\n]+)>|([^\s]+?))(?:\s+["']([^\n]*)["'])?$/);
  if (!match) return null;
  return { label: text.slice(labelStart, end), destination: match[1] ?? match[2], title: match[3] || '', end: close + 1 };
}

function inline(text, depth = 0, allowLinks = true) {
  if (depth > 12) return escapeHTML(text);
  const output = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '\\' && index + 1 < text.length && /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(text[index + 1])) {
      output.push(escapeHTML(text[index + 1]));
      index += 2;
      continue;
    }
    if (character === '`') {
      const run = text.slice(index).match(/^`+/)[0];
      const end = text.indexOf(run, index + run.length);
      if (end >= 0) {
        let code = text.slice(index + run.length, end).replace(/\n/g, ' ');
        if (code.startsWith(' ') && code.endsWith(' ') && /\S/.test(code)) code = code.slice(1, -1);
        output.push(`<code>${escapeHTML(code)}</code>`);
        index = end + run.length;
        continue;
      }
    }
    if (allowLinks && text.startsWith('[[', index)) {
      const end = text.indexOf(']]', index + 2);
      if (end >= 0) {
        const [target, ...label] = text.slice(index + 2, end).split('|');
        output.push(anchor(inline(label.join('|') || target, depth + 1, false), `article:${target.trim()}`));
        index = end + 2;
        continue;
      }
    }
    const image = text.startsWith('![', index);
    if (image || (allowLinks && character === '[')) {
      const link = readLink(text, index, image);
      if (link) {
        if (image) {
          const url = safeURL(link.destination, true);
          if (url !== null) {
            const asset = !/^https?:\/\//i.test(url) ? ` data-asset-path="${escapeHTML(url)}"` : '';
            const source = asset ? '' : ` src="${escapeHTML(url)}"`;
            output.push(`<img${source}${asset} alt="${escapeHTML(link.label)}"${link.title ? ` title="${escapeHTML(link.title)}"` : ''} loading="lazy" decoding="async">`);
          } else output.push(escapeHTML(link.label));
        } else output.push(anchor(inline(link.label, depth + 1, false), link.destination, link.title));
        index = link.end;
        continue;
      }
    }
    if (allowLinks && character === '<') {
      const match = text.slice(index).match(/^<(https?:\/\/[^<>\s]+|mailto:[^<>\s]+)>/i);
      if (match) {
        output.push(anchor(escapeHTML(match[1]), match[1]));
        index += match[0].length;
        continue;
      }
    }
    if (character === '*' || character === '_' || text.startsWith('~~', index)) {
      if (!(character === '_' && /\w/.test(text[index - 1] || '') && /\w/.test(text[index + 1] || ''))) {
        const marker = text.startsWith('***', index) ? '***' : text.startsWith('___', index) ? '___' : text.startsWith(character + character, index) ? character + character : character;
        const end = text.indexOf(marker, index + marker.length);
        if (end > index + marker.length && !/\s/.test(text[index + marker.length]) && !/\s/.test(text[end - 1])) {
          const content = inline(text.slice(index + marker.length, end), depth + 1, allowLinks);
          const tags = marker.length === 3 ? ['strong', 'em'] : [marker === '~~' ? 'del' : marker.length === 2 ? 'strong' : 'em'];
          output.push(tags.map(tag => `<${tag}>`).join('') + content + [...tags].reverse().map(tag => `</${tag}>`).join(''));
          index = end + marker.length;
          continue;
        }
      }
    }
    if (character === '\n' && index >= 2 && text.slice(index - 2, index) === '  ') output.push('<br>\n');
    else output.push(escapeHTML(character));
    index++;
  }
  return output.join('');
}

const LIST = /^( *)([-+*]|\d+[.)])\s+(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const RULE = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;

function beginsBlock(line) {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || /^ {0,3}>/.test(line) || LIST.test(line);
}

function blocks(lines) {
  const output = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const fence = line.match(FENCE);
    if (fence) {
      const code = [];
      const closing = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      index++;
      while (index < lines.length && !closing.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index++;
      const language = fence[2].trim().split(/\s+/)[0];
      const languageClass = /^[a-z\d_-]+$/i.test(language) ? ` class="language-${language}"` : '';
      output.push(`<pre><code${languageClass}>${escapeHTML(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      const level = heading[1].length;
      output.push(`<h${level}>${inline(heading[2].replace(/\s+#+\s*$/, ''))}</h${level}>`);
      index++;
      continue;
    }
    if (RULE.test(line)) { output.push('<hr>'); index++; continue; }
    if (index + 1 < lines.length && /^ {0,3}(?:=+|-+)\s*$/.test(lines[index + 1])) {
      const level = lines[index + 1].trim()[0] === '=' ? 1 : 2;
      output.push(`<h${level}>${inline(line)}</h${level}>`);
      index += 2;
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const quote = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index])) quote.push(lines[index++].replace(/^ {0,3}> ?/, ''));
      output.push(`<blockquote>${blocks(quote)}</blockquote>`);
      continue;
    }
    const first = line.match(LIST);
    if (first) {
      const indentation = first[1].length;
      const ordered = /^\d/.test(first[2]);
      const tag = ordered ? 'ol' : 'ul';
      const start = ordered && Number.parseInt(first[2], 10) !== 1 ? ` start="${Number.parseInt(first[2], 10)}"` : '';
      const entries = [];
      while (index < lines.length) {
        const item = lines[index].match(LIST);
        if (!item || item[1].length !== indentation || /^\d/.test(item[2]) !== ordered) break;
        const contentIndent = item[1].length + item[2].length + 1;
        const content = [item[3]];
        index++;
        while (index < lines.length) {
          const continuation = lines[index];
          const nextItem = continuation.match(LIST);
          if (nextItem && nextItem[1].length <= indentation) break;
          if (!continuation.trim()) {
            if (index + 1 < lines.length && lines[index + 1].match(/^ */)[0].length > indentation) { content.push(''); index++; continue; }
            break;
          }
          const spaces = continuation.match(/^ */)[0].length;
          if (spaces <= indentation) break;
          content.push(continuation.slice(Math.min(spaces, contentIndent)));
          index++;
        }
        entries.push(`<li>${blocks(content)}</li>`);
        if (index < lines.length && !lines[index].trim()) {
          const nextItem = lines[index + 1]?.match(LIST);
          if (nextItem && nextItem[1].length === indentation && /^\d/.test(nextItem[2]) === ordered) index++;
          else break;
        }
      }
      output.push(`<${tag}${start}>${entries.join('')}</${tag}>`);
      continue;
    }
    if (/^ {4}/.test(line)) {
      const code = [];
      while (index < lines.length && /^ {4}/.test(lines[index])) code.push(lines[index++].slice(4));
      output.push(`<pre><code>${escapeHTML(code.join('\n'))}</code></pre>`);
      continue;
    }
    const paragraph = [line];
    index++;
    while (index < lines.length && lines[index].trim() && !beginsBlock(lines[index])) {
      if (index + 1 < lines.length && /^ {0,3}(?:=+|-+)\s*$/.test(lines[index + 1])) break;
      paragraph.push(lines[index++]);
    }
    output.push(`<p>${inline(paragraph.join('\n'))}</p>`);
  }
  return output.join('\n');
}

export function renderMarkdown(text) {
  return blocks(String(text ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
}
