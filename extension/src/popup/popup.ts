import { MARKLY_BASE_URL } from "../lib/config";
import { hasOriginPermission, requestOriginPermission } from "../lib/site-permissions";
import type { ExtensionMessage, TabState } from "../types/messages";

const MARKLY_ORIGIN = new URL(MARKLY_BASE_URL).origin;

/**
 * Plain DOM/TypeScript — no framework for one popup, one background
 * message, and a couple of small views. `detection.sourceTitle` and the
 * other adapter-produced strings ultimately come from a web page's DOM
 * (untrusted input, even for the controlled test reader), so every
 * dynamic value is escaped before being placed in the page — never
 * templated into innerHTML unescaped.
 */

const app = document.getElementById("app");
if (!app) throw new Error("popup root missing");

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function sendMessage<T>(message: ExtensionMessage): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function formatProgress(progress: { kind: string; value: number; season?: number }): string {
  switch (progress.kind) {
    case "season_episode":
      return progress.season !== undefined ? `Season ${progress.season}, Episode ${progress.value}` : `Episode ${progress.value}`;
    case "episode":
      return `Episode ${progress.value}`;
    case "chapter":
      return `Chapter ${progress.value}`;
    case "page":
      return `Page ${progress.value}`;
    case "percent":
      return `${progress.value}%`;
    case "playtime":
      return `${progress.value}h`;
    default:
      return `${progress.kind} ${progress.value}`;
  }
}

function connectErrorMessage(code: string | undefined): string {
  switch (code) {
    case "invalid_or_expired_code":
      return "That code is invalid or expired.";
    case "not_configured":
      return "Markly isn't reachable right now.";
    case "network_error":
      return "Couldn't reach Markly. Check that it's running.";
    default:
      return "Couldn't connect. Try again.";
  }
}

function renderDisconnected(errorText?: string) {
  if (!app) return;
  app.innerHTML = `
    <div class="brand"><span class="mark">M</span><span class="name">Markly</span></div>
    <p class="muted">Automatic progress tracking</p>
    <p class="status-disconnected">Not connected</p>
    <input type="text" id="code-input" placeholder="Enter pairing code" autocomplete="off" />
    <button id="connect-btn" type="button">Connect to Markly</button>
    ${errorText ? `<p class="error-text">${escapeHtml(errorText)}</p>` : ""}
  `;

  const button = document.getElementById("connect-btn");
  const input = document.getElementById("code-input") as HTMLInputElement | null;
  button?.addEventListener("click", () => onConnectClick(input, button as HTMLButtonElement));
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") onConnectClick(input, button as HTMLButtonElement);
  });
}

async function onConnectClick(input: HTMLInputElement | null, button: HTMLButtonElement | null) {
  const code = input?.value.trim();
  if (!code) return;

  if (button) {
    button.disabled = true;
    button.textContent = "Connecting…";
  }

  const result = await sendMessage<{ ok: boolean; error?: string }>({ type: "CONNECT", code });
  if (result.ok) {
    await renderConnected();
  } else {
    renderDisconnected(connectErrorMessage(result.error));
  }
}

interface StatusLine {
  text: string;
  /** Defaults to "tracked-ok" when omitted — see renderPageStatus. */
  className?: string;
  linkLabel?: string;
  /** Optional second line, e.g. auto-add's one-time "Tracking automatically" under "Added to Markly". */
  subtext?: string;
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/**
 * `result.autoLinked`/`result.autoAdded` are only ever true on the exact
 * request that just created a smart auto-link (Stage 18) or a Stage 22
 * auto-add — never again for later chapters from the same now-linked
 * source — so showing a distinct one-time line here naturally happens
 * only once per source, with no extra state to track in the popup.
 *
 * Stage 24 — takes the full TabState (not just the API result) because an
 * episode-kind ("video") detection needs a few more locally-known things
 * the result alone doesn't carry: `watchRatio` (this tab's current local
 * watch percentage — never sent to Markly, see completion.ts),
 * `playerStatus` (mid-search vs. genuinely exhausted — see the bugfix note
 * below), and `detection.progress.kind`, to phrase completion as "Episode
 * tracked" rather than the generic "Tracked" chapter-kind media uses.
 */
function statusLineFor(state: TabState): StatusLine {
  const { detection, result, watchRatio, playerStatus } = state;
  const isEpisode = detection?.progress.kind === "episode";

  switch (result.status) {
    case "detected": {
      // Stage 24 — a video discovery-only ping succeeded: identity
      // established (and possibly auto-linked/auto-added), but not
      // enough has been watched yet to commit progress.
      const addedPrefix = result.autoAdded ? "✓ Added to Markly" : undefined;
      if (watchRatio !== undefined) {
        const watching = `Watching · ${formatPercent(watchRatio)}`;
        return addedPrefix
          ? { text: addedPrefix, className: "tracked-ok", subtext: watching }
          : { text: watching, className: "muted" };
      }
      // Bugfix — distinguishes a normal, brief async-player-mount settling
      // window (playerStatus: "searching") from a genuinely exhausted
      // search (playerStatus: "unavailable", or absent for an older cached
      // state) — a real player that just hasn't rendered yet must never
      // look identical to one that structurally can't be observed at all
      // (see tracking/video/completion.ts's discoverPrimaryVideo).
      const subtext =
        playerStatus === "searching" ? "Finding video player…" : "Automatic completion tracking unavailable on this player.";
      return addedPrefix
        ? { text: addedPrefix, className: "tracked-ok", subtext }
        : { text: "Episode detected", className: "muted", subtext };
    }
    case "updated":
    case "unchanged":
      if (result.autoAdded) {
        return {
          text: "✓ Added to Markly",
          className: "tracked-ok",
          subtext: isEpisode ? "Episode tracked" : "Tracking automatically",
        };
      }
      if (result.autoLinked) {
        return { text: isEpisode ? "✓ Episode tracked automatically" : "✓ Tracked automatically" };
      }
      return { text: isEpisode ? "✓ Episode tracked" : "✓ Tracked" };
    case "behind_current_progress":
      return { text: "Already further along in Markly", className: "muted" };
    case "numbering_mismatch":
      // Stage 25 — this item already tracks absolute episode numbers; a
      // seasonal detection can't be applied to it without the user
      // deciding to switch it over (Edit Details in Markly), which this
      // popup deliberately never does automatically.
      return { text: "This item tracks episodes differently in Markly", className: "muted" };
    case "needs_link":
      return result.reason === "ambiguous"
        ? { text: "Multiple Markly items may match.", className: "muted", linkLabel: "Choose item" }
        : { text: "Not in your Markly library.", className: "muted", linkLabel: "Add or Link" };
    case "tracking_disabled":
      return { text: "Tracking disabled for this source", className: "muted" };
    case "incompatible_media_type":
    case "item_not_found":
      return { text: "This source needs to be relinked in Markly", className: "muted", linkLabel: "Link in Markly" };
    case "unauthorized":
      return { text: "Reconnect to Markly needed", className: "muted" };
    case "low_confidence":
      return { text: "Markly couldn't confidently detect progress on this page.", className: "muted" };
    case "server_error":
      // Distinct from "error" below: the request reached Markly and got a
      // real (non-2xx) response, so claiming Markly is unreachable would
      // be wrong — it demonstrably answered. The next detection retries
      // automatically; nothing for the user to do here.
      return { text: "Tracking update failed", className: "muted" };
    case "error":
    default:
      return { text: "Unable to reach Markly", className: "muted" };
  }
}

function renderPageStatus(state: TabState | null) {
  const statusEl = document.getElementById("page-status");
  if (!statusEl) return;

  if (!state) {
    statusEl.innerHTML = `<p class="muted">Unsupported page</p>`;
    return;
  }

  const { detection } = state;

  if (!detection) {
    // The content script ran but neither an adapter nor universal
    // detection could confidently identify progress here — distinct from
    // "unsupported page" (state above), which means the script never ran
    // at all.
    statusEl.innerHTML = `
      <p class="muted">${escapeHtml(statusLineFor(state).text)}</p>
      <p class="muted">No automatic update.</p>
    `;
    return;
  }

  const line = statusLineFor(state);
  const className = line.className ?? "tracked-ok";

  statusEl.innerHTML = `
    <p class="title">${escapeHtml(detection.sourceTitle)}</p>
    <p class="muted">${escapeHtml(formatProgress(detection.progress))}</p>
    <p class="${className}">${escapeHtml(line.text)}</p>
    ${line.subtext ? `<p class="muted">${escapeHtml(line.subtext)}</p>` : ""}
    ${line.linkLabel ? `<button id="link-btn" type="button" class="secondary">${escapeHtml(line.linkLabel)}</button>` : ""}
  `;

  document.getElementById("link-btn")?.addEventListener("click", () => {
    chrome.tabs.create({ url: `${MARKLY_BASE_URL}/settings/tracking` });
  });
}

/**
 * Site permission is a separate concept from pairing: being connected to
 * Markly says nothing about whether the extension may inspect *this*
 * site's pages (see extension/README.md "Site permission vs. source
 * mapping"). Requesting it must happen inside this click handler — a
 * genuine user gesture — or Chrome silently refuses the prompt.
 */
function renderSitePermissionPrompt(tabId: number, url: URL) {
  const statusEl = document.getElementById("page-status");
  if (!statusEl) return;

  statusEl.innerHTML = `
    <p class="title">${escapeHtml(url.hostname)}</p>
    <p class="muted">Tracking isn't enabled for this site.</p>
    <button id="enable-site-btn" type="button">Enable Tracking</button>
  `;

  document.getElementById("enable-site-btn")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    button.textContent = "Requesting…";

    const granted = await requestOriginPermission(url).catch(() => false);
    if (!granted) {
      renderSitePermissionPrompt(tabId, url);
      return;
    }

    // The page already finished loading before this grant existed, so
    // chrome.tabs.onUpdated won't fire again on its own — ask the service
    // worker to inject right now instead of waiting for the next
    // navigation.
    await sendMessage({ type: "INJECT_NOW", tabId });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const state = await sendMessage<TabState | null>({ type: "GET_TAB_STATUS", tabId });
    renderPageStatus(state);
  });
}

async function renderConnected() {
  if (!app) return;
  app.innerHTML = `
    <div class="brand"><span class="mark">M</span><span class="name">Markly</span></div>
    <p class="status-connected">Connected ✓</p>
    <div id="page-status" class="card"><p class="muted">Checking this page…</p></div>
    <button id="disconnect-btn" type="button" class="secondary">Disconnect</button>
    <button id="manage-sites-btn" type="button" class="secondary">Manage Sites</button>
  `;

  document.getElementById("disconnect-btn")?.addEventListener("click", async () => {
    await sendMessage({ type: "DISCONNECT" });
    renderDisconnected();
  });
  document.getElementById("manage-sites-btn")?.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  const tab = await getActiveTab();
  if (!tab?.id || !tab.url) {
    renderPageStatus(null);
    return;
  }

  let url: URL;
  try {
    url = new URL(tab.url);
  } catch {
    renderPageStatus(null);
    return;
  }

  // The Markly dev/test origin is always in scope (required
  // host_permissions); every other origin needs an explicit runtime
  // grant, checked here rather than assumed.
  if (url.origin !== MARKLY_ORIGIN) {
    const granted = await hasOriginPermission(url).catch(() => false);
    if (!granted) {
      renderSitePermissionPrompt(tab.id, url);
      return;
    }
  }

  const state = await sendMessage<TabState | null>({ type: "GET_TAB_STATUS", tabId: tab.id });
  renderPageStatus(state);
}

async function init() {
  const { connected } = await sendMessage<{ connected: boolean }>({ type: "GET_POPUP_STATE" });
  if (connected) {
    await renderConnected();
  } else {
    renderDisconnected();
  }
}

void init();
