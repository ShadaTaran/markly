"use client";

import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { MoonIcon, SunIcon } from "@/components/icons";

const THEME_STORAGE_KEY = "markly.theme";
const REVEAL_DURATION_MS = 500;
const REVEAL_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";

type Theme = "light" | "dark";

export function ThemeToggle() {
  // Deterministic default matches the server-rendered markup and the
  // `data-theme="light"` fallback on <html>, so there's no hydration
  // mismatch. The effect below then syncs in whatever the inline head
  // script (see layout.tsx) already resolved before first paint.
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    if (current === "light" || current === "dark") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time sync from the DOM attribute the inline head script already set before paint; it can't be read during render since it isn't available at SSR/prerender time.
      setTheme(current);
    }
  }, []);

  function applyTheme(next: Theme) {
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage unavailable; the theme still applies for this session.
    }
  }

  function toggleTheme(event: React.MouseEvent<HTMLButtonElement>) {
    const next: Theme = theme === "dark" ? "light" : "dark";

    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    // Only pointer/keyboard activations that resolve to this button reach
    // here, so its own center is a stable, deterministic reveal origin
    // regardless of how the click was triggered.
    const { left, top, width, height } = event.currentTarget.getBoundingClientRect();
    const originX = left + width / 2;
    const originY = top + height / 2;

    if (prefersReducedMotion || typeof document.startViewTransition !== "function") {
      applyTheme(next);
      return;
    }

    // The circle only needs to grow as far as the furthest viewport
    // corner from the button to be guaranteed to cover the whole screen.
    const endRadius = Math.hypot(
      Math.max(originX, window.innerWidth - originX),
      Math.max(originY, window.innerHeight - originY),
    );

    const transition = document.startViewTransition(() => {
      // View Transitions snapshots the DOM right after this callback
      // returns, so the theme change (including the icon swap) must be
      // committed synchronously rather than left as a pending React update.
      flushSync(() => applyTheme(next));
    });

    transition.ready
      .then(() => {
        document.documentElement.animate(
          {
            clipPath: [
              `circle(0px at ${originX}px ${originY}px)`,
              `circle(${endRadius}px at ${originX}px ${originY}px)`,
            ],
          },
          {
            duration: REVEAL_DURATION_MS,
            easing: REVEAL_EASING,
            pseudoElement: "::view-transition-new(root)",
          },
        );
      })
      .catch(() => {
        // The transition can be skipped (e.g. the browser tab lost
        // visibility). The theme itself has already been applied above,
        // so there's nothing further to do.
      });
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      className="flex shrink-0 items-center justify-center rounded-md border border-border p-2 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      {theme === "dark" ? (
        <SunIcon width={16} height={16} />
      ) : (
        <MoonIcon width={16} height={16} />
      )}
    </button>
  );
}
