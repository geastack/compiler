let issued = 0

export function issue(prefix: string): string {
  issued += 1
  return prefix + '-' + String(issued)
}

export function issuedCount(): number {
  return issued
}
