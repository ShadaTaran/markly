import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ForgotPasswordForm } from "@/components/ForgotPasswordForm";
import { Logo } from "@/components/Logo";

export default async function ForgotPasswordPage() {
  let alreadySignedIn = false;
  try {
    const supabase = await createClient();
    if (supabase) {
      const { data } = await supabase.auth.getUser();
      alreadySignedIn = Boolean(data.user);
    }
  } catch {
    // Supabase not configured, or the session check failed — fall through
    // and show the form; submitting it will explain if cloud sync isn't
    // set up.
  }

  if (alreadySignedIn) redirect("/library");

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-10">
      <div className="mb-6 flex items-center justify-center gap-2">
        <Logo />
        <span className="text-lg font-semibold tracking-tight">Markly</span>
      </div>
      <h1 className="mb-1 text-center text-lg font-semibold text-foreground">Reset your password</h1>
      <p className="mb-6 text-center text-sm text-muted-foreground">
        Enter your email and we&rsquo;ll send you a link to reset it.
      </p>
      <ForgotPasswordForm />
    </div>
  );
}
