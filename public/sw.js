// Stage 37 — Markly's service worker. Deliberately the smallest possible
// worker for exactly two responsibilities: receiving a Web Push message
// and handling a click on the resulting system notification (Stage 37
// §5). No offline mode, no asset precaching, no cache strategy of any
// kind — that is explicitly out of scope for this stage and a different
// project entirely if ever pursued later.
//
// Plain vanilla JS with no build step and no `import` (this file is
// served as-is from public/, and a service worker's own scope rules make
// bundling it more trouble than this stage's scope justifies) — so the
// payload contract below is a deliberate, documented, verbatim
// reproduction of src/lib/push/payload.ts's NotificationPayload shape and
// isSupportedNotificationRoute()/the two allowed NotificationRoute
// variants. Keep both in sync; scripts/verify-web-push.mjs statically
// checks they still agree.
//
// The push payload is treated as UNTRUSTED input (Stage 37 §52) even
// though this app is the only real sender: malformed/unknown-version/
// unknown-route data must never throw and must never navigate anywhere
// outside the fixed allowlist below — it falls back to a safe generic
// notification/route instead.

const NOTIFICATION_PAYLOAD_VERSION = 1;

function isSupportedRoute(value) {
  if (!value || typeof value !== "object") return false;
  if (value.type === "reminders") return true;
  if (value.type === "library-item") {
    return typeof value.itemId === "string" && value.itemId.length > 0 && value.itemId.length <= 200;
  }
  return false;
}

function parsePayload(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.version !== NOTIFICATION_PAYLOAD_VERSION) return null;
  if (raw.kind !== "reminder" && raw.kind !== "test") return null;
  if (typeof raw.title !== "string" || raw.title.length === 0 || raw.title.length > 80) return null;
  if (typeof raw.body !== "string" || raw.body.length === 0 || raw.body.length > 140) return null;
  if (typeof raw.tag !== "string" || raw.tag.length === 0 || raw.tag.length > 200) return null;
  if (!isSupportedRoute(raw.route)) return null;
  return raw;
}

// The ONLY two destinations a notification click may ever navigate to
// (Stage 37 §8/§9/§23) — never a raw href taken from the payload.
function resolveRouteUrl(route) {
  if (route.type === "library-item") return "/library/" + encodeURIComponent(route.itemId);
  return "/reminders";
}

self.addEventListener("push", (event) => {
  let payload = null;
  try {
    payload = event.data ? parsePayload(event.data.json()) : null;
  } catch {
    payload = null;
  }

  // Stage 37 §52 — malformed/unrecognized data shows a safe generic
  // notification rather than being silently dropped (a silent drop would
  // be indistinguishable from "the push never arrived" from the user's
  // side) or evaluated as anything richer than a fixed string.
  const title = payload ? payload.title : "Markly reminder";
  const options = {
    body: payload ? payload.body : "Open Markly to see what's new.",
    tag: payload ? payload.tag : "markly-notification",
    // Stage 37 §55 — deliberately no requireInteraction/renotify: an
    // ordinary, dismissable system notification, matching platform norms.
    icon: "/notification-icon.svg",
    data: { route: payload ? payload.route : { type: "reminders" } },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const route = event.notification.data && isSupportedRoute(event.notification.data.route) ? event.notification.data.route : { type: "reminders" };
  const targetPath = resolveRouteUrl(route);

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      const targetUrl = new URL(targetPath, self.location.origin).href;

      for (const client of clientList) {
        let sameOrigin = false;
        try {
          sameOrigin = new URL(client.url).origin === self.location.origin;
        } catch {
          sameOrigin = false;
        }
        if (!sameOrigin || !("focus" in client)) continue;

        // Stage 37 §9 — focus an existing Markly window rather than
        // opening a duplicate one; navigate it to the intended
        // destination where the browser supports it, falling back to a
        // plain focus (still lands the user in Markly, just not
        // necessarily on the exact page) where it doesn't.
        if ("navigate" in client) {
          return client.navigate(targetUrl).then((navigated) => (navigated || client).focus());
        }
        return client.focus();
      }

      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
      return undefined;
    }),
  );
});
