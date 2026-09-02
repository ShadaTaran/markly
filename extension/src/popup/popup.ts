import { MARKLY_BASE_URL } from "../lib/config";
import type { ExtensionMessage, TabState } from "../types/messages";
import type { ProgressApiResult } from "../lib/api";

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

function formatProgress(progress: { kind: string; value: number }): string {
  switch (progress.kind) {
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
}

/**
 * `result.autoLinked` is only ever true on the exact request that just
 * created a smart auto-link (see route.ts's POST /api/extension/progress)
 * — never again for later chapters from the same now-linked source — so
 * showing a distinct "tracked automatically" line here naturally happens
 * only once per source, with no extra state to track in the popup.
 */
function statusLineFor(result: ProgressApiResult): StatusLine {
  switch (result.status) {
    case "updated":
    case "unchanged":
      return result.autoLinked
        ? { text: "✓ Tracked automatically" }
        : { text: "✓ Tracked" };
    case "behind_current_progress":
      return { text: "Already further along in Markly", className: "muted" };
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

  const { detection, result } = state;
  const line = statusLineFor(result);
  const className = line.className ?? "tracked-ok";

  statusEl.innerHTML = `
    <p class="title">${escapeHtml(detection.sourceTitle)}</p>
    <p class="muted">${escapeHtml(formatProgress(detection.progress))}</p>
    <p class="${className}">${escapeHtml(line.text)}</p>
    ${line.linkLabel ? `<button id="link-btn" type="button" class="secondary">${escapeHtml(line.linkLabel)}</button>` : ""}
  `;

  document.getElementById("link-btn")?.addEventListener("click", () => {
    chrome.tabs.create({ url: `${MARKLY_BASE_URL}/settings/tracking` });
  });
}

async function renderConnected() {
  if (!app) return;
  app.innerHTML = `
    <div class="brand"><span class="mark">M</span><span class="name">Markly</span></div>
    <p class="status-connected">Connected ✓</p>
    <div id="page-status" class="card"><p class="muted">Checking this page…</p></div>
    <button id="disconnect-btn" type="button" class="secondary">Disconnect</button>
  `;

  document.getElementById("disconnect-btn")?.addEventListener("click", async () => {
    await sendMessage({ type: "DISCONNECT" });
    renderDisconnected();
  });

  const tab = await getActiveTab();
  if (!tab?.id) {
    renderPageStatus(null);
    return;
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
