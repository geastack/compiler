// A private static type predicate whose only callers are in the class is a
// plain native call: the argument keeps its static union (no gea::Value box)
// and no callable object is built per call. An id class's `is(inputId)` brand check.
interface IdLike {
  id: string | Uint8Array
}
class Ident {
  tag = 'Ident'
  _wiretype = 'ObjectKey'
  get id(): string {
    return 'x'
  }
  constructor(input?: string | Ident | IdLike) {
    if (typeof input === 'object' && input && 'id' in input) {
      if (Ident.is(input)) {
        this.tag = 'same'
        return
      }
      this.tag = 'like'
      return
    }
    this.tag = typeof input === 'string' ? 'string' : 'none'
  }
  private static is(variable: unknown): variable is Ident {
    return variable != null && typeof variable === 'object' && '_wiretype' in variable && variable._wiretype === 'ObjectKey'
  }
}
const same = new Ident()
console.log(new Ident().tag, new Ident('a').tag, new Ident({ id: 'b' }).tag, new Ident(same).tag)

//! expect: none string like same
//! emitted-lacks: gea::Value v
//! emitted-lacks: CallableObject<bool(gea::Value)>
