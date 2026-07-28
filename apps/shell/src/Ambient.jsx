// ─── The ambient canvas ───────────────────────────────────────────────────────
// One fixed layer, rendered once by the shell, behind every tool. It is
// decoration in the strictest sense: aria-hidden, pointer-events: none, no
// state, no listeners, no measurement. Everything it does lives in
// @cc/design/ambient.css.
//
// It has no props because it needs none: the wash is built from var(--accent),
// and the shell already stamps the active tool's accent on the wrapper this
// mounts inside. Switching tools re-colours it for free — and cross-fades,
// because ambient.css registers its pool colours with @property so they are
// animatable. That is the whole trick.
//
// Three pools and nothing else. The grain is .ambient::after, not a fourth
// element — profiled in the Board Room app, where a fourth box pushed the
// stack past the point where the pools stayed composited and doubled frame
// time, for something that never moves. Don't add a box here.

export function Ambient() {
  return (
    <div className="ambient" aria-hidden="true">
      <span className="amb-pool amb-1" />
      <span className="amb-pool amb-2" />
      <span className="amb-pool amb-3" />
    </div>
  );
}
