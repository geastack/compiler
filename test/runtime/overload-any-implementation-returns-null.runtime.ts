// An overload implementation typed `any` may return a `null` none of the
// overload signatures admit: the checker relates that `any` to no overload.
// A lazy wire-document reader's `toJSValue<T>(el, as: T): JSTypeOf[T]` returns
// `null` for an element of another wire type, and `get` tests `value == null`.
type TypeOf = { 1: number; 8: boolean; 2: string }

class Doc {
  constructor(private readonly kinds: number[]) {}
  private decode<T extends keyof TypeOf>(index: number, as: T): TypeOf[T]
  private decode(index: number, as: keyof TypeOf): any {
    if (this.kinds[index] !== as) return null
    switch (as) {
      case 1:
        return index * 10
      case 8:
        return index % 2 === 0
      case 2:
        return `s${index}`
    }
  }
  get<T extends keyof TypeOf>(index: number, as: T): TypeOf[T] | null {
    const value = this.decode(index, as)
    if (value == null) return null
    return value
  }
}

const doc = new Doc([8, 1, 2, 8])
console.log(doc.get(0, 8), doc.get(1, 8), doc.get(1, 1), doc.get(2, 1), doc.get(2, 2), doc.get(3, 8))
const flag = doc.get(1, 8)
console.log(flag == null ? 'none' : flag ? 1 : 0)

//! expect: true null 10 null s2 false
//! expect: none
