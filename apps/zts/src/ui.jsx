// ═══════════════════════════════════════════════════════════════════════════
// ZTS UI — a re-export of @cc/ui.
//
// This file used to hold 318 lines that were a copy of the shared primitives:
// 266 of them byte-identical to packages/ui/index.jsx, and Clarify held a third
// copy of the same code. Three implementations of one toast provider is three
// places for a fix to land in two of.
//
// The five ZTS modules that import from here keep importing from here — the
// specifier is unchanged and the components are now the shared ones, so a
// change to the platform's feel reaches ZTS without a second edit.
//
// The one behavioural difference is an improvement: the local EmptyState
// defaulted its tint to ZTS's hardcoded green, while @cc/ui's resolves
// var(--accent) — which IS ZTS green under the ZTS wrapper, and the correct
// accent everywhere else. A component that only looked right in one tool was
// the reason the copies existed.
//
// App-specific pieces belong in theme.js, not here.
// ═══════════════════════════════════════════════════════════════════════════
export {
  AnimatedNumber, Num, useTween,
  SkeletonLine, SkeletonBlock, SkeletonCard, SkeletonRows, SkeletonBoard, SkPage,
  SkLine, SkCard, SkBoard,
  EmptyIcon, EmptyState, ErrorState, Expand,
  ToastProvider, useToast, CommandPalette,
  useIsMobile, M,
} from "@cc/ui";
