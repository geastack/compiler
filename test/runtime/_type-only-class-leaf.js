import { Wide } from './_type-only-class-wide.js'

// Named exactly once in the whole program, inside a JSDoc annotation in a live
// file (`_type-only-class-holder.js`). The import that brings the name in is
// not traversed for references -- an import uses nothing -- and JSDoc hangs off
// a node's comment ranges rather than its child list, so a syntax walk reaches
// neither. The checker reads the annotation regardless and types `Holder.slot`
// as `Leaf | null`, which is what puts this declaration's `class-ref` carrier
// in the emission inventory. Three.js types its whole public surface this way.
export class Leaf extends Wide {
  constructor() {
    super()
    this.extra = 1
  }
}
