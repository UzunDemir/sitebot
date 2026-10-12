// Prints the actual type signatures of the AI SDK APIs we depend on,
// straight from the installed .d.ts files. No network calls.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['node_modules/ai/dist', 'node_modules/@ai-sdk/react/dist'];
const files = [];

for (const root of roots) {
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (name.endsWith('.d.ts') || name.endsWith('.d.mts')) files.push(p);
    }
  };
  walk(root);
}

const needles = [
  'function createUIMessageStream',
  'function createUIMessageStreamResponse',
  'function toUIMessageStream',
  'function convertToModelMessages',
  'class DefaultChatTransport',
  'UIMessageStreamWriter',
  'data-${string}',
];

let printed = 0;
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const hits = new Map();
  lines.forEach((line, i) => {
    for (const needle of needles) {
      if (line.includes(needle)) {
        const arr = hits.get(needle) ?? [];
        if (arr.length < 2) arr.push(i);
        hits.set(needle, arr);
      }
    }
  });
  for (const [needle, idxs] of hits) {
    for (const i of idxs) {
      console.log(`### ${file}:${i + 1}  [${needle}]`);
      console.log(lines.slice(i, Math.min(i + 12, lines.length)).join('\n'));
      console.log();
      printed += 1;
      if (printed > 40) {
        console.log('... (output cap reached)');
        process.exit(0);
      }
    }
  }
}

console.log('done, sections printed:', printed);
