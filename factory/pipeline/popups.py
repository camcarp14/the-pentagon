"""Stage 6 — pop-ups: place a small number of graphics, render them as
transparent PNG overlays (Pillow), and keep b-roll ideas as human notes.

The LLM decides WHAT and WHEN (prompt 03, with hard restraint rules); the code
validates the budget/zones and renders deterministic, on-brand graphics.
"""
import json
import math
import re

from . import llm, util


# A pop-up id becomes a filename in work/overlays/ and then an ffmpeg input
# path, so it is a filesystem sink fed by raw model output. Ids are ours to
# assign, not the model's to choose: anything that is not a plain token gets
# replaced rather than trusted.
_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,32}")


def _safe_id(value, fallback: str) -> str:
    return str(value) if _ID_RE.fullmatch(str(value or "")) else fallback


def plan(pdir, force: bool = False):
    p = util.paths(pdir)
    out = p["work"] / "popups.json"
    settings = util.load_settings(pdir)
    if out.exists() and not force:
        data = util.read_json(out)
    else:
        edl = util.read_json(p["work"] / "edl.json")
        dur = edl["duration"]
        pc = settings["popups"]
        max_popups = max(1, math.ceil(dur / 30 * pc["max_per_30s"]))
        data = llm.call(
            "03_popups", "03_popups.md",
            {"style_guide": util.style_guide_text(),
             "duration": f"{dur:.1f}",
             "cut_transcript": (p["work"] / "cut_transcript.txt").read_text(),
             "graphics_manifest": _manifest_text(settings),
             "max_popups": max_popups,
             "min_duration": pc["min_duration"],
             "caption_zone_lo": pc["caption_zone"][0],
             "caption_zone_hi": pc["caption_zone"][1]},
            p, settings)
        data["popups"] = validate(data.get("popups", []), dur, settings)
        util.write_json(out, data)
    render_overlays(pdir, data["popups"], settings)
    return data


def _manifest_text(settings) -> str:
    mf = util.ROOT / settings["paths"]["graphics_dir"] / "manifest.json"
    if not mf.exists():
        return "(no image assets available -- do not use type 'image')"
    assets = util.read_json(mf)
    lines = [f"- {a['file']}: {a.get('description', '')}" for a in assets
             if (mf.parent / a["file"]).exists()]
    return "\n".join(lines) or "(no image assets available -- do not use type 'image')"


def validate(popups: list, duration: float, settings: dict) -> list:
    pc = settings["popups"]
    budget = max(1, math.ceil(duration / 30 * pc["max_per_30s"]))
    lo, hi = pc["caption_zone"]
    ok, last_end = [], -1.0
    for i, pu in enumerate(sorted(popups, key=lambda x: x.get("t_start", 0))):
        pu["id"] = _safe_id(pu.get("id"), f"p{i + 1}")
        t0 = max(1.5, float(pu.get("t_start", 0)))
        t1 = min(duration - 0.1, float(pu.get("t_end", t0 + pc["default_duration"])))
        if t1 - t0 < pc["min_duration"]:
            t1 = min(duration - 0.1, t0 + pc["min_duration"])
            if t1 - t0 < pc["min_duration"]:
                # Only t_end was clamped to the clip, never t_start, so a pop-up
                # timed against a longer earlier cut survived inverted
                # (t_start > t_end). ffmpeg's between() is then never true: the
                # graphic never appears, yet it still spends a budget slot and
                # still gets listed in the review doc as present.
                print(f"  dropping {pu['id']}: no room before the end of the clip")
                continue
        if t0 < last_end:            # no simultaneous pop-ups
            t0 = last_end + 0.1
            if t1 - t0 < pc["min_duration"]:
                print(f"  dropping {pu['id']}: overlaps previous pop-up")
                continue
        pu["t_start"], pu["t_end"] = round(t0, 2), round(t1, 2)
        if pu.get("type") in ("text", "image") and lo <= float(pu.get("y", 0.3)) <= hi:
            print(f"  nudging {pu['id']} out of the caption zone")
            pu["y"] = 0.28
        ok.append(pu)
        last_end = t1
        if len(ok) >= budget:
            break
    return ok


# ------------------------------------------------------------- rendering

def render_overlays(pdir, popups: list, settings: dict):
    from PIL import Image  # lazy
    p = util.paths(pdir)
    for f in p["overlays"].glob("*.png"):
        f.unlink()
    o = settings["output"]
    manifest = []
    for i, pu in enumerate(popups):
        img = Image.new("RGBA", (o["width"], o["height"]), (0, 0, 0, 0))
        try:
            _draw(img, pu, settings)
        except Exception as e:
            print(f"  skipping {pu.get('id')}: {e}")
            continue
        fn = f"{_safe_id(pu.get('id'), f'p{i + 1}')}.png"
        img.save(p["overlays"] / fn)
        manifest.append({"png": fn, "t0": pu["t_start"], "t1": pu["t_end"],
                         "id": pu["id"]})
    util.write_json(p["work"] / "overlays.json", manifest)
    print(f"Rendered {len(manifest)} overlay(s)")
    return manifest


def _font(size: int):
    from PIL import ImageFont
    candidates = list((util.ROOT / util.load_settings()["paths"]["fonts_dir"]).glob("*.ttf"))
    candidates += list((util.ROOT / util.load_settings()["paths"]["fonts_dir"]).glob("*.otf"))
    fallbacks = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                 "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
                 "C:/Windows/Fonts/arialbd.ttf"]
    for c in [str(c) for c in candidates] + fallbacks:
        try:
            return ImageFont.truetype(c, size)
        except OSError:
            continue
    from PIL import ImageFont as IF
    print("  WARNING: no TTF found; pop-up text will look rough. "
          "Add a font to assets/fonts/.")
    return IF.load_default()


def _luminance(rgb) -> float:
    r, g, b = [v / 255 for v in rgb]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _draw(img, pu: dict, settings: dict):
    from PIL import Image, ImageDraw
    d = ImageDraw.Draw(img)
    W, H = img.size
    accent = util.hex_to_rgb(settings["brand"]["accent"])
    dark = util.hex_to_rgb(settings["brand"]["dark"])
    kind = pu.get("type", "text")

    if kind == "text":
        text = str(pu.get("text", ""))[:32]
        font = _font(int(64 * float(pu.get("size", 1.0))))
        bbox = d.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        pad_x, pad_y = 44, 30
        cx, cy = float(pu.get("x", 0.5)) * W, float(pu.get("y", 0.28)) * H
        x0, y0 = cx - tw / 2 - pad_x, cy - th / 2 - pad_y
        x1, y1 = cx + tw / 2 + pad_x, cy + th / 2 + pad_y
        # soft shadow, then pill, then accent edge, then text
        d.rounded_rectangle([x0 + 6, y0 + 8, x1 + 6, y1 + 8], radius=28,
                            fill=(0, 0, 0, 90))
        d.rounded_rectangle([x0, y0, x1, y1], radius=28, fill=(*dark, 235),
                            outline=(*accent, 255), width=4)
        text_color = (*util.hex_to_rgb(settings["brand"]["light"]), 255)
        d.text((cx - tw / 2 - bbox[0], cy - th / 2 - bbox[1]), text,
               font=font, fill=text_color)

    elif kind == "circle":
        cx, cy = float(pu.get("x", 0.5)) * W, float(pu.get("y", 0.4)) * H
        r = float(pu.get("w", 0.18)) * W / 2
        d.ellipse([cx - r - 3, cy - r - 3, cx + r + 3, cy + r + 3],
                  outline=(0, 0, 0, 160), width=18)
        d.ellipse([cx - r, cy - r, cx + r, cy + r],
                  outline=(*accent, 255), width=12)

    elif kind == "rect":
        cx, cy = float(pu.get("x", 0.5)) * W, float(pu.get("y", 0.4)) * H
        w, h = float(pu.get("w", 0.3)) * W, float(pu.get("h", 0.2)) * H
        box = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]
        d.rounded_rectangle([b + 3 for b in box], radius=18,
                            outline=(0, 0, 0, 160), width=16)
        d.rounded_rectangle(box, radius=18, outline=(*accent, 255), width=10)

    elif kind == "arrow":
        x1, y1 = float(pu.get("x1", 0.3)) * W, float(pu.get("y1", 0.25)) * H
        x2, y2 = float(pu.get("x2", 0.55)) * W, float(pu.get("y2", 0.45)) * H
        _arrow(d, (x1 + 4, y1 + 5), (x2 + 4, y2 + 5), (0, 0, 0, 150), 20)
        _arrow(d, (x1, y1), (x2, y2), (*accent, 255), 14)

    elif kind == "image":
        # The asset name is free-form model output feeding a read whose result
        # is burned into the published video. `graphics_dir / "../../secrets"`
        # escapes, and an absolute value discards graphics_dir entirely
        # (Path("/a/b") / "/tmp/x.png" is "/tmp/x.png"), so a private image
        # could be composited into a Short. Only files that actually sit in
        # graphics_dir are eligible.
        gdir = (util.ROOT / settings["paths"]["graphics_dir"]).resolve()
        asset = (gdir / str(pu.get("asset", ""))).resolve()
        if asset.parent != gdir or not asset.is_file():
            raise FileNotFoundError(
                f"asset not in {settings['paths']['graphics_dir']}: {pu.get('asset', '')!r}")
        art = Image.open(asset).convert("RGBA")
        target_w = int(float(pu.get("w", 0.34)) * W)
        ratio = target_w / art.width
        art = art.resize((target_w, int(art.height * ratio)), Image.LANCZOS)
        cx, cy = float(pu.get("x", 0.5)) * W, float(pu.get("y", 0.28)) * H
        img.alpha_composite(art, (int(cx - art.width / 2), int(cy - art.height / 2)))
    else:
        raise ValueError(f"unknown pop-up type: {kind}")


def _arrow(d, a, b, color, width):
    d.line([a, b], fill=color, width=width)
    ang = math.atan2(b[1] - a[1], b[0] - a[0])
    size = width * 3.2
    left = (b[0] - size * math.cos(ang - 0.45), b[1] - size * math.sin(ang - 0.45))
    right = (b[0] - size * math.cos(ang + 0.45), b[1] - size * math.sin(ang + 0.45))
    d.polygon([b, left, right], fill=color)
