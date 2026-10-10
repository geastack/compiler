// A `string[]` PASSED TO A `Set<any> | any[]` PARAMETER THAT IS REBOUND.
//
// A database client's `isRecord(value, requiredKeys)` helper calls
// `isSuperset(Object.keys(value), requiredKeys)`, and `isSuperset(set: Set<any>
// | any[], subset: Set<any> | any[])` rebinds each parameter to `new Set(...)`
// when `Array.isArray` holds, then asks `set.has(elem)` for every element of
// `subset`. Every key of the subset present in the set is `true`.

function isSuperset(set: Set<any> | any[], subset: Set<any> | any[]): boolean {
  set = Array.isArray(set) ? new Set(set) : set
  subset = Array.isArray(subset) ? new Set(subset) : subset
  for (const elem of subset) {
    if (!set.has(elem)) {
      return false
    }
  }
  return true
}

function hasKeys(value: Record<string, any>, requiredKeys: string[]): boolean {
  const keys = Object.keys(value)
  return isSuperset(keys, requiredKeys)
}

const record: Record<string, any> = {}
record['level'] = 'majority'
record['w'] = 1
//! expect: level=true both=true missing=false
console.log(`level=${hasKeys(record, ['level'])} both=${hasKeys(record, ['w', 'level'])} missing=${hasKeys(record, ['mode'])}`)
