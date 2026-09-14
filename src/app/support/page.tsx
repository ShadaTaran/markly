import Link from "next/link";
import { PublicPageShell } from "@/components/PublicPageShell";

export const metadata = { title: "Support — Markly" };

/**
 * Stage 45 §8/§14/§44/§53 — Phase 0 found no dedicated public contact
 * email anywhere in this repo's public-facing config (verified: no
 * support@/contact@ addresses, and VAPID_SUBJECT's mailto is an env-only
 * placeholder for push providers, never meant for public display — see
 * .env.example). Rather than inventing an address, GitHub Issues on the
 * already-public repository is the actual, truthful support channel this
 * stage sets up. §53 explicitly anticipates exactly this pattern (a
 * public issue tracker used for non-sensitive support, paired with a
 * clear warning not to post secrets there).
 */
export default function SupportPage() {
  return (
    <PublicPageShell title="Support">
      <p>Markly is a beta product with best-effort support. Here&rsquo;s how to get help.</p>

      <h2>Getting help</h2>
      <p>
        For bugs, questions, or feedback, open an issue on{" "}
        <a href="https://github.com/ShadaTaran/markly/issues" target="_blank" rel="noopener noreferrer">
          Markly&rsquo;s GitHub repository
        </a>
        . This is a public issue tracker — see the warning below before posting anything there.
      </p>

      <h2>Common tasks</h2>
      <ul>
        <li>
          <strong>Export your library:</strong> <Link href="/settings/backup">Settings → Data &amp; Backup</Link>.
        </li>
        <li>
          <strong>Delete your account:</strong> <Link href="/settings/account">Settings → Account</Link>.
        </li>
        <li>
          <strong>Manage your AniList connection:</strong>{" "}
          <Link href="/settings/connections">Settings → Connections</Link> — disconnect and reconnect from there.
        </li>
        <li>
          <strong>Browser extension not detecting progress:</strong> confirm the site is enabled from the
          extension&rsquo;s popup, and that the extension device is still paired under{" "}
          <Link href="/settings/tracking">Settings → Auto Tracking</Link> — re-pairing generates a fresh connection
          if it isn&rsquo;t.
        </li>
      </ul>

      <h2>Please don&rsquo;t post publicly</h2>
      <p>When reporting an issue, never include:</p>
      <ul>
        <li>Your password</li>
        <li>Access tokens or session cookies</li>
        <li>Password-reset or account-recovery links</li>
        <li>Your extension&rsquo;s device token</li>
        <li>A backup file, if it contains anything you consider sensitive</li>
      </ul>
      <p>Describe the problem instead — steps to reproduce and what you expected are almost always enough.</p>

      <h2>Beta status</h2>
      <p>
        Markly is in beta, so things may change. See <Link href="/terms">Terms</Link> and{" "}
        <Link href="/privacy">Privacy</Link> for the full details.
      </p>
    </PublicPageShell>
  );
}
