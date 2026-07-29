// SYNC's glyph — two opposed arcs around a core, the orb reduced to line art.
//
// It used to live in Boot.jsx, next to the standalone app's startup animation.
// The shell renders its own boot state before any tool mounts, so that screen
// is gone; the mark survives because onboarding still wants a face.

export function Mark({ size = 22, tone = "var(--accent)" }) {
  const r = 8.4;
  const dash = `${Math.PI * r * 0.42} ${Math.PI * 2 * r}`;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r={r} stroke={tone} strokeWidth="1.9" strokeLinecap="round" strokeDasharray={dash} />
      <circle cx="12" cy="12" r={r} stroke={tone} strokeWidth="1.9" strokeLinecap="round" strokeDasharray={dash} transform="rotate(180 12 12)" />
      <circle cx="12" cy="12" r="2.4" fill={tone} />
    </svg>
  );
}

export default Mark;
