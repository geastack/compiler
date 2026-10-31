// Zag's `compact` (`@zag-js/utils/src/object.ts`), which `VanillaMachine`
// calls on its `Partial<T['props']>` user props: a fresh `{}` filled by a
// computed-key store. Inside the generic copy `T` and `Partial<T>` select the
// empty record, which is a live view target of the caller's props record and
// whose view back forwards `id` and `count` to it. Those keys are named routes
// of the store, yet the plain `{}` allocation has no slot for them: JavaScript
// creates the property on it. The store used to write the missing own slot
// and threw "Cannot assign to native view property".
export {}
const isPlainObject = (v: any): boolean => typeof v === 'object' && v !== null && !Array.isArray(v)

function compact<T extends Record<string, unknown> | undefined>(obj: T): T {
  if (!isPlainObject(obj) || obj === undefined) return obj
  const filtered: Partial<T> = {}
  for (const key of Object.keys(obj)) {
    const value = (obj as any)[key]
    if (value !== undefined) filtered[key as keyof T] = value
  }
  return filtered as T
}

interface Schema {
  props?: Record<string, any> | undefined
}
class Runner<S extends Schema> {
  private readonly user: Partial<S['props']>
  constructor(user: Partial<S['props']>) {
    this.user = user
  }
  describe(): string {
    const out = compact(this.user)
    return Object.keys(out).join(',') + ' ' + JSON.stringify(out)
  }
}
interface Toggle {
  props: { id: string; label?: string; count?: number }
}
console.log(new Runner<Toggle>({ id: 'toggle', label: undefined, count: 2 }).describe())

//! expect: id,count {"id":"toggle","count":2}
//! emitted-has: gea::nativeObjectDataExtend(gea_field_receiver, gea::PropertyKey::string("id"), gea_open_write)
