export function invariant(message: string): void {
  if (('production' as string) !== 'production') throw new Error(message)
}
