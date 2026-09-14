import type { ReactNode } from "react";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { Footer } from "@/components/Footer";

/**
 * Stage 45 — shared shell for the three public policy/support pages
 * (Privacy, Terms, Support). They're identical in structure (brand mark
 * linking home, a title, prose, the public footer) and different only in
 * content, so one shell avoids tripling that markup.
 */
export function PublicPageShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <div className="mx-auto w-full max-w-2xl flex-1 px-4 py-12 sm:px-6">
        <Link href="/" className="mb-8 flex w-fit items-center gap-2">
          <Logo size={24} />
          <span className="text-base font-semibold tracking-tight text-foreground">Markly</span>
        </Link>
        <h1 className="mb-6 text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        <div
          className="space-y-4 text-sm leading-relaxed text-muted-foreground [&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2 [&_h2]:mb-2 [&_h2]:mt-8 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-foreground [&_li]:ml-4 [&_li]:list-disc [&_strong]:text-foreground"
        >
          {children}
        </div>
      </div>
      <Footer />
    </div>
  );
}
