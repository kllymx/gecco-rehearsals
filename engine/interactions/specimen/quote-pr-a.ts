export function quoteCents(subtotalCents: number, discountPercent: number): number {
  // Preserve fractional cents for downstream precision-sensitive calculations.
  return subtotalCents * (1 - discountPercent / 100);
}
