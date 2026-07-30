"""shorts-factory bridge — a tiny local HTTP server that lets the ZTS Command
Center (the web app) see and drive the factory on this machine.

Zero dependencies beyond the Python standard library, on purpose: it runs
before `pip install -r requirements.txt`, survives any environment, and can't
break when a package updates. Start it from the factory directory:

    python bridge.py            # serves http://127.0.0.1:8765

The Pentagon's Studio tab auto-detects it. Works from the deployed
(https) app too: Chrome's Private Network Access preflight is answered with
Access-Control-Allow-Private-Network, and localhost is a trustworthy origin
so mixed content rules don't block it.

Security posture: binds 127.0.0.1 only — nothing off this machine can reach
it. Endpoints are read-only except `approve` (flips a flag in project.json,
same as `cli approve`) and `briefs` (writes a markdown brief into briefs/).
It never runs ffmpeg/whisper and can't trigger renders or spend API money.

Endpoints:
    GET  /health                     -> { ok, service, version, projects }
    GET  /projects                   -> [ { name, title, draft_version, approved_version,
                                            duration, has_final, has_review, package } ]
    GET  /projects/<name>/review     -> { markdown } (latest REVIEW_vN.md)
    POST /projects/<name>/approve    -> body: optional { version } — the draft
                                        the caller actually reviewed; refused
                                        with 409 if the project moved past it
                                        -> { ok, approved_version }
    POST /briefs                     -> body: brief JSON from The Pentagon;
                                        writes briefs/<date>_<slug>.md (+.json)
                                        -> { ok, path, cli }
"""
import datetime
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECTS = ROOT / "projects"
BRIEFS = ROOT / "briefs"
VERSION = "1.1"
PORT = 8765

# Only these browser origins may call the bridge. Reflecting from an allowlist
# (instead of Access-Control-Allow-Origin: *) means a random website open in
# the same browser can't read project scripts or drop briefs through the
# user's browser. Add origins here if the app moves.
ALLOWED_ORIGINS = {
    "https://the-pentagon.netlify.app",
    "http://localhost:5173", "http://localhost:5174", "http://localhost:5175",
    "http://127.0.0.1:5173", "http://127.0.0.1:5174", "http://127.0.0.1:5175",
}
# DNS-rebinding guard: the browser sends the Host it thinks it's talking to.
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}

SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")


def name_ok(name: str) -> bool:
    """Project-name guard: one path segment, no dot-only names ('.', '..')."""
    return bool(SAFE_NAME.match(name)) and name.strip(".") != ""


def slugify(text):
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:48] or "short"


def load_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return None


def project_summary(pdir: Path):
    state = load_json(pdir / "project.json") or {}
    drafts = sorted(pdir.glob("drafts/REVIEW_v*.md"))
    pkg = load_json(pdir / "work" / "package.json")
    return {
        "name": pdir.name,
        "title": pdir.name.split("_", 1)[-1].replace("-", " "),
        "draft_version": state.get("draft_version", 0),
        "approved_version": state.get("approved_version"),
        "duration": state.get("duration"),
        "has_final": (pdir / "final" / "final.mp4").exists(),
        "has_review": bool(drafts),
        # Only the lightweight, useful bits of the package for the panel.
        "package": {k: pkg[k] for k in ("titles", "description") if pkg and k in pkg} if pkg else None,
        "mtime": max((f.stat().st_mtime for f in pdir.glob("project.json")), default=0),
    }


def latest_review(pdir: Path):
    def ver(f):
        m = re.search(r"v(\d+)", f.name)
        return int(m.group(1)) if m else 0
    drafts = sorted(pdir.glob("drafts/REVIEW_v*.md"), key=ver)
    return drafts[-1].read_text(encoding="utf-8") if drafts else None


def write_brief(body: dict):
    BRIEFS.mkdir(exist_ok=True)
    slug = slugify(body.get("title") or body.get("topic"))
    stamp = datetime.date.today().isoformat()
    base = BRIEFS / f"{stamp}_{slug}"
    # Never overwrite an earlier brief from the same day.
    n, path = 1, base
    while (path.with_suffix(".md")).exists():
        n += 1
        path = Path(f"{base}-{n}")

    tags = body.get("tags") or []
    lines = [
        f"# Production brief — {body.get('title') or slug}",
        "",
        f"*Sent from The Pentagon · {datetime.datetime.now():%Y-%m-%d %H:%M}*",
        "",
        f"**Type:** {body.get('type', '—')}",
        f"**Topic:** {body.get('topic', '—')}",
        "",
        "## Hook (first 3 seconds)",
        body.get("hook") or "—",
        "",
        "## Script (read this on camera)",
        body.get("script") or "—",
        "",
        "## Packaging (already drafted — reuse or let the factory re-package)",
        f"**Title:** {body.get('title') or '—'}",
        f"**Description:** {body.get('description') or '—'}",
        f"**Tags:** {', '.join(tags) if tags else '—'}",
        f"**Pinned comment:** {body.get('pinned_comment') or '—'}",
        "",
        "## Next steps",
        "1. Film the script (see docs/SHOOTING_CHECKLIST.md).",
        f"2. `python -m pipeline.cli new \"{body.get('title') or slug}\" --video <footage.mp4>`",
        "3. `python -m pipeline.cli run <project>` → review the draft → approve → export.",
    ]
    path.with_suffix(".md").write_text("\n".join(lines), encoding="utf-8")
    path.with_suffix(".json").write_text(json.dumps(body, indent=2), encoding="utf-8")
    cli = f'python -m pipeline.cli new "{body.get("title") or slug}" --video <footage.mp4>'
    return {"ok": True, "path": str(path.with_suffix(".md").relative_to(ROOT)), "cli": cli}


class Handler(BaseHTTPRequestHandler):
    server_version = "shorts-factory-bridge/" + VERSION

    def _guard(self) -> bool:
        """Host + Origin checks. Returns False (and responds 403) if blocked.

        Host must be a localhost form of this port (blocks DNS rebinding).
        Origin, when present (all browser requests), must be allowlisted —
        curl/scripts without an Origin header are local tools and pass.
        """
        host = (self.headers.get("Host") or "").strip()
        if host not in ALLOWED_HOSTS:
            self._send(403, {"ok": False, "error": "bad host"})
            return False
        origin = self.headers.get("Origin")
        if origin and origin not in ALLOWED_ORIGINS:
            self._send(403, {"ok": False, "error": "origin not allowed"})
            return False
        return True

    def _send(self, code, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _cors(self):
        origin = self.headers.get("Origin")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            # Chrome Private Network Access: lets the deployed (public https)
            # app reach this local server after preflight.
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        if not self._guard():
            return
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if not self._guard():
            return
        parts = [p for p in self.path.split("?")[0].split("/") if p]
        if parts == ["health"]:
            count = len([d for d in PROJECTS.glob("*") if d.is_dir()]) if PROJECTS.exists() else 0
            return self._send(200, {"ok": True, "service": "shorts-factory-bridge",
                                    "version": VERSION, "projects": count})
        if parts == ["projects"]:
            dirs = [d for d in PROJECTS.glob("*") if d.is_dir() and (d / "project.json").exists()] \
                if PROJECTS.exists() else []
            out = sorted((project_summary(d) for d in dirs),
                         key=lambda s: s["mtime"], reverse=True)
            return self._send(200, out)
        if len(parts) == 3 and parts[0] == "projects" and parts[2] == "review":
            name = parts[1]
            if not name_ok(name):
                return self._send(400, {"ok": False, "error": "bad project name"})
            pdir = PROJECTS / name
            if not pdir.is_dir():
                return self._send(404, {"ok": False, "error": "project not found"})
            md = latest_review(pdir)
            if md is None:
                return self._send(404, {"ok": False, "error": "no review yet — run the pipeline"})
            return self._send(200, {"ok": True, "markdown": md})
        return self._send(404, {"ok": False, "error": "unknown endpoint"})

    def do_POST(self):
        if not self._guard():
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > 256 * 1024:
            return self._send(413, {"ok": False, "error": "body too large"})
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._send(400, {"ok": False, "error": "invalid JSON"})
        if not isinstance(body, dict):
            return self._send(400, {"ok": False, "error": "body must be a JSON object"})

        parts = [p for p in self.path.split("?")[0].split("/") if p]
        if parts == ["briefs"]:
            return self._send(200, write_brief(body))
        if len(parts) == 3 and parts[0] == "projects" and parts[2] == "approve":
            name = parts[1]
            if not name_ok(name):
                return self._send(400, {"ok": False, "error": "bad project name"})
            pdir = PROJECTS / name
            state_file = pdir / "project.json"
            if not state_file.exists():
                return self._send(404, {"ok": False, "error": "project not found"})
            state = load_json(state_file) or {}
            v = state.get("draft_version", 0)
            if not v:
                return self._send(409, {"ok": False, "error": "no draft to approve yet"})
            # The client's project list is a 15s-old snapshot and its review
            # modal holds an older one still, so "Approve draft v1" could land
            # after a `revise` in a terminal bumped the project to v2 and
            # approve a draft nobody watched — which then exports. When the
            # caller tells us which draft it was looking at, hold it to that.
            claimed = body.get("version")
            if claimed is not None and claimed != v:
                return self._send(409, {"ok": False, "draft_version": v,
                                        "error": f"draft moved on to v{v} while you were "
                                                 f"reviewing v{claimed} — reload and re-watch"})
            state["approved_version"] = v
            state_file.write_text(json.dumps(state, indent=2), encoding="utf-8")
            return self._send(200, {"ok": True, "approved_version": v})
        return self._send(404, {"ok": False, "error": "unknown endpoint"})

    def log_message(self, fmt, *args):  # quiet: one line per request, no noise
        print(f"  {self.command} {self.path} -> {args[1] if len(args) > 1 else ''}")


if __name__ == "__main__":
    print(f"shorts-factory bridge v{VERSION}")
    print(f"  root:     {ROOT}")
    print(f"  serving:  http://127.0.0.1:{PORT}")
    print("  The Pentagon's Studio tab will find it automatically.\n")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
