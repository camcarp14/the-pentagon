// Every function file must PARSE. That is a low bar and it was not being met.
//
// THE ONE THAT GOT THROUGH: app-kit.mjs holds its system prompt in a template
// literal, and the prompt described a JSON field as `key` — in backticks,
// because that is how you write a field name in prose. The backtick closed the
// template literal thirty lines early and the module became a syntax error.
//
// `npm run verify` was green through all of it. Nothing in the test suite
// imports a netlify function unless that function has a test of its own, and
// `vite build` bundles the SPA and never looks in netlify/. The first thing
// that would have noticed is the deploy — or, worse, the first request.
//
// So: parse every one of them. `node --check` rather than `await import()`,
// deliberately — importing runs module top-level code, and several of these
// construct clients or read env at import time. Parsing is the property we
// actually want to assert and it has no side effects at all.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const functionsDir = join(here, '..');
const root = join(functionsDir, '..', '..');

// functions/, functions/lib/ and functions/_shared/ — every place a deployed
// module lives. __tests__ is skipped: these files are vitest's, not Netlify's.
const collect = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...collect(full));
    } else if (/\.(mjs|cjs|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
};

const files = collect(functionsDir);

describe('every netlify function parses', () => {
  it('found the function directory at all', () => {
    // A collector that silently returns [] would make this whole file a
    // no-op that reads as passing.
    expect(files.length, 'no function files found — the collector is broken').toBeGreaterThan(20);
  });

  for (const file of files) {
    const rel = relative(root, file);
    it(rel, () => {
      try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      } catch (ex) {
        const detail = String(ex.stderr || ex.stdout || ex.message).trim();
        throw new Error(`${rel} does not parse:\n${detail}`);
      }
    });
  }
});
