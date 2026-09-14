import Link from "next/link";
import { PublicPageShell } from "@/components/PublicPageShell";

export const metadata = { title: "Terms — Markly" };

/**
 * Stage 45 §12/§13 — scoped strictly to what's actually true of a free
 * beta product: no invented company/entity, address, governing-law
 * jurisdiction, arbitration clause, age restriction, or payment terms.
 * "Markly" is written as the product throughout, never as a company —
 * this deliberately doesn't assert incorporation status either way, since
 * that isn't something to guess at.
 */
export default function TermsPage() {
  return (
    <PublicPageShell title="Terms">
      <p>
        Markly is currently a free beta project, shared directly as a portfolio demo rather than launched broadly.
        These terms are written to match that, plainly.
      </p>

      <h2>Beta status</h2>
      <p>
        Features may change, be added, or be removed as the beta continues. Markly does not guarantee uninterrupted
        availability, and doesn&rsquo;t currently offer a paid tier — there are no subscription or payment terms
        because there is no billing.
      </p>

      <h2>Your account</h2>
      <p>
        You&rsquo;re responsible for keeping your credentials to yourself and for anything done from your account.
        If you believe your account has been compromised, change your password or contact support.
      </p>

      <h2>Acceptable use</h2>
      <ul>
        <li>Don&rsquo;t use Markly to store or share illegal content.</li>
        <li>Don&rsquo;t attempt to bypass, disrupt, or abuse Markly&rsquo;s security or infrastructure.</li>
        <li>
          Don&rsquo;t use the browser extension in a way that violates the terms of service of the site it&rsquo;s
          running on.
        </li>
      </ul>

      <h2>Your content</h2>
      <p>
        You&rsquo;re responsible for the titles, URLs, and notes you add to your library. Metadata shown from
        catalog search (AniList, Open Library, TMDB, RAWG) belongs to those providers, not Markly.
      </p>

      <h2>Third-party services</h2>
      <p>
        Markly integrates with optional third-party services (see <Link href="/privacy">Privacy</Link>). Your use of
        those services, where you choose to enable them, is subject to their own terms.
      </p>

      <h2>Backups</h2>
      <p>
        As a beta product, Markly doesn&rsquo;t guarantee against data loss. Use{" "}
        <Link href="/settings/backup">Settings → Data &amp; Backup</Link> to keep your own copy of anything you care
        about.
      </p>

      <h2>Ending your account</h2>
      <p>
        You can permanently delete your account and its cloud data at any time from{" "}
        <Link href="/settings/account">Settings → Account</Link>. Markly may suspend or terminate access for
        accounts that violate the acceptable-use terms above.
      </p>

      <h2>Changes</h2>
      <p>These terms may change as the beta evolves. Material changes will be reflected on this page.</p>

      <h2>No warranty</h2>
      <p>
        Markly is provided &ldquo;as is,&rdquo; without warranty of any kind, during this beta period. Support is
        best-effort — see <Link href="/support">Support</Link>.
      </p>
    </PublicPageShell>
  );
}
