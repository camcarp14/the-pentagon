// Renders the block tree from lib/markdown.js as React elements.
//
// The reason this is a component and not a `dangerouslySetInnerHTML`: every
// string it renders came out of a language model. Mapping a parsed tree onto
// elements means model output can never be markup — there is no path from a
// generated `<script>` to the DOM, because nothing here ever produces HTML from
// a string. Keep it that way.
//
// Extracted from PrintView when the Apply desk grew a second copy of it.
import { Fragment } from 'react';
import { parseMarkdown, parseInline } from '../lib/markdown.js';

export function Inline({ text }) {
  return parseInline(text).map((seg, i) =>
    seg.t === 'b' ? <b key={i}>{seg.s}</b> : seg.t === 'i' ? <em key={i}>{seg.s}</em> : <Fragment key={i}>{seg.s}</Fragment>,
  );
}

export default function Markdown({ text }) {
  return parseMarkdown(text).map((b, i) => {
    if (b.type === 'h1') return <h1 key={i}><Inline text={b.text} /></h1>;
    if (b.type === 'h2') return <h2 key={i}><Inline text={b.text} /></h2>;
    if (b.type === 'h3') return <h3 key={i}><Inline text={b.text} /></h3>;
    if (b.type === 'hr') return <hr key={i} />;
    if (b.type === 'ul') return <ul key={i}>{b.items.map((it, j) => <li key={j}><Inline text={it} /></li>)}</ul>;
    return <p key={i}><Inline text={b.text} /></p>;
  });
}
