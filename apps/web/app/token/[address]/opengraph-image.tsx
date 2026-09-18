import { CARD_ALT, CARD_CONTENT_TYPE, CARD_SIZE, tokenShareCard } from "@/lib/og/card";

export const size = CARD_SIZE;
export const contentType = CARD_CONTENT_TYPE;
export const alt = CARD_ALT;

export default async function Image({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return tokenShareCard(address);
}
