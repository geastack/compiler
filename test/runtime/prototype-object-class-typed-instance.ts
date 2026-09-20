// SYMBOL-KEYED DATA SLOTS ON AN OBJECT-LITERAL PROTOTYPE, INSTANTIATED WITH
// `Object.create` -- `prototypeObjectClassSourceTransform`'s own target
// shape (`@hono/node-server`'s lightweight `Request`: a literal of methods
// and accessors, re-parented onto a host class, instantiated with
// `Object.create`, then grown with `instance[symbolKey] = value` right where
// it is created), not the "already a class" shapes
// `class-prototype-reparented-onto-another-class.ts` and
// `class-prototype-members-installed-from-key-list.ts` cover.
//
// Before this file, the transform rewrote the literal into a class but kept
// every instance `(new C() as any)`, so a per-instance symbol slot like
// `k` below had nowhere to live except a fully dynamic side table -- the
// defect the hono `newRequest()` census measured (1.17M of 1.59M tracked
// allocations). This pins the fix: the class now declares a field for each
// slot the module proves it writes (`k`, `shared` below), and the instance
// keeps the class as its own static type instead of losing it to
// `Object.create`'s `any`.

const k = Symbol('k')
const shared = Symbol('shared')

// Declared before the prototype literal, matching `@hono/node-server` itself:
// `export class Request extends GlobalRequest {...}` sits above
// `const requestPrototype = {...}`. `prototype-reparenting.ts`'s own
// `nothingRunsBetween` only tolerates declarations and reflective calls
// between a re-parented class and its `Object.setPrototypeOf` call, and a
// `ClassDeclaration` is not on that allow-list -- so the host class must not
// sit between `proto`'s declaration and the re-parenting call.
class Host {
  tag(): string {
    return 'host'
  }
}

const proto: Record<string | symbol, any> = {
  get x() {
    return (this as any)[k]
  },
  label(): string {
    return 'label:' + (this as any)[k]
  }
}

// An install (`prototype-install-source-transform.ts`'s own territory) that
// also reaches a data slot through `this` -- proving the slot is found
// whether the read sits in the literal or in a `defineProperty` descriptor.
Object.defineProperty(proto, 'y', {
  get() {
    return (this as any)[shared]
  }
})

Object.setPrototypeOf(proto, Host.prototype)

const o = Object.create(proto)
o[k] = 5

//! expect: x=5
console.log('x=' + o.x)

// A second instance: the slot is per-object storage, not a class-level cell.
const o2 = Object.create(proto)
o2[k] = 9

//! expect: independent=5 9
console.log('independent=' + o.x + ' ' + o2.x)

// A method on the prototype, not just the getter, reaching the same slot.
//! expect: label=label:5
console.log('label=' + o.label())

// A slot only ever written from outside the literal's own members (here, a
// plain top-level statement playing the role of `newRequest`'s
// `req[incomingKey] = incoming`) and only ever read from an install.
o[shared] = 'viaDefineProperty'
//! expect: y=viaDefineProperty
console.log('y=' + o.y)

//! expect: hasK=true
console.log('hasK=' + String(k in o))

// `delete` drives the field to genuine absence and a later write restores it
// -- the same own-property cycle `symbol-key-declared-field.ts` pins for a
// class field declared directly, now reached through this rewrite instead.
delete o[k]
//! expect: afterDelete=false undefined
console.log('afterDelete=' + String(k in o) + ' ' + String(o.x))

o[k] = 42
//! expect: rewritten=true 42
console.log('rewritten=' + String(k in o) + ' ' + o.x)

// A dynamic (`any`) view over the SAME instance must reach the declared
// field, not a shadow expando, exactly as it must for a field declared
// directly on a class (`symbol-key-declared-field.ts`).
const dyn: any = o
dyn[k] = 100
//! expect: dynamicAgrees=100 100
console.log('dynamicAgrees=' + o.x + ' ' + dyn[k])

// The re-parented host method still answers -- the class this rewrite
// produces states no `extends Host`, so the object's actual prototype chain
// (set at run time by `Object.setPrototypeOf`, not by the class's own
// declaration) is what a caller who casts to the host shape reaches.
//! expect: hostTag=host
console.log('hostTag=' + (o as unknown as { tag(): string }).tag())

// Out of pattern, left for a caller to note rather than a case here:
// `Object.create(Host.prototype)` directly -- with no intervening object
// literal for this transform to turn into a class -- never enters this
// rewrite at all (`usesOf` only tracks a name declared with an object
// literal initializer), so an instance built that way stays `any` today,
// as it always has.
