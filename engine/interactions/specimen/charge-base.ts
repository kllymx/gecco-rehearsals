export function chargeCents(quotedCents: number): number {
  // Normalize to the integer minor units accepted at the payment boundary.
  return Math.round(quotedCents);
}
