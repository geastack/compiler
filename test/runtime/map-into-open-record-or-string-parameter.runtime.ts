// A `Map` PASSED WHERE `Record<string, any> | string` IS DECLARED.
//
// A database client's size-limited metadata document (`add(key, value: Record<string,
// any> | string)`) is handed plain
// records, a string, and the `Map`s its metadata builder makes for `os` and
// `env`. It stores the value itself (not a copy) in its own `Map`, and the
// caller keeps deleting keys from that same `Map` afterwards -- so what is
// finally serialized sees the deletions: the stored value IS the caller's Map.

class SizedDocument {
  private document = new Map()

  put(key: string, value: Record<string, any> | string): boolean {
    this.document.set(key, value)
    return true
  }

  holds(key: string, value: unknown): boolean {
    return this.document.get(key) === value
  }

  kinds(keys: string[]): string {
    return keys.map((key) => `${key}:${typeof this.document.get(key)}`).join(' ')
  }
}

const doc = new SizedDocument()
doc.put('application', { name: 'app' })
doc.put('platform', 'Node.js')
const osInfo = new Map().set('name', 'darwin').set('type', 'Darwin')
doc.put('os', osInfo)
osInfo.delete('name')

//! expect: application:object platform:string os:object
console.log(doc.kinds(['application', 'platform', 'os']))
//! expect: same=true remaining=type
console.log(`same=${doc.holds('os', osInfo)} remaining=${[...osInfo.keys()].join('+')}`)
