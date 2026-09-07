import { redirect } from 'next/navigation';

/**
 * The old challenge-draft page.
 *
 * It was a paywall in front of a document that was never generated: it showed a
 * price, or "Ready to draft", and then said generation was not configured. The
 * Defence Pack is what it was a placeholder for, so this redirects rather than
 * standing beside it — two pages offering the same purchase, one of which does
 * nothing, is how a user ends up on the dead one.
 *
 * Kept as a redirect rather than deleted so a bookmarked or shared link still
 * lands somewhere useful.
 */
export default async function DraftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/case/${id}/defence`);
}
