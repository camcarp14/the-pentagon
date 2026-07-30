"""Stage 8 — packaging + the review document.

REVIEW_vN.md is the human checkpoint: selected clip + reasoning, cuts applied,
caption text, pop-up placements, b-roll notes, titles, description, pinned
comment, CTAs, thumbnail concept, and how to give feedback.
"""
from . import llm, util


def build_package(pdir, force: bool = False) -> dict:
    p = util.paths(pdir)
    out = p["work"] / "package.json"
    if out.exists() and not force:
        return util.read_json(out)
    settings = util.load_settings(pdir)
    edl = util.read_json(p["work"] / "edl.json")
    data = llm.call(
        "04_package", "04_package.md",
        {"style_guide": util.style_guide_text(),
         "duration": f"{edl['duration']:.1f}",
         "cut_transcript": (p["work"] / "cut_transcript.txt").read_text(),
         "links_placeholder": "LINKS: [store link] | [full video link]"},
        p, settings, temperature=settings.get("package_temperature", 0.7))
    util.write_json(out, data)
    return data


def write_review(pdir, draft_path: str) -> str:
    p = util.paths(pdir)
    state = util.load_state(pdir)
    v = state.get("draft_version", 1)
    clips = util.read_json(p["work"] / "clips.json")
    edl = util.read_json(p["work"] / "edl.json")
    popups = util.read_json(p["work"] / "popups.json") \
        if (p["work"] / "popups.json").exists() else {"popups": [], "broll_suggestions": []}
    pkg = util.read_json(p["work"] / "package.json") \
        if (p["work"] / "package.json").exists() else {}
    captions_txt = (p["work"] / "captions.txt").read_text() \
        if (p["work"] / "captions.txt").exists() else ""

    chosen = next(c for c in clips["candidates"]
                  if c["id"] == clips.get("chosen", clips.get("recommended")))

    lines = [f"# Draft review — v{v}", "",
             f"**Watch:** `{draft_path}`  ({edl['duration']:.1f}s)", "",
             "## Selected clip"]
    for c in clips["candidates"]:
        tag = " **(CHOSEN)**" if c["id"] == chosen["id"] else ""
        lines += [f"### Candidate {c['id']}{tag} — "
                  f"{util.fmt_ts(c['start'])}-{util.fmt_ts(c['end'])} raw, "
                  f"score {c.get('score', '?')}",
                  f"- Hook: {c.get('hook', '')}",
                  f"- Why: {c.get('why', '')}",
                  f"- Risk: {c.get('risk', '')}", ""]

    lines += ["## Cuts applied",
              f"{len(edl['cuts'])} cuts, {edl['removed_seconds']:.1f}s removed "
              f"from a {edl['window'][1] - edl['window'][0]:.1f}s window.", ""]
    for c in edl["cuts"][:30]:
        lines.append(f"- {util.fmt_ts(c['start'])}-{util.fmt_ts(c['end'])} (raw): {c['reason']}")
    if len(edl["cuts"]) > 30:
        lines.append(f"- ...and {len(edl['cuts']) - 30} more (see work/edl.json)")

    lines += ["", "## Caption text", "```", captions_txt, "```", "",
              "## Pop-ups (draft timeline)"]
    if popups.get("popups"):
        for pu in popups["popups"]:
            # `type` is optional to the renderer (popups._draw defaults it), so
            # a pop-up added by revise without one renders fine and then blew up
            # here with KeyError — after render already wrote draft vN and
            # bumped draft_version, leaving that draft with no REVIEW_vN.md.
            kind = pu.get("type", "text")
            desc = pu.get("text") or pu.get("asset") or kind
            lines.append(f"- `{pu['id']}` {pu['t_start']:.1f}-{pu['t_end']:.1f}s "
                         f"[{kind}] {desc} — {pu.get('intent', '')}")
    else:
        lines.append("- none")

    lines += ["", "## B-roll suggestions (not rendered — for you to shoot/insert)"]
    for b in popups.get("broll_suggestions", []) or [{"t": 0, "idea": "none", "source": ""}]:
        lines.append(f"- ~{b.get('t', 0):.0f}s: {b.get('idea', '')} ({b.get('source', '')})")

    if pkg:
        lines += ["", "## Packaging", "", "**Title options:**"]
        lines += [f"{i + 1}. {t}" for i, t in enumerate(pkg.get("titles", []))]
        lines += ["", "**Description:**", "", pkg.get("description", ""), "",
                  "**Pinned comment:**", "", pkg.get("pinned_comment", ""), "",
                  "**CTAs:**"]
        lines += [f"- ({c.get('placement', '')}) {c.get('text', '')}"
                  for c in pkg.get("ctas", [])]
        lines += ["", f"**Thumbnail concept:** {pkg.get('thumbnail_concept', '')}",
                  f"**Hashtags:** {' '.join(pkg.get('hashtags', []))}"]

    lines += ["", "---", "## How to revise", "",
              'Run: `python -m pipeline.cli revise <project> "your feedback"`', "",
              "Feedback that works well (times refer to THIS draft):",
              '- "Cut the part about paper wallets around 0:12"',
              '- "Start 2 seconds earlier, the hook feels clipped"',
              '- "Captions bigger and lower; highlight color too orange"',
              '- "Move the price pop-up to when I actually say the price"',
              '- "Use candidate B instead"', "",
              "When happy: `python -m pipeline.cli approve <project>` then "
              "`python -m pipeline.cli export <project>`"]

    review = p["drafts"] / f"REVIEW_v{v}.md"
    review.write_text("\n".join(lines))
    print(f"Review notes: {review}")
    return str(review)
