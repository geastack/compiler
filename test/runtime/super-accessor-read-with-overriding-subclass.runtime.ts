// `super.flag` names the base's own accessor (13.3.7: the home object's
// prototype), so it dispatches statically even though a subclass overrides
// the accessor. A database client's `get canRetryWrite() { return super.canRetryWrite
// && ... }` is this read, and treating it as a virtual one published the
// whole class family to full reflection.
class Base {
  protected ready = true
  get flag(): boolean {
    return this.ready
  }
}

class Derived extends Base {
  constructor(private readonly extra: boolean) {
    super()
  }
  override get flag(): boolean {
    return super.flag && this.extra
  }
}

const items: Base[] = [new Base(), new Derived(true), new Derived(false)]
console.log(items.map((item) => item.flag).join(','))
//! expect: true,true,false
export {}
