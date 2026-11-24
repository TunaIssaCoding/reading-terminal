import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));

async function javascriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await javascriptFiles(filename));
    else if (entry.isFile()) files.push(filename);
  }
  return files;
}

test('the application never invokes blocking native dialogs', async () => {
  const files = [...await javascriptFiles(path.join(root, 'js')), path.join(root, 'index.html')];
  // Match calls, not identifiers: passwordRules(password, confirm) is a local
  // parameter and must remain legal, whereas calling confirm(...) is forbidden.
  const call = /(?<![\w$.])(?:(?:window|globalThis|self)\s*(?:\.\s*(?:prompt|confirm|alert)|\[\s*['"](?:prompt|confirm|alert)['"]\s*\])|(?:prompt|confirm|alert))\s*(?:\?\.)?\s*\(/g;
  const violations = [];
  for (const filename of files.sort()) {
    const source = await readFile(filename, 'utf8');
    for (const match of source.matchAll(call)) {
      const line = source.slice(0, match.index).split('\n').length;
      violations.push(`${path.relative(root, filename)}:${line}: ${match[0]}`);
    }
  }
  assert.deepEqual(violations, [], 'Use inline UI and Undo instead of native dialogs');
});
