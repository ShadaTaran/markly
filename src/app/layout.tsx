import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AuthProvider } from "@/components/AuthProvider";
import { CommandPaletteProvider } from "@/components/CommandPaletteProvider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Markly — Bookmark Manager",
  description:
    "A modern bookmark manager for organizing, searching, and managing your favorite websites.",
  appleWebApp: {
    title: "Markly",
    // "default" (not "black-translucent") deliberately: a translucent
    // status bar draws content underneath it, which would require adding
    // env(safe-area-inset-top) padding somewhere. Markly has no fixed/
    // sticky header competing with that space, so there is no real product
    // reason to take on that complexity (Stage 38 §22/§26).
    statusBarStyle: "default",
  },
};

/**
 * Stage 38 §26 — `theme-color` only reacts to the OS-level
 * `prefers-color-scheme`, not Markly's own in-app manual theme toggle
 * (persisted separately in localStorage, see THEME_INIT_SCRIPT below). A
 * user whose OS is in light mode but who manually switched Markly to dark
 * will see the light theme-color in browser chrome / the Android install
 * splash — a real, documented platform limitation of the `theme-color`
 * mechanism, not something a static manifest/meta value can resolve.
 * Rewriting the meta tag from JS on every toggle would fix that narrow
 * mismatch but was deliberately not done here, in favor of the simpler,
 * fully standards-based two-value form.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#3b82f6" },
    { media: "(prefers-color-scheme: dark)", color: "#60a5fa" },
  ],
};

const THEME_INIT_SCRIPT = `(function(){try{var stored=localStorage.getItem("markly.theme");var theme=stored==="light"||stored==="dark"?stored:(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.setAttribute("data-theme",theme)}catch(e){}})()`;

// React warns when rendering a <script> tag on the client (it won't
// execute there), even though this one only needs to run once during the
// initial server-rendered HTML's parsing. Swapping the `type` per-environment
// avoids that dev warning without changing behavior.
function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      data-theme="light"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <InlineScript html={THEME_INIT_SCRIPT} />
      </head>
      <body className="min-h-full flex flex-col">
        <AuthProvider>
          <CommandPaletteProvider>{children}</CommandPaletteProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
