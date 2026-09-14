import Link from "next/link";
import { PublicPageShell } from "@/components/PublicPageShell";

export const metadata = { title: "Privacy — Markly" };

/**
 * Stage 45 §9/§15 — every claim below is derived directly from the actual
 * implementation (the account-deletion route's own exhaustive table audit,
 * the extension's documented signal list, AniList's encryption/no-revoke
 * behavior, Web Push's subscription storage), not a generic template. No
 * compliance claims (GDPR/CCPA/SOC2/etc.) are made — none have been
 * reviewed or verified, so none are asserted.
 */
export default function PrivacyPage() {
  return (
    <PublicPageShell title="Privacy">
      <p>
        Markly is currently a beta project, shared directly as a portfolio demo rather than launched broadly. This
        page describes what data Markly actually stores and why, in plain language. It is a product policy, not a
        claim of legal review — see the note at the bottom.
      </p>

      <h2>Local mode (no account)</h2>
      <p>
        Without an account, your library, collections, and activity history are stored only in this browser&rsquo;s{" "}
        <code>localStorage</code>. Nothing is sent to Markly&rsquo;s servers. This data is per browser, per device —
        it doesn&rsquo;t sync anywhere, clearing your browser&rsquo;s site data removes it, and Markly has no way to
        recover it once it&rsquo;s gone.
      </p>

      <h2>Account data (cloud mode)</h2>
      <p>
        Creating an account uses Supabase Auth (your email and password; Markly never sees or stores your password
        itself). Signing in stores the same kind of data — library items, collections, and activity history — in a
        Supabase-hosted Postgres database instead of your browser, isolated per account via Row Level Security, so
        one account&rsquo;s data is never visible to another. Depending on what you use, your account may also
        store: tracking-source records (from the browser extension or AniList), reminders, saved library views, a
        record of your AniList connection, browser push subscriptions, and short-lived records used to make delete
        and backup-import actions safe to retry. None of this is shared between accounts.
      </p>

      <h2>Browser extension</h2>
      <p>
        The optional Auto Tracking extension only runs on pages you&rsquo;ve explicitly enabled it for. On those
        pages, it reads a small set of signals — page headings, the document title, a handful of structured metadata
        tags, and previous/next link targets — to detect reading or watching progress. It does not read full page
        content, passwords, or login forms, does not collect general browsing history, and does not run on any page
        outside what you&rsquo;ve granted it. Only a confident detection is ever sent to Markly; a low-confidence
        result stays local to the extension popup.
      </p>

      <h2>AniList connection</h2>
      <p>
        Connecting AniList is optional and off by default. Your AniList access token is encrypted at rest and never
        sent to your browser. Disconnecting deletes Markly&rsquo;s stored copy of it, but AniList itself provides no
        way for Markly to revoke the token on AniList&rsquo;s side — disconnecting is a local action, not a
        revocation on AniList&rsquo;s servers. Sending changes back to AniList is a separate, off-by-default toggle
        you review and confirm per change; nothing is written automatically.
      </p>

      <h2>Push notifications</h2>
      <p>
        If you enable reminders, Markly stores the browser subscription details needed to deliver them. Deleting
        your account removes these. Enabling push does not enable any other kind of tracking.
      </p>

      <h2>Metadata search</h2>
      <p>
        Searching a catalog while adding an item (for anime/manga via AniList, books via Open Library, movies/series
        via TMDB, or games via RAWG) sends your search query to that provider. This only happens when you use catalog
        search — it never happens automatically or in the background.
      </p>

      <h2>Website bookmarks</h2>
      <p>
        For bookmarked websites, Markly requests a small icon for the site&rsquo;s domain from Google&rsquo;s public
        favicon service, which sends that domain (not your account or any personal data) to Google.
      </p>

      <h2>What Markly doesn&rsquo;t do</h2>
      <ul>
        <li>No advertising, and no ad or analytics tracking pixels.</li>
        <li>No selling or sharing your data with third parties for marketing.</li>
        <li>No reading of passwords, login forms, or general browsing history by the extension.</li>
      </ul>

      <h2>Exporting your data</h2>
      <p>
        You can download a full backup of your library at any time from{" "}
        <Link href="/settings/backup">Settings → Data &amp; Backup</Link>. A downloaded backup file is yours —
        once it&rsquo;s on your device, Markly can&rsquo;t see, modify, or delete it.
      </p>

      <h2>Deleting your account</h2>
      <p>
        Deleting your account from <Link href="/settings/account">Settings → Account</Link> permanently removes your
        Markly cloud account and everything tied to it — your cloud library, collections, activity history, tracking
        connections, reminders, saved views, integration connections, and push subscriptions. This cannot be undone.
      </p>
      <p>
        Deleting your account does <strong>not</strong> delete: local-mode data stored in any browser (it&rsquo;s
        never uploaded, so there&rsquo;s nothing cloud-side to remove), backup files you&rsquo;ve already downloaded,
        or your AniList (or any other third party&rsquo;s) account or content.
      </p>

      <h2>Third-party services Markly uses</h2>
      <ul>
        <li>
          <strong>Supabase</strong> — hosts Markly&rsquo;s database and handles account authentication.
        </li>
        <li>
          <strong>Vercel</strong> — hosts the Markly web application.
        </li>
        <li>
          <strong>AniList</strong> — optional connected account for anime/manga tracking, and a source for catalog
          search.
        </li>
        <li>
          <strong>TMDB</strong> and <strong>RAWG</strong> — optional catalog search for movies/series and games.
        </li>
        <li>
          <strong>Google&rsquo;s favicon service</strong> — used to fetch icons for bookmarked websites.
        </li>
        <li>
          <strong>Your browser&rsquo;s push service</strong> (e.g. Google, Mozilla, or Apple, depending on your
          browser) — used to deliver reminder notifications, only if you enable them.
        </li>
      </ul>

      <h2>Beta status</h2>
      <p>
        Markly is in beta. Features and this policy may change as the product evolves. Keep your own backups of
        anything important to you.
      </p>

      <h2>Contact</h2>
      <p>
        See <Link href="/support">Support</Link> for how to reach out with questions.
      </p>
    </PublicPageShell>
  );
}
