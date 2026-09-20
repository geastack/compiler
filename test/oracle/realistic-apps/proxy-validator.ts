//! dynamic-fallback
//! oracle: node
interface Counter {
  value: number
  label: string
}
export function main(): string {
  const target: Counter = { value: 0, label: '' }
  const errors: string[] = []
  const guarded = new Proxy(target, {
    set(t: Counter, key: string, value: unknown): boolean {
      if (key === 'value' && typeof value !== 'number') {
        errors.push('value-bad')
        return false
      }
      if (key === 'label' && typeof value === 'string' && value.length > 5) {
        errors.push('label-long')
        return false
      }
      ;(t as unknown as Record<string, unknown>)[key] = value
      return true
    }
  })
  guarded.value = 5
  guarded.label = 'short'
  try {
    guarded.label = 'too-long-string'
  } catch (e) {
    errors.push('threw')
  }
  return 'value=' + guarded.value + ' label=' + guarded.label + ' errors=' + errors.join(';')
}
console.log(main())
