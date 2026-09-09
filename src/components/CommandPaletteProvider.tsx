"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { CommandPalette } from "@/components/CommandPalette";

interface CommandPaletteContextValue {
  open: () => void;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

/** Any page's header (or anywhere else) can call this to open the palette — see Header.tsx/SecondaryPageHeader.tsx's search button. */
export function useCommandPalette(): CommandPaletteContextValue {
  const context = useContext(CommandPaletteContext);
  if (!context) throw new Error("useCommandPalette must be used within CommandPaletteProvider");
  return context;
}

/**
 * Stage 36 — mounted exactly once, at the root layout (see app/layout.tsx),
 * inside AuthProvider. This is the "narrowest shared application layer"
 * that can receive the global Ctrl/Cmd+K shortcut, reach auth state, and
 * guarantee there is only ever one active palette instance — Header and
 * SecondaryPageHeader are recreated per page, so state living there would
 * reset on every navigation; the actual page tree only ever renders one of
 * them at a time anyway, but anchoring here avoids relying on that.
 *
 * Critically, this component itself is cheap: it owns only a boolean and
 * a keydown listener. The expensive part — CommandPalette's own
 * useLibraryItems/useActivity calls — only ever mounts while `isOpen` is
 * true (conditional rendering below), so no page pays any extra fetch
 * cost merely because this provider exists (Stage 36 §4/§5).
 */
export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const open = useCallback(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    // Deferred (setTimeout, not requestAnimationFrame — rAF can be
    // throttled/never fire in a backgrounded/hidden tab) rather than
    // called synchronously here: closing while the "Add Item" command's
    // own LibraryItemDialog is open unmounts both it and the palette's
    // search input in the same commit, and Dialog.tsx's own focus-
    // restoration cleanup effect (which captured whatever was focused
    // when IT opened — by then, the search input had already been
    // removed from the DOM, so the browser had already moved focus to
    // <body>) runs after this synchronous call and would otherwise
    // clobber it. Deferring guarantees this is the last word on where
    // focus lands.
    setTimeout(() => previouslyFocusedRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // Stage 36 §1 — Ctrl+K (Windows/Linux) or Cmd+K (macOS) only, never
      // plain "k", and never while an IME composition is in progress
      // (event.isComposing) so an unrelated keystroke during CJK/other
      // composed input can't accidentally trigger this.
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k" || event.isComposing) return;
      event.preventDefault();
      if (isOpen) {
        close();
      } else {
        open();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, open, close]);

  return (
    <CommandPaletteContext.Provider value={{ open }}>
      {children}
      {isOpen && <CommandPalette onClose={close} />}
    </CommandPaletteContext.Provider>
  );
}
