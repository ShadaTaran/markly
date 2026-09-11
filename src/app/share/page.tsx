import { SecondaryPageHeader } from "@/components/SecondaryPageHeader";
import { PageContainer } from "@/components/PageContainer";
import { ShareCaptureView } from "@/components/ShareCaptureView";

interface SharePageProps {
  searchParams: Promise<{ url?: string; title?: string; text?: string }>;
}

/**
 * Stage 39 — the one stable Share to Markly / universal capture route.
 * Reachable three ways: the manifest's `share_target` (an OS/browser share
 * sheet choosing Markly), a manual deep link (`/share?url=...`), and a
 * direct visit with no query at all (the lightweight "Paste a link"
 * surface — see ShareCaptureView). All three funnel through the exact same
 * component and the exact same validation; none of these query values are
 * trusted, and none are written anywhere until the user explicitly submits
 * a form.
 */
export default async function SharePage({ searchParams }: SharePageProps) {
  const params = await searchParams;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SecondaryPageHeader maxWidthClassName="max-w-2xl" />
      <PageContainer width="settings" paddingY="py-8">
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Markly</p>
        <h1 className="mb-4 text-lg font-semibold text-foreground">Share to Markly</h1>
        <ShareCaptureView sharedUrl={params.url} sharedTitle={params.title} sharedText={params.text} />
      </PageContainer>
    </div>
  );
}
