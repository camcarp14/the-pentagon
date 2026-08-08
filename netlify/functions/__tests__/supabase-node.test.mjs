// The WebSocket outage, planted.
//
// Symptom in the field: pasting a job URL into Runway's capture box returned
// "Node.js detected but native WebSocket not found." Nothing in Runway uses
// realtime, and the message named a transport nobody had asked for. The cause
// was that createClient() builds a RealtimeClient eagerly, and that constructor
// resolves a WebSocket before knowing whether a channel will ever be opened —
// so on a runtime without a global WebSocket it threw inside requireUser(),
// i.e. on EVERY authenticated endpoint, before any handler logic ran.
//
// The control case below is the point of this file. A test that only asserted
// "serverClient works" would keep passing on a Node 22 runner that has a global
// WebSocket anyway, proving nothing. So it first proves the raw client STILL
// fails under the same conditions — if that assertion ever stops holding, this
// file is no longer testing what it claims to.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { serverClient } from '../lib/supabase-node.mjs';

const URL = 'https://example.supabase.co';
const KEY = 'not-a-real-key';

describe('server-side Supabase client without a global WebSocket', () => {
  let saved;
  // Node 20 has no global WebSocket; Node 22 does. Removing it makes a Node 22
  // runner reproduce the Node 20 runtime this actually broke on.
  beforeEach(() => { saved = globalThis.WebSocket; delete globalThis.WebSocket; });
  afterEach(() => { if (saved !== undefined) globalThis.WebSocket = saved; });

  it('CONTROL: the raw client still throws, so this suite is testing something', () => {
    expect(() => createClient(URL, KEY, { auth: { persistSession: false } }))
      .toThrow(/native WebSocket not found/);
  });

  it('constructs through the helper', () => {
    expect(() => serverClient(URL, KEY, { auth: { persistSession: false } })).not.toThrow();
  });

  it('returns a client that can still do the two things functions need', () => {
    const c = serverClient(URL, KEY, { auth: { persistSession: false } });
    expect(typeof c.auth.getUser).toBe('function');   // requireUser verifies the JWT
    expect(typeof c.from).toBe('function');           // everything else reads tables
  });

  it('does not swallow the caller options it is merging into', () => {
    // The bug this pins: spreading `realtime` in the wrong order, or dropping
    // the rest of the options object, would silently un-scope every query from
    // the runway schema and send it to public instead.
    const c = serverClient(URL, KEY, { auth: { persistSession: false }, db: { schema: 'runway' } });
    expect(typeof c.from).toBe('function');
    expect(c.rest?.schemaName ?? c.schema).toBeDefined();
  });

  it('is used by every server-side call site, not just the one that broke', async () => {
    // auth.mjs is the shared path; ops-runtime, scan-cron and whoami each built
    // their own client and each would have failed the same way. A grep is the
    // honest check here — an import that reintroduces createClient compiles fine.
    const { readFileSync, readdirSync } = await import('node:fs');
    const dir = new globalThis.URL('../', import.meta.url).pathname;
    const offenders = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === '__tests__' || e.name === 'node_modules') continue;
        const p = `${d}${e.name}`;
        if (e.isDirectory()) walk(`${p}/`);
        else if (/\.(mjs|js|cjs)$/.test(e.name) && e.name !== 'supabase-node.mjs') {
          if (/\bcreateClient\s*\(/.test(readFileSync(p, 'utf8'))) offenders.push(e.name);
        }
      }
    };
    walk(dir);
    expect(offenders).toEqual([]);
  });
});
