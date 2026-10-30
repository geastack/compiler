export function invariant(message: string): void {
  if (process.env.NODE_ENV !== 'production') throw new Error(message)
}
