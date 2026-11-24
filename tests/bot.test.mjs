import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBotSummary, isSummaryStale } from '../js/bot.js';

test('block metadata connections preserve titles, explanations, and note freshness', () => {
  const parsed = parseBotSummary(`---
summary_by: "Notebook helper"
connections_by: 'Library helper'
date: 2026-11-18
notes_updated_at: 2026-11-17T10:00:00Z
connections:
  - slug: cloud-atlas
    title: 'Cloud atlas'
    why: "Maps, weather, and memory"
  - {slug: river-map, title: "River map", why: 'A reader''s parallel'}
---
# Private summary
Not the notes reflection.
## About your notes
You connected **weather** with memory.
### A question
What changes over time?
## Other output
Do not show this section.`);
  assert.equal(parsed.summary_by, 'Notebook helper');
  assert.equal(parsed.connections_by, 'Library helper');
  assert.equal(parsed.date, '2026-11-18');
  assert.equal(parsed.notes_updated_at, '2026-11-17T10:00:00Z');
  assert.equal(parsed.about, 'You connected **weather** with memory.\n### A question\nWhat changes over time?');
  assert.deepEqual(parsed.connections, [
    { slug: 'cloud-atlas', title: 'Cloud atlas', why: 'Maps, weather, and memory' },
    { slug: 'river-map', title: 'River map', why: "A reader's parallel" },
  ]);
});

test('inline frontmatter lists handle quoted punctuation and empty author fallback', () => {
  const parsed = parseBotSummary(`---
summary_by: ''
connections: [{slug: cloud-atlas, title: "Cloud, atlas", why: "A link: maps, not paths"}, {slug: river-map, title: 'River map'}]
---
A legacy reflection.`);
  assert.equal(parsed.summary_by, 'Reading bot');
  assert.equal(parsed.connections_by, 'Reading bot');
  assert.equal(parsed.about, 'A legacy reflection.');
  assert.deepEqual(parsed.connections, [
    { slug: 'cloud-atlas', title: 'Cloud, atlas', why: 'A link: maps, not paths' },
    { slug: 'river-map', title: 'River map', why: '' },
  ]);
});

test('markdown connections recognize article, file, fragment, bare, and wiki destinations', () => {
  const parsed = parseBotSummary(`A legacy summary.
## Connections
- [Cloud atlas](article:cloud-atlas) — Shared weather.
- [River map](articles/river-map.md): Shared geography.
- [Field book](#article=field-book)
- [Night chart](night-chart)
- [[island-log|Island log]] — Shared travel.
- [Duplicate](article:cloud-atlas)
## Unrelated
- [Not a suggestion](article:other-book)`);
  assert.equal(parsed.about, 'A legacy summary.');
  assert.deepEqual(parsed.connections, [
    { slug: 'cloud-atlas', title: 'Cloud atlas', why: 'Shared weather.' },
    { slug: 'river-map', title: 'River map', why: 'Shared geography.' },
    { slug: 'field-book', title: 'Field book', why: '' },
    { slug: 'night-chart', title: 'Night chart', why: '' },
    { slug: 'island-log', title: 'Island log', why: 'Shared travel.' },
  ]);
});

test('headings and links inside fenced or inline code are not sections or suggestions', () => {
  const parsed = parseBotSummary(`## About your notes
Before.
\`\`\`markdown
## Connections
- [Example](article:example)
\`\`\`not-a-closing-fence
## Other heading
\`\`\`
After.
## Connections
~~~markdown
- [Example two](article:example-two)
~~~
- \`[Example three](article:example-three)\`
- [Real suggestion](article:cloud-atlas)
## Other section
Omit this.`);
  assert.equal(parsed.about, 'Before.\n```markdown\n## Connections\n- [Example](article:example)\n```not-a-closing-fence\n## Other heading\n```\nAfter.');
  assert.deepEqual(parsed.connections, [{ slug: 'cloud-atlas', title: 'Real suggestion', why: '' }]);
});

test('unsafe and external destinations cannot become saved article connections', () => {
  const parsed = parseBotSummary(`---
connections:
  - {slug: 'javascript:alert(1)', title: Script}
  - {slug: '../private', title: Traversal}
  - {slug: 'cloud%2Fatlas', title: Encoded path}
  - {slug: 'cloud%22atlas', title: Encoded quote}
---
## About your notes
Reflection.
## Connections
- [Script](javascript:alert(1))
- [Data](data:text/html,payload)
- [External](https://example.invalid/article)
- [Protocol relative](//example.invalid/article)
- [Fragment injection](#article=bad%3Cscript%3E)
- [[../private]]
- ![Image](article:image)
- [Safe](article:cloud-atlas)`);
  assert.deepEqual(parsed.connections, [{ slug: 'cloud-atlas', title: 'Safe', why: '' }]);
});

test('empty or authorless summaries remain usable without invented metadata', () => {
  assert.deepEqual(parseBotSummary(''), {
    summary_by: 'Reading bot', connections_by: 'Reading bot', date: '', updated_at: '', notes_updated_at: '', about: '', connections: [],
  });
  const parsed = parseBotSummary('## About your notes\nA question remains.');
  assert.equal(parsed.summary_by, 'Reading bot');
  assert.equal(parsed.connections_by, 'Reading bot');
  assert.equal(parsed.about, 'A question remains.');
});

test('staleness compares actual note timestamps, not summary publication dates', () => {
  const summary = parseBotSummary(`---
updated_at: 2026-11-20T12:00:00Z
notes_updated_at: 2026-11-18T12:00:00Z
---
Reflection.`);
  assert.equal(isSummaryStale(summary, { updated_at: '2026-11-18T12:00:01Z' }), true);
  assert.equal(isSummaryStale(summary, { updated_at: '2026-11-18T12:00:00Z' }), false);
  assert.equal(isSummaryStale(summary, { updated_at: '2026-11-18T13:00:00+01:00' }), false);
  assert.equal(isSummaryStale(summary, { updated_at: '2026-11-17T12:00:00Z' }), false);
  assert.equal(isSummaryStale(summary, {}), false);
  assert.equal(isSummaryStale({}, { updated_at: '2026-11-21T12:00:00Z' }), false);
  assert.equal(isSummaryStale({ notes_updated_at: 'not a date' }, { updated_at: '2026-11-21T12:00:00Z' }), false);
});
