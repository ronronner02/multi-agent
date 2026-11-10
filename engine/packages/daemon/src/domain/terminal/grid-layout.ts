export function autoGridCols(n: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(n)));
}
