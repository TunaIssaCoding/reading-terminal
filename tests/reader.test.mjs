import test from 'node:test';
import assert from 'node:assert/strict';
import { sentenceEnd } from '../js/reader.js';

const at = (text, offset) => text.slice(0, sentenceEnd(text, offset));

test('a note goes after the sentence the highlight ends in, past closing quotes and spaces', () => {
  assert.equal(at('One idea here. Two follows.', 3), 'One idea here. ');
  assert.equal(at('One idea here. Two follows.', 14), 'One idea here. ', 'highlight ending on the full stop');
  assert.equal(at('One idea here. Two follows.', 15), 'One idea here. ', 'highlight that took the trailing space');
  assert.equal(at('He said “stop!” Then left.', 4), 'He said “stop!” ');
  assert.equal(at('Really? Yes.', 2), 'Really? ');
  assert.equal(at('Wait… What now.', 1), 'Wait… ');
  assert.equal(at('In 2024. 2025 was calmer.', 3), 'In 2024. ');
});

test('abbreviations and decimals do not end a sentence; no full stop means the paragraph end', () => {
  assert.equal(at('See e.g. the list below. Next one.', 2), 'See e.g. the list below. ');
  assert.equal(at('Pi is 3.14 today. Next.', 2), 'Pi is 3.14 today. ');
  assert.equal(at('No ending at all', 3), 'No ending at all');
  assert.equal(at('Last one here.', 5), 'Last one here.');
});
