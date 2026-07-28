// The web capability's failure modes, which are all silent.
//
// The one that matters most: a server-tool error arrives as HTTP 200 with an
// error OBJECT where the results ARRAY should be. Code that iterates it without
// checking walks an object's keys, finds no `.url` on any of them, and reports
// a broken search as an empty one — the engine then writes its draft blind and
// nothing anywhere says so.
//
// These are pure-function tests over captured response shapes; no network.
import { describe, it, expect } from 'vitest';
import { toolsFor, readBlocks, researchQuality } from '../web.mjs';

describe('toolsFor — tool version is model-gated', () => {
  it('gives dynamic-filtering variants to models that support them', () => {
    for (const model of ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5']) {
      const [search, fetchTool] = toolsFor(model);
      expect(search.type).toBe('web_search_20260209');
      expect(fetchTool.type).toBe('web_fetch_20260209');
    }
  });

  // Pairing a _20260209 tool with a model that lacks it is a 400, not a
  // downgrade — so the Haiku paths must get the basic variants.
  it('falls back to the basic variants for models that lack them', () => {
    for (const model of ['claude-haiku-4-5-20251001', 'claude-haiku-4-5', 'claude-opus-4-5']) {
      const [search, fetchTool] = toolsFor(model);
      expect(search.type).toBe('web_search_20250305');
      expect(fetchTool.type).toBe('web_fetch_20250910');
    }
  });

  it('never emits code_execution alongside the web tools', () => {
    // The _20260209 tools run it internally; a second environment confuses the
    // model about which one it is in.
    expect(toolsFor('claude-sonnet-4-6').some((t) => /code_execution/.test(t.type))).toBe(false);
  });

  it('carries the search cap onto every tool', () => {
    for (const t of toolsFor('claude-sonnet-4-6', { maxSearches: 2 })) expect(t.max_uses).toBe(2);
  });

  it('sets at most one domain list — sending both is rejected upstream', () => {
    const [scoped] = toolsFor('claude-sonnet-4-6', {
      allowedDomains: ['example.com'], blockedDomains: ['spam.example'],
    });
    expect(scoped.allowed_domains).toEqual(['example.com']);
    expect(scoped.blocked_domains).toBeUndefined();

    const [blocked] = toolsFor('claude-sonnet-4-6', { blockedDomains: ['spam.example'] });
    expect(blocked.blocked_domains).toEqual(['spam.example']);
    expect(blocked.allowed_domains).toBeUndefined();
  });

  it('can drop fetch and keep search', () => {
    const tools = toolsFor('claude-sonnet-4-6', { fetch: false });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('web_search');
  });

  it('bounds fetched page size so one huge page cannot eat the context', () => {
    const [, fetchTool] = toolsFor('claude-sonnet-4-6');
    expect(fetchTool.max_content_tokens).toBeGreaterThan(0);
  });
});

describe('readBlocks — a failed lookup must not read as an empty one', () => {
  it('collects text and search sources on success', () => {
    const r = readBlocks([
      { type: 'text', text: 'Here is what I found. ' },
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', url: 'https://a.example/1', title: 'A', page_age: '2 days' },
          { type: 'web_search_result', url: 'https://b.example/2', title: 'B' },
        ],
      },
    ]);
    expect(r.text).toBe('Here is what I found.');
    expect(r.searches).toBe(1);
    expect(r.sources.map((s) => s.url)).toEqual(['https://a.example/1', 'https://b.example/2']);
    expect(r.errors).toEqual([]);
  });

  // THE bug this module exists to avoid.
  it('reads an error OBJECT as an error, not as zero results', () => {
    const r = readBlocks([
      { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
    ]);
    expect(r.sources).toEqual([]);
    expect(r.errors).toEqual([{ tool: 'web_search', code: 'max_uses_exceeded' }]);
    expect(r.searches).toBe(1); // it was attempted — that is the distinction
  });

  it('records a fetch failure without inventing a source', () => {
    const r = readBlocks([
      { type: 'web_fetch_tool_result', content: { error_code: 'url_not_accessible' } },
    ]);
    expect(r.fetches).toBe(1);
    expect(r.sources).toEqual([]);
    expect(r.errors).toEqual([{ tool: 'web_fetch', code: 'url_not_accessible' }]);
  });

  it('records a fetch success as a source', () => {
    const r = readBlocks([
      { type: 'web_fetch_tool_result', content: { type: 'web_fetch_result', url: 'https://c.example/doc', retrieved_at: '2026-07-01' } },
    ]);
    expect(r.sources).toEqual([{ kind: 'fetch', url: 'https://c.example/doc', title: null, age: '2026-07-01' }]);
    expect(r.errors).toEqual([]);
  });

  it('separates a partial failure from a total one', () => {
    const r = readBlocks([
      { type: 'web_search_tool_result', content: [{ url: 'https://ok.example' }] },
      { type: 'web_search_tool_result', content: { error_code: 'too_many_requests' } },
      { type: 'text', text: 'Answer.' },
    ]);
    expect(r.searches).toBe(2);
    expect(r.sources).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
  });

  it('survives malformed and empty content without throwing', () => {
    for (const bad of [undefined, [], [null], [{}], [{ type: 'text' }], [{ type: 'web_search_tool_result' }]]) {
      expect(() => readBlocks(bad)).not.toThrow();
    }
    expect(readBlocks([{ type: 'web_search_tool_result' }]).errors).toEqual([]);
  });

  it('ignores block types it does not understand rather than guessing', () => {
    const r = readBlocks([{ type: 'server_tool_use', name: 'web_search' }, { type: 'text', text: 'ok' }]);
    expect(r.text).toBe('ok');
    expect(r.sources).toEqual([]);
  });
});

describe('researchQuality — did the research actually happen?', () => {
  it('fails a pass that never searched', () => {
    expect(researchQuality({ searches: 0 }).ok).toBe(false);
  });

  // Searched, every lookup failed, model wrote from memory anyway. Looks like
  // research, costs like research, cites nothing.
  it('fails a pass where every lookup failed', () => {
    const q = researchQuality({ searches: 2, sources: [], errors: [{ code: 'too_many_requests' }] });
    expect(q.ok).toBe(false);
    expect(q.reason).toMatch(/written blind/);
  });

  it('fails a pass that searched successfully but cited nothing', () => {
    const q = researchQuality({ searches: 1, sources: [], errors: [] });
    expect(q.ok).toBe(false);
    expect(q.reason).toMatch(/cited nothing/);
  });

  it('passes a real research pass and counts the sources', () => {
    const q = researchQuality({ searches: 2, sources: [{ url: 'a' }, { url: 'b' }] });
    expect(q.ok).toBe(true);
    expect(q.reason).toMatch(/2 source\(s\) across 2 search\(es\)/);
  });

  it('passes a timed-out pass but flags it partial', () => {
    const q = researchQuality({ searches: 1, sources: [{ url: 'a' }], timedOut: true });
    expect(q.ok).toBe(true);
    expect(q.partial).toBe(true);
  });
});
