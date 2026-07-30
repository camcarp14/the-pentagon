"""Stage 9 — revise: plain-English feedback -> new draft.

Flow: feedback + current state -> prompt 05 -> constrained action list ->
apply -> re-run only the stages that changed -> render draft v(N+1) -> new
REVIEW doc. User cut adjustments persist in work/user_cuts.json so they
survive later re-cuts.
"""
import json
import re

from . import captions, cut, llm, package, popups, render, select, util


RECUT_OPS = {"shift_window", "choose_candidate", "add_cut", "remove_cut"}
POPUP_OPS = {"edit_popup", "remove_popup", "add_popup"}

# The caption keys prompt 05 is allowed to touch, and what each must become.
# What lands here is persisted into the project's overrides.yaml and deep-merged
# on every later call, so one bad value poisons the project permanently: a
# stringified "3" for group_max_words makes captions.group_words raise
# TypeError comparing int >= str on every stage from then on, and a comma in a
# font name shifts every field of the positional ASS Style row. English in the
# prompt was the only thing holding this shut.
CAPTION_STYLE_FIELDS = ("font_size", "y_pos", "highlight_color", "uppercase",
                        "group_max_words")
_HEX_COLOR = re.compile(r"#[0-9A-Fa-f]{6}")


def _caption_field(key, value):
    """Coerce one caption_style value, or raise so the caller can skip it."""
    if key in ("font_size", "y_pos"):
        num = float(value)          # whole numbers stay ints so overrides.yaml
        return int(num) if num.is_integer() else num   # keeps reading like 110
    if key == "group_max_words":
        return max(1, int(value))
    if key == "uppercase":
        if isinstance(value, bool):
            return value
        if str(value).strip().lower() in ("true", "false"):
            return str(value).strip().lower() == "true"
        raise ValueError(value)
    if not _HEX_COLOR.fullmatch(str(value)):
        raise ValueError(value)
    return str(value)


def caption_style_fields(action: dict) -> dict:
    out = {}
    for k, v in action.items():
        if k == "op":
            continue
        if k not in CAPTION_STYLE_FIELDS:
            print(f"    (ignoring caption_style key '{k}': not in the vocabulary)")
            continue
        try:
            out[k] = _caption_field(k, v)
        except (TypeError, ValueError):
            print(f"    (ignoring caption_style {k}={v!r}: wrong type)")
    return out


def revise(pdir, feedback: str):
    p = util.paths(pdir)
    settings = util.load_settings(pdir)
    state = util.load_state(pdir)
    edl = util.read_json(p["work"] / "edl.json")
    pops = util.read_json(p["work"] / "popups.json") \
        if (p["work"] / "popups.json").exists() else {"popups": []}
    pkg = util.read_json(p["work"] / "package.json") \
        if (p["work"] / "package.json").exists() else {}

    cut_markers = ", ".join(
        f"{util.remap_time(c['start'], edl['segments']):.1f}s ({c['reason']})"
        for c in edl["cuts"][:25]) or "none"

    # Prompt content includes the feedback + draft version, so the content-keyed
    # cache in llm.call() naturally re-asks for every new feedback round.
    result = llm.call(
        "05_revise", "05_revise.md",
        {"feedback": feedback.replace('"', "'"),
         "draft_version": state.get("draft_version", 1),
         "duration": f"{edl['duration']:.1f}",
         "cut_transcript": (p["work"] / "cut_transcript.txt").read_text(),
         "popups_json": json.dumps(pops.get("popups", []), indent=1),
         "caption_settings": json.dumps(settings["captions"], indent=1),
         "cut_markers": cut_markers,
         "package_json": json.dumps(pkg, indent=1)[:4000]},
        p, settings, temperature=0.2)

    version = state.get("draft_version", 1)
    (p["drafts"] / f"feedback_v{version}.md").write_text(
        f"## Feedback on v{version}\n\n{feedback}\n\n## Interpreted as\n\n"
        f"{result.get('summary', '')}\n\n```json\n"
        f"{json.dumps(result.get('actions', []), indent=2)}\n```\n")

    print("\nPlan:", result.get("summary", "(no summary)"))
    dirty = apply_actions(pdir, result.get("actions", []), edl, pops, pkg, settings)
    rebuild(pdir, dirty)
    return result


def apply_actions(pdir, actions, edl, pops, pkg, settings) -> set:
    p = util.paths(pdir)
    dirty = set()
    uc_file = p["work"] / "user_cuts.json"
    user_cuts = util.read_json(uc_file) if uc_file.exists() \
        else {"add": [], "suppress": []}
    popup_edited = any(a.get("op") in POPUP_OPS for a in actions)

    for a in actions:
        op = a.get("op")
        print(f"  - {op}: {json.dumps({k: v for k, v in a.items() if k != 'op'})[:120]}")

        if op == "shift_window":
            clips = util.read_json(p["work"] / "clips.json")
            for c in clips["candidates"]:
                if c["id"] == clips.get("chosen", clips.get("recommended")):
                    c["start"] = max(0, c["start"] + float(a.get("start_delta", 0)))
                    c["end"] = c["end"] + float(a.get("end_delta", 0))
            util.write_json(p["work"] / "clips.json", clips)
            llm.clear_response(p, "02_tighten")
            dirty.add("cut")

        elif op == "choose_candidate":
            select.choose(pdir, a["id"])
            for stage in ("02_tighten", "03_popups", "04_package"):
                llm.clear_response(p, stage)
            dirty.update({"cut", "popups", "package"})

        elif op == "add_cut":
            s = util.inverse_remap(float(a["start"]), edl["segments"])
            e = util.inverse_remap(float(a["end"]), edl["segments"])
            user_cuts["add"].append({"start": round(s, 3), "end": round(e, 3),
                                     "reason": a.get("reason", "creator feedback")})
            dirty.add("cut")

        elif op == "remove_cut":
            near_raw = util.inverse_remap(float(a["near"]), edl["segments"])
            if edl["cuts"]:
                target = min(edl["cuts"], key=lambda c: abs(c["start"] - near_raw))
                user_cuts["suppress"].append({"start": target["start"],
                                              "end": target["end"]})
                dirty.add("cut")

        elif op == "caption_style":
            fields = caption_style_fields(a)
            if fields:
                util.save_override(pdir, {"captions": fields})
                dirty.add("captions")

        elif op in ("edit_popup", "remove_popup", "add_popup"):
            lst = pops.setdefault("popups", [])
            if op == "remove_popup":
                pops["popups"] = [x for x in lst if x.get("id") != a.get("id")]
            elif op == "add_popup":
                new = {k: v for k, v in a.items() if k != "op"}
                new.setdefault("id", f"p{len(lst) + 1}u")
                lst.append(new)
            else:
                for x in lst:
                    if x.get("id") == a.get("id"):
                        x.update({k: v for k, v in a.items() if k not in ("op", "id")})
            util.write_json(p["work"] / "popups.json", pops)
            dirty.add("popups_render")

        elif op == "regenerate_popups":
            llm.clear_response(p, "03_popups")
            (p["work"] / "popups.json").unlink(missing_ok=True)
            dirty.add("popups")

        elif op == "edit_package":
            pkg[a.get("field", "")] = a.get("value")
            util.write_json(p["work"] / "package.json", pkg)
            dirty.add("package_doc")

        elif op == "regenerate_package":
            llm.clear_response(p, "04_package")
            (p["work"] / "package.json").unlink(missing_ok=True)
            dirty.add("package")

        elif op == "note":
            print(f"    NOTE (manual step): {a.get('text', '')}")
        else:
            print(f"    (unknown op '{op}' skipped)")

    util.write_json(uc_file, user_cuts)

    # A recut moves every timestamp; stale pop-up timing is worse than a
    # regenerate, so wipe them unless this batch explicitly edited pop-ups.
    if dirty & {"cut"} and not popup_edited:
        llm.clear_response(p, "03_popups")
        (p["work"] / "popups.json").unlink(missing_ok=True)
        dirty.add("popups")
    return dirty


def rebuild(pdir, dirty: set):
    settings = util.load_settings(pdir)
    if "cut" in dirty:
        cut.cut(pdir, force=True)
    if "cut" in dirty or "captions" in dirty:
        captions.build(pdir)
    if "popups" in dirty:
        popups.plan(pdir, force=True)
    elif "popups_render" in dirty or "cut" in dirty:
        pops = util.read_json(util.paths(pdir)["work"] / "popups.json") \
            if (util.paths(pdir)["work"] / "popups.json").exists() else {"popups": []}
        edl = util.read_json(util.paths(pdir)["work"] / "edl.json")
        pops["popups"] = popups.validate(pops.get("popups", []), edl["duration"], settings)
        util.write_json(util.paths(pdir)["work"] / "popups.json", pops)
        popups.render_overlays(pdir, pops["popups"], settings)
    if "package" in dirty:
        package.build_package(pdir, force=True)

    draft = render.render(pdir, final=False)
    package.write_review(pdir, draft)
    print("\nNew draft ready. Review, then revise again / approve / export.")
