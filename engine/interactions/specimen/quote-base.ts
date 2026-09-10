export function quoteCents(subtotalCents: number, discountPercent: number): number {
  return Math.round(subtotalCents * (1 - discountPercent / 100));
}
