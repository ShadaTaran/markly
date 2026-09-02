import { MARKLY_BASE_URL } from "../lib/config";
import { listGrantedOriginPatterns, revokeOriginPermission } from "../lib/site-permissions";

/**
 * Minimal "which sites can Markly inspect" list — not a general
 * permissions dashboard. The Markly dev/test origin is a required
 * host_permission (always present, nothing to manage), so it's excluded
 * here; every other entry came from an explicit "Enable Tracking" click
 * in the popup and can be revoked the same way it was granted.
 */

const MARKLY_ORIGIN_PATTERN = `${new URL(MARKLY_BASE_URL).origin}/*`;

const app = document.getElementById("app");
if (!app) throw new Error("options root missing");

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function hostnameFromPattern(pattern: string): string {
  // "https://novelphoenix.com/*" -> "novelphoenix.com"
  return pattern.replace(/^[a-z-]+:\/\//i, "").replace(/\/\*$/, "");
}

async function render() {
  if (!app) return;
  const origins = (await listGrantedOriginPatterns()).filter((pattern) => pattern !== MARKLY_ORIGIN_PATTERN);

  app.innerHTML = `
    <h1>Enabled Sites</h1>
    <p class="intro muted">Sites you've granted Markly permission to inspect for automatic tracking. Disabling a site immediately revokes that access.</p>
    ${
      origins.length === 0
        ? `<p class="muted">No sites enabled yet — use "Enable Tracking" in the Markly popup on a reading site.</p>`
        : `<ul>${origins
            .map(
              (pattern) => `
          <li>
            <div>
              <div class="origin">${escapeHtml(hostnameFromPattern(pattern))}</div>
              <div class="status">Allowed</div>
            </div>
            <button type="button" data-pattern="${escapeHtml(pattern)}">Disable</button>
          </li>`,
            )
            .join("")}</ul>`
    }
  `;

  app.querySelectorAll<HTMLButtonElement>("button[data-pattern]").forEach((button) => {
    button.addEventListener("click", async () => {
      const pattern = button.dataset.pattern;
      if (!pattern) return;
      button.disabled = true;
      button.textContent = "Disabling…";
      await revokeOriginPermission(pattern);
      await render();
    });
  });
}

void render();
