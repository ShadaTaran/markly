/**
 * Stage 38 §11/§14/§15 — a small, pure, testable install-state model.
 * Every signal is real capability/display-mode/event evidence, never a
 * broad user-agent guess (same convention as lib/push/capability.ts) — with
 * one narrow, deliberate exception: `isIOSPlatform()` below. There is no
 * feature-detectable way to know "this browser will only ever offer manual
 * Add to Home Screen" ahead of time — `beforeinstallprompt` doesn't exist on
 * iOS today, so the only honest way to show correct Share -> Add to Home
 * Screen instructions is to check the platform, exactly as Stage 38 §15
 * itself authorizes ("use the minimum platform detection required to
 * present valid instructions"). Browser capabilities and Add to Home
 * Screen's exact behavior vary by browser, OS version, and region — the
 * platform check only decides which instructions to show, not a promise
 * that every browser on it behaves identically.
 *
 * Current Chrome/web.dev installability criteria (re-verified live — see
 * the Stage 38 correction reports) do not require a service worker at all,
 * for either menu-based install or `beforeinstallprompt`. This model
 * therefore has no service-worker dependency of any kind — not
 * registration state, not even bare API support. ServiceWorker capability
 * stays relevant only to Stage 37 Web Push (see lib/push/capability.ts's
 * own, separate detectPushCapability()), never to whether Markly is
 * installable.
 */

export type InstallState = "browser-installable" | "ios-manual-install" | "already-installed" | "not-currently-installable";

export interface InstallStateInputs {
  isStandaloneDisplayMode: boolean;
  isIOSStandaloneFlag: boolean;
  isIOSPlatform: boolean;
  hasDeferredInstallPrompt: boolean;
}

/**
 * No "unsupported" state: once ServiceWorker support is removed as a
 * signal, there is nothing left to distinguish a genuinely-unsupported
 * browser from one that simply hasn't offered an install prompt yet (Stage
 * 38 correction §1) — collapsing that distinction into
 * "not-currently-installable" is the honest choice, not a regression.
 */
export function resolveInstallState(inputs: InstallStateInputs): InstallState {
  if (inputs.isStandaloneDisplayMode || inputs.isIOSStandaloneFlag) return "already-installed";
  if (inputs.isIOSPlatform) return "ios-manual-install";
  if (inputs.hasDeferredInstallPrompt) return "browser-installable";
  return "not-currently-installable";
}

export function isStandaloneDisplayMode(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
}

/** iOS Safari's own legacy flag — still the only signal it exposes for "launched from Home Screen," predating the standard display-mode media query. */
export function isIOSStandaloneFlag(): boolean {
  return typeof navigator !== "undefined" && (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/**
 * iPhone/iPod report normally in the UA string. iPadOS 13+ deliberately
 * reports as a desktop Mac (`navigator.platform === "MacIntel"`) to get
 * desktop-class layouts by default — the standard, widely-used
 * disambiguator is a real Mac never reporting touch points, so pairing the
 * "MacIntel" platform with `maxTouchPoints > 1` reliably means iPadOS, not
 * macOS.
 */
export function isIOSPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}
