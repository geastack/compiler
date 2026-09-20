interface NamedResult {
  fixed: string
}

function namedWithExtra(includeLast: boolean): NamedResult {
  let result: NamedResult = { fixed: 'fixed' }
  const extras: Record<string, any> = { extra: 'kept', count: 2 }
  result = Object.assign(result, extras, includeLast ? { last: 'copied' } : null)
  return result
}

const result = namedWithExtra(true)
const withoutLast = namedWithExtra(false)
console.log(
  result.fixed,
  Object.keys(result).join(','),
  (result as any).extra,
  (result as any).count,
  (result as any).last,
  Object.keys(withoutLast).join(',')
)
