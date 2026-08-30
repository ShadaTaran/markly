"use client";

import { useEffect, useState } from "react";
import { MoonIcon, SunIcon } from "@/components/icons";

const THEME_STORAGE_KEY = "markly.theme";

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

  function toggleTheme() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage unavailable; the theme still applies for this session.
    }
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
