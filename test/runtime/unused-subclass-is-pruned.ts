//! expect: named present|circle:2|namedOnlyMarker
//! expect: mixed kept:mixin-ran
//! expect: token ok
//! emitted-lacks: unusedLeafMarker
//! emitted-lacks: unusedBaseMarker
//! emitted-lacks: unused brand token
//! emitted-has: namedOnlyMarker

// An `extends` clause used to keep a class unconditionally, so one unused
// subclass kept its base, and the base kept everything it named -- node-compat's
// rooted `whatwg-streams.ts` put the whole stream implementation into every
// program that way. `reachability.ts`'s `heritageIsInert` prunes a subclass
// NOTHING names when its base is a class declared earlier in the file (or an
// ambient intrinsic), because evaluating such a heritage clause runs nothing.
//
// Each block is one side of that decision:
//
//   unused   `UnusedLeaf extends UnusedBase`, named nowhere: both are gone, and
//            so is the method body that carries the marker string.
//   named    `Circle extends Shape` reached only through a TYPE ALIAS. The old
//            blanket rule existed for this case: a struct emitted for a class
//            the walk never opened has no base and its upcast does not compile.
//            The alias now opens the class for its layout, base included.
//   mixed    `extends mixin(Base)` is a call, so the class stays and its
//            definition-time effect still happens.
//   token    `Symbol('...')` on the intrinsic is inert when nothing reads the
//            binding, and still works when something does.

class UnusedBase {
  describe(): string {
    return 'unusedBaseMarker'
  }
}
class UnusedLeaf extends UnusedBase {
  override describe(): string {
    return 'unusedLeafMarker'
  }
}
class UnusedFailure extends Error {}

const unusedBrand = Symbol('unused brand token')

class Shape {
  sides = 0
  label(): string {
    return 'namedOnlyMarker'
  }
}
class Circle extends Shape {
  radius = 2
}
type Drawable = Circle | undefined
type Holder = { item?: Drawable }

const hold = (holder: Holder): string => (holder.item === undefined ? 'absent' : 'present')
const made: Holder = { item: new Circle() }
// `label` is INHERITED: reading it through `Circle` is what needs the base.
console.log(
  'named ' +
    hold(made) +
    '|circle:' +
    String(made.item === undefined ? -1 : made.item.radius) +
    '|' +
    (made.item === undefined ? '' : made.item.label())
)

let mixinRan = 'mixin-idle'
class Plain {}
const mixin = <T extends new () => object>(base: T): T => {
  mixinRan = 'mixin-ran'
  return base
}
class Mixed extends mixin(Plain) {}
console.log('mixed kept:' + mixinRan)

const usedBrand = Symbol('used brand token')
console.log('token ' + (usedBrand.description === 'used brand token' ? 'ok' : 'lost'))
