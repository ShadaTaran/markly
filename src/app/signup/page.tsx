import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { AuthForm } from "@/components/AuthForm";

export default async function SignupPage() {
  let alreadySignedIn = false;
  try {
    const supabase = await createClient();
    if (supabase) {
      const { data } = await supabase.auth.getUser();
      alreadySignedIn = Boolean(data.user);
    }
  } catch {
    // Supabase not configured, or the session check failed — fall through
    // and show the sign-up form; submitting it will explain if cloud sync
    // isn't set up.
  }

  if (alreadySignedIn) redirect("/library");

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-10">
      <div className="mb-6 flex items-center justify-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-foreground text-sm font-semibold text-background">
          M
        </span>
        <span className="text-lg font-semibold tracking-tight">Markly</span>
      </div>
      <h1 className="mb-1 text-center text-lg font-semibold text-foreground">Create an account</h1>
      <p className="mb-6 text-center text-sm text-muted-foreground">Sync your library across devices.</p>
      <AuthForm mode="signup" />
      <Link href="/library" className="mt-6 text-center text-sm text-muted-foreground hover:text-foreground">
        Continue without an account
      </Link>
    </div>
  );
}
