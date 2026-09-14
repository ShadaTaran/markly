"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabase/client";
import { Field, inputClass } from "@/components/FormField";
import { Button } from "@/components/Button";

/**
 * Stage 45 §4/§31 — Supabase's own resetPasswordForEmail never reveals
 * whether an address has an account (it succeeds either way), so the
 * success copy stays generic on purpose rather than confirming or denying
 * that this email is registered. An `error` here is therefore never an
 * enumeration signal — only a genuine problem (rate limit, cloud sync not
 * configured, network failure) reaches this branch at all.
 *
 * `redirectTo` uses the current page's own origin, never a request-
 * controlled value — there's no open-redirect surface here, only whatever
 * origin Markly is actually being served from. See the reset-password page
 * for the other half of this flow.
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [sent, setSent] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);

    const supabase = getSupabaseClient();
    if (!supabase) {
      setError("Cloud sync isn't configured for this deployment yet.");
      return;
    }

    setSubmitting(true);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setSubmitting(false);

    if (resetError) {
      setError(
        resetError.status === 429
          ? "Too many requests — please wait a bit before trying again."
          : "Something went wrong. Please try again in a moment.",
      );
      return;
    }

    setSent(true);
  }

  if (sent) {
    return (
      <div className="rounded-lg border border-border bg-surface p-5 text-sm">
        <p className="font-medium text-foreground">Check your email</p>
        <p className="mt-1.5 text-muted-foreground">
          If an account exists for <span className="text-foreground">{email}</span>, we&rsquo;ve sent a link to
          reset your password.
        </p>
        <Link href="/login" className="mt-4 inline-block font-medium text-accent hover:underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Field label="Email" htmlFor="forgot-email" required>
        <input
          id="forgot-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className={inputClass(false)}
        />
      </Field>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <Button type="submit" variant="primary" disabled={submitting} className="w-full">
        {submitting ? "Please wait…" : "Send reset link"}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        <Link href="/login" className="font-medium text-foreground hover:underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
