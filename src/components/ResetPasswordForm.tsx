"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabase/client";
import { Field, inputClass } from "@/components/FormField";
import { Button } from "@/components/Button";

type LinkStatus = "checking" | "ready" | "invalid";

/**
 * Stage 45 §4 — Supabase's recovery link lands here with the reset tokens
 * in the URL; @supabase/ssr's browser client parses them automatically
 * (detectSessionInUrl, on by default) and fires a PASSWORD_RECOVERY auth
 * event once it does. A getSession() check on mount is a safety net for
 * the (rare) case where that event fires before this listener attaches —
 * either signal is treated as "the link was genuine," since both mean
 * Supabase has already established the short-lived recovery session that
 * updateUser({ password }) below depends on. If neither ever fires, the
 * link was invalid, expired, or already used; no account information is
 * ever revealed by that distinction — it's the same message either way.
 */
export function ResetPasswordForm() {
  const router = useRouter();
  const [status, setStatus] = useState<LinkStatus>("checking");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const supabase = getSupabaseClient();
    if (!supabase) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time sync: Supabase isn't configured, so there's no recovery link to ever process; this resolves the initial "checking" state exactly once on mount (same pattern as AuthProvider's own initial-session check).
      setStatus("invalid");
      return;
    }

    let settled = false;

    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        settled = true;
        setStatus("ready");
      }
    });

    supabase.auth.getSession().then(({ data }) => {
      if (!settled && data.session) {
        settled = true;
        setStatus("ready");
      }
    });

    const timeout = setTimeout(() => {
      if (!settled) setStatus("invalid");
    }, 2500);

    return () => {
      listener.subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);

    const supabase = getSupabaseClient();
    if (!supabase) {
      setError("Cloud sync isn't configured for this deployment yet.");
      return;
    }

    setSubmitting(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setSubmitting(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    setDone(true);
  }

  if (status === "checking") {
    return <p className="text-center text-sm text-muted-foreground">Checking your link…</p>;
  }

  if (status === "invalid") {
    return (
      <div className="rounded-lg border border-border bg-surface p-5 text-center text-sm">
        <p className="font-medium text-foreground">This link is invalid or has expired</p>
        <p className="mt-1.5 text-muted-foreground">Password reset links only work once, and expire after a while.</p>
        <Link href="/forgot-password" className="mt-4 inline-block font-medium text-accent hover:underline">
          Request a new link
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div className="rounded-lg border border-border bg-surface p-5 text-center text-sm">
        <p className="font-medium text-foreground">Password updated</p>
        <p className="mt-1.5 text-muted-foreground">You&rsquo;re signed in with your new password.</p>
        <Button
          variant="primary"
          className="mt-4"
          onClick={() => {
            router.push("/library");
            router.refresh();
          }}
        >
          Continue to Markly
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Field label="New password" htmlFor="reset-password" required hint="At least 6 characters.">
        <input
          id="reset-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={6}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={inputClass(false)}
        />
      </Field>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <Button type="submit" variant="primary" disabled={submitting} className="w-full">
        {submitting ? "Please wait…" : "Update password"}
      </Button>
    </form>
  );
}
