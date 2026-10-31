// A record passed where a wider record is expected is a live view of the
// original. Read as an open `any` document (`Record<string, unknown>`, or a
// type parameter bounded by one, then `as any`), the view is the original
// object (`gea::dictionary::aliasOf`), so every keyed read runs the original's
// field-read hook. The census published the view's hooks but not the
// original's, so the original's struct had no field reads and every key read
// `undefined`: `compact` (`@zag-js/utils`) dropped every key.
export {}

function compact<T extends Record<string, unknown> | undefined>(obj: T): T {
  if (obj === undefined) return obj
  const filtered: Partial<T> = {}
  for (const key of Object.keys(obj)) {
    const value = (obj as any)[key]
    if (value !== undefined) filtered[key as keyof T] = value
  }
  return filtered as T
}
const props: Partial<{ id: string; label?: string }> = { id: 'toggle', label: undefined }
//! expect: [id,label] [id]
console.log(`[${Object.keys(props).join(',')}] [${Object.keys(compact(props)).join(',')}]`)

function show(obj: { id?: string; label?: string }): string {
  const document: Record<string, unknown> = obj
  return Object.keys(document)
    .map((key) => `${key}=${String(document[key])}`)
    .join(',')
}
const wider = { id: 'w', n: 1 }
//! expect: id=w,n=1
console.log(show(wider))
