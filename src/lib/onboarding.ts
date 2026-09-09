/**
 * Stage 35 — pure first-run/activation decision logic. Kept separate from
 * any component specifically so the decision itself (not just its
 * rendering) is deterministically testable — see
 * scripts/verify-onboarding-experience.mjs.
 *
 * Stage 35 (final audit) — the very first version of this module derived
 * both the first-run Dashboard hero AND the Auto Tracking nudge from
 * `itemCount === 1` alone. That's wrong on two counts a raw item count can
 * never fix:
 *   1. A long-time user who deletes their library down to exactly one item
 *      would incorrectly see first-run guidance again.
 *   2. A pre-existing user upgrading to this version with exactly one item
 *      already in their library would incorrectly receive first-run
 *      guidance despite never having gone through the new-user flow at
 *      all.
 * Both are now driven by a persisted, sticky "has this browser ever seen
 * this library non-empty" flag (`hasEverHadLibraryItems`) instead —
 * itemCount is only ever used to decide what's happening *right now*, the
 * persisted flag is what remembers history across reloads and item-count
 * fluctuations.
 *
 * Stage 35 (global consistency fix) — two further corrections:
 *   1. Eligibility for the Auto Tracking nudge used to be derived from
 *      each page's OWN "was I just in the onboarding state" tracking,
 *      which meant activating via Library's empty-state CTA (instead of
 *      Dashboard's) never made the nudge eligible. See
 *      hooks/useLibraryActivation.ts — that tracking is now one shared,
 *      page-independent hook both pages call, keyed on "has this session
 *      confirmed the library empty at least once," not on which page's
 *      React state happened to be in.
 *   2. The original flat, single-version storage shape had no migration
 *      path: a future version bump would have fallen through
 *      isOnboardingStorageShape's strict version check and silently wiped
 *      the sticky hasEverHadLibraryItems bit, turning a returning empty
 *      user back into a "new" one. Storage is now split into `activation`
 *      (the one monotonic historical fact) and `preferences` (ordinary
 *      resettable UI state), with an explicit migration step for the
 *      prior flat shape — see the storage section below.
 */

export type ActivationState = "loading" | "populated" | "error" | "import-pending" | "onboarding" | "empty-returning";

export interface ActivationStateInput {
  /** True while the library itself is still being fetched. Matches the existing DashboardView/LibraryView convention: cloud mode is a real network round trip and needs this; local mode's synchronous localStorage read never sets it. Callers should also fold in their own onboarding-storage hydration here (see useOnboarding's `isHydrated`) so a not-yet-read `hasEverHadLibraryItems` can never be mistaken for "definitely false." */
  loading: boolean;
  /** True if loading the library (or anything a page's content depends on) failed. */
  loadError: boolean;
  /** The user's actual library size — real state, never estimated or cached separately. */
  itemCount: number;
  /** True whenever this device has local-only items not yet imported into the signed-in account (see useLocalImport's hasPendingImport) — independent of whether the import banner itself has been dismissed. */
  pendingLocalImport: boolean;
  /** True once this browser has ever observed the library non-empty (see markLibraryActivated below) — sticky, never unset by a later deletion. This is what actually distinguishes "genuinely new" from "returning user who happens to be at zero/one item right now." */
  hasEverHadLibraryItems: boolean;
}

/**
 * Priority, in order:
 * 1. loading — never flash any empty/onboarding state before real data
 *    (library AND onboarding-history storage) resolves.
 * 2. populated (itemCount > 0) — real content always wins, even alongside
 *    a secondary error (e.g. activity summary failed but the library
 *    itself loaded fine); per-section error handling already covers that
 *    narrower case, so this function doesn't need to.
 * 3. error (empty AND failed) — an empty result caused by a failed fetch
 *    must never be presented as "this library is genuinely empty."
 * 4. import-pending (empty, no error, but this device has local data
 *    waiting to sync) — a brand-new-looking "Add your first item" hero
 *    would be misleading when this device actually has data waiting; the
 *    import banner (rendered independently) already surfaces the actual
 *    affordance.
 * 5. empty-returning (empty, but this browser has seen this library
 *    non-empty before) — a returning user who deleted everything back to
 *    zero is not a new user; showing the first-run hero again would be
 *    exactly the reactivation bug this round fixes.
 * 6. onboarding — genuinely new: empty, no error, nothing pending, and
 *    this browser has never once seen the library non-empty.
 */
export function resolveActivationState({
  loading,
  loadError,
  itemCount,
  pendingLocalImport,
  hasEverHadLibraryItems,
}: ActivationStateInput): ActivationState {
  if (loading) return "loading";
  if (itemCount > 0) return "populated";
  if (loadError) return "error";
  if (pendingLocalImport) return "import-pending";
  if (hasEverHadLibraryItems) return "empty-returning";
  return "onboarding";
}

// ============================================================
// Storage — versioned, namespaced, migratable. Purely presentation state:
// local-only, never part of the Stage 29 backup format, never synced
// across devices.
//
// Two kinds of state live here, deliberately kept in separate sub-objects
// because they have different safety requirements on a version bump:
//   - `activation`: a monotonic HISTORICAL FACT ("has this browser ever
//     seen this library non-empty"). Once true, must never revert to
//     false except when it genuinely cannot be known (storage never
//     existed, or is corrupt/unparseable/unrecognized-future-version).
//     Losing this bit re-triggers the first-run hero for a returning
//     user, which is the exact bug this whole round exists to prevent —
//     so it gets carried forward through every recognized migration.
//   - `preferences`: ordinary resettable UI state (nudge dismissed/
//     eligible). Lower stakes if reset on a version bump — worst case a
//     dismissed nudge or an already-earned eligibility replays once more.
// ============================================================

const ONBOARDING_STORAGE_KEY = "markly.onboarding";
const ONBOARDING_STORAGE_VERSION = 2;

interface OnboardingActivation {
  hasEverHadLibraryItems: boolean;
}

interface OnboardingPreferences {
  autoTrackingNudgeDismissed: boolean;
  autoTrackingNudgeEligible: boolean;
}

interface OnboardingStorageV2 {
  version: 2;
  activation: OnboardingActivation;
  preferences: OnboardingPreferences;
}

/** The one prior shape this module has ever actually written (Stage 35's first pass) — flat, single-version, no migration path. Kept here solely as a known migration source, never written again. */
interface OnboardingStorageV1 {
  version: 1;
  autoTrackingNudgeDismissed: boolean;
  hasEverHadLibraryItems: boolean;
  autoTrackingNudgeEligible: boolean;
}

/** The flat, page-facing shape every caller (useOnboarding, resolveActivationState's callers) actually works with — the version/sub-object split is an internal storage-migration detail, not something every call site needs to know about. */
export interface OnboardingState {
  hasEverHadLibraryItems: boolean;
  autoTrackingNudgeDismissed: boolean;
  autoTrackingNudgeEligible: boolean;
}

const DEFAULT_ONBOARDING_STATE: OnboardingState = {
  hasEverHadLibraryItems: false,
  autoTrackingNudgeDismissed: false,
  autoTrackingNudgeEligible: false,
};

function toStorageV2(state: OnboardingState): OnboardingStorageV2 {
  return {
    version: ONBOARDING_STORAGE_VERSION,
    activation: { hasEverHadLibraryItems: state.hasEverHadLibraryItems },
    preferences: { autoTrackingNudgeDismissed: state.autoTrackingNudgeDismissed, autoTrackingNudgeEligible: state.autoTrackingNudgeEligible },
  };
}

function fromStorageV2(stored: OnboardingStorageV2): OnboardingState {
  return {
    hasEverHadLibraryItems: stored.activation.hasEverHadLibraryItems,
    autoTrackingNudgeDismissed: stored.preferences.autoTrackingNudgeDismissed,
    autoTrackingNudgeEligible: stored.preferences.autoTrackingNudgeEligible,
  };
}

function isOnboardingStorageV1(value: unknown): value is OnboardingStorageV1 {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.autoTrackingNudgeDismissed === "boolean" &&
    typeof v.hasEverHadLibraryItems === "boolean" &&
    typeof v.autoTrackingNudgeEligible === "boolean"
  );
}

function isOnboardingStorageV2(value: unknown): value is OnboardingStorageV2 {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 2) return false;
  const activation = v.activation as Record<string, unknown> | undefined;
  const preferences = v.preferences as Record<string, unknown> | undefined;
  return (
    !!activation &&
    typeof activation === "object" &&
    typeof activation.hasEverHadLibraryItems === "boolean" &&
    !!preferences &&
    typeof preferences === "object" &&
    typeof preferences.autoTrackingNudgeDismissed === "boolean" &&
    typeof preferences.autoTrackingNudgeEligible === "boolean"
  );
}

/**
 * Recognized-old-version -> current-version migration. The sticky
 * `hasEverHadLibraryItems` fact is always carried forward exactly — this
 * is the one field a version bump must never casually lose. The
 * preference fields are carried forward too here (there's no reason to
 * discard data we can actually read), but per the module's own policy
 * they'd be allowed to safely default instead if a future migration
 * genuinely couldn't map them.
 */
function migrateFromV1(v1: OnboardingStorageV1): OnboardingState {
  return {
    hasEverHadLibraryItems: v1.hasEverHadLibraryItems,
    autoTrackingNudgeDismissed: v1.autoTrackingNudgeDismissed,
    autoTrackingNudgeEligible: v1.autoTrackingNudgeEligible,
  };
}

/**
 * Reads and, if necessary, migrates the persisted onboarding state.
 * Distinguishes four cases, per this round's audit:
 *   1. Normal version upgrade with a recognized older shape underneath
 *      (today: v1) -> migrates forward, activation history preserved
 *      exactly, and immediately re-persists in the current shape so
 *      later reads don't need to migrate again.
 *   2. Current-version, fully valid data -> used as-is.
 *   3. Nothing stored yet (key never written) -> the default state. This
 *      is NOT data loss — there is no history to lose.
 *   4. Corrupt JSON, an unrecognized/future version, or a
 *      deliberately-cleared localStorage -> falls back to the default
 *      state. These are NOT distinguishable from each other at read
 *      time, and that's an honest limitation, not a bug: once the only
 *      durable record of "has this browser had items before" is gone or
 *      unreadable, there is no way to recover that fact, by design or
 *      otherwise. This module does not attempt to invent history it
 *      cannot know. (A previous draft of this report claimed corruption
 *      "self-heals" for a returning empty user — that's wrong; it only
 *      self-heals in the sense that the very next real item this browser
 *      gets will correctly re-mark history going forward. The returning
 *      user could see the first-run hero exactly once in the meantime.)
 */
export function readOnboardingStorage(): OnboardingState {
  try {
    const raw = localStorage.getItem(ONBOARDING_STORAGE_KEY);
    if (!raw) return DEFAULT_ONBOARDING_STATE; // case 3 — nothing to recover, not an error

    const parsed: unknown = JSON.parse(raw);

    if (isOnboardingStorageV2(parsed)) return fromStorageV2(parsed); // case 2

    if (isOnboardingStorageV1(parsed)) {
      // case 1 — migrate forward and persist immediately so subsequent
      // reads see current-version data directly.
      const migrated = migrateFromV1(parsed);
      persistOnboardingState(migrated);
      return migrated;
    }

    // case 4a — parseable JSON, but neither a recognized current nor a
    // recognized prior shape (a genuinely future/unknown version, or
    // corrupted-but-still-valid-JSON data). Cannot know this browser's
    // real activation history; fails safe rather than guessing.
    return DEFAULT_ONBOARDING_STATE;
  } catch {
    // case 4b — JSON.parse threw, or localStorage itself is inaccessible
    // (private mode, disabled storage, or the value was hand-mangled
    // into invalid JSON). Same "cannot know" outcome as 4a.
    return DEFAULT_ONBOARDING_STATE;
  }
}

function persistOnboardingState(state: OnboardingState): void {
  try {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(toStorageV2(state)));
  } catch {
    // Best-effort only — worst case the preference doesn't survive a reload.
  }
}

export function persistAutoTrackingNudgeDismissed(): OnboardingState {
  const next = { ...readOnboardingStorage(), autoTrackingNudgeDismissed: true };
  persistOnboardingState(next);
  return next;
}

/**
 * The one place `hasEverHadLibraryItems`/`autoTrackingNudgeEligible` ever
 * get set. Called whenever the caller observes itemCount > 0 and the
 * stored history doesn't already reflect that (see
 * hooks/useLibraryActivation.ts — the single, page-independent tracker
 * both Dashboard and Library use, so which page a user first activates
 * from no longer matters). `justCompletedFirstRun` must be true ONLY when
 * this session actually confirmed the library empty before this item
 * appeared — the caller is responsible for tracking that transition (a
 * raw itemCount comparison can't distinguish "just activated" from
 * "already had items"), which is why this function takes it as an
 * explicit flag rather than inferring it.
 */
export function markLibraryActivated(justCompletedFirstRun: boolean): OnboardingState {
  const current = readOnboardingStorage();
  // Once hasEverHadLibraryItems is true, nothing this function could write
  // ever needs to change again: autoTrackingNudgeEligible can only ever
  // become true in the same transition that first flips
  // hasEverHadLibraryItems from false to true — a later call with it
  // already true is always a no-op.
  if (current.hasEverHadLibraryItems) return current;

  const next: OnboardingState = {
    ...current,
    hasEverHadLibraryItems: true,
    autoTrackingNudgeEligible: justCompletedFirstRun,
  };
  persistOnboardingState(next);
  return next;
}

/**
 * The Auto Tracking nudge represents "you just activated Markly for the
 * first time," not "your library currently has one item" — `eligible`
 * (set only by a genuine first-run transition, see markLibraryActivated)
 * is what enforces that. `itemCount === 1` on top of it keeps the nudge
 * feeling contextual/temporary rather than permanent Dashboard chrome —
 * it quietly stops appearing once a second item exists, same as before,
 * but can never be *triggered* by raw count alone anymore. Gated off
 * entirely for a signed-out session (extension pairing is cloud-only —
 * showing "Connect extension" would be a dead end) and when the extension
 * is already in use (a tracking source already exists for this account).
 */
export function shouldShowAutoTrackingNudge({
  itemCount,
  eligible,
  dismissed,
  isSignedIn,
  extensionAlreadyConnected,
}: {
  itemCount: number;
  eligible: boolean;
  dismissed: boolean;
  isSignedIn: boolean;
  extensionAlreadyConnected: boolean;
}): boolean {
  if (!isSignedIn || extensionAlreadyConnected || dismissed || !eligible) return false;
  return itemCount === 1;
}
