import { ResetPasswordForm } from "@/components/ResetPasswordForm";
import { Logo } from "@/components/Logo";

/**
 * Stage 45 §4 — deliberately no server-side signed-in redirect like
 * login/signup: this page's whole purpose is to consume a Supabase
 * recovery link, which itself establishes a session client-side (see
 * ResetPasswordForm). A server-side "already signed in -> redirect" check
 * here would fire on every visit, recovery link or not, and send a
 * legitimate password-reset attempt away before the client ever got to
 * process the link.
 */
export default function ResetPasswordPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-10">
      <div className="mb-6 flex items-center justify-center gap-2">
        <Logo />
        <span className="text-lg font-semibold tracking-tight">Markly</span>
      </div>
      <h1 className="mb-1 text-center text-lg font-semibold text-foreground">Set a new password</h1>
      <p className="mb-6 text-center text-sm text-muted-foreground">Choose a new password for your account.</p>
      <ResetPasswordForm />
    </div>
  );
}
