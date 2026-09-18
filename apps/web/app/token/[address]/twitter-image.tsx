import { CARD_ALT, CARD_CONTENT_TYPE, CARD_SIZE, tokenShareCard } from "@/lib/og/card";

/// The same picture again, as its own route. Next only falls back to the Open Graph image for
/// `twitter:image` when nothing else claims it, and X is where a launch is actually pasted, so it
/// gets a tag of its own rather than a fallback.
export const size = CARD_SIZE;
export const contentType = CARD_CONTENT_TYPE;
export const alt = CARD_ALT;

export default async function Image({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return tokenShareCard(address);
}
