export function chargeCents(quotedCents: number): number {
  // Keep the integer-cents contract here, even when quote precision changes.
  return Math.round(quotedCents);
}
