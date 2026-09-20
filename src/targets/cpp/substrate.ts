/**
 * The non-negotiable runtime object substrate (architecture.md, "Non-negotiable
 * runtime object substrate"). These types are the written contract every
 * native carrier the emitter targets must satisfy: prototype/extensibility/
 * descriptor behavior, array hole and length semantics, callable and
 * constructor ABIs, and proxy trap forwarding. This module declares that
 * contract; it emits no C++ and holds no executable logic. `targets/cpp/*`
 * designs its type mapping and ownership leases against these shapes instead
 * of re-deriving the substrate ad hoc at each call site, and the C++ runtime
 * (`src/targets/cpp/runtime/`, compiled once) is what actually implements it.
 */

/** A normalized ECMAScript property key: string or symbol identity, never a raw source token. */
export type PropertyKeySubstrate = { readonly kind: 'string'; readonly value: string } | { readonly kind: 'symbol'; readonly id: string }

/**
 * [[GetOwnProperty]]/[[DefineOwnProperty]] descriptor shape (ECMA-262 6.2.6).
 * A data and an accessor descriptor are different variants, not one shape
 * with optional fields, because a carrier must never synthesize a `get`/`set`
 * pair for a data property or a `value` for an accessor.
 */
export type PropertyDescriptorSubstrate =
  | {
      readonly kind: 'data'
      readonly value: unknown
      readonly writable: boolean
      readonly enumerable: boolean
      readonly configurable: boolean
    }
  | {
      readonly kind: 'accessor'
      readonly get: unknown
      readonly set: unknown
      readonly enumerable: boolean
      readonly configurable: boolean
    }

/**
 * The ordinary internal methods (ECMA-262 10.1). Every native carrier that is
 * not a fully bespoke exotic object composes this contract instead of
 * reimplementing get/set/delete/enumeration on its own -- the shared contract
 * is what lets `[[OwnPropertyKeys]]`/`[[HasProperty]]`/etc. mean one thing
 * across every carrier a Proxy might wrap.
 */
export interface OrdinaryObjectSubstrate {
  readonly getPrototypeOf: () => OrdinaryObjectSubstrate | null
  readonly setPrototypeOf: (prototype: OrdinaryObjectSubstrate | null) => boolean
  readonly isExtensible: () => boolean
  readonly preventExtensions: () => boolean
  readonly getOwnProperty: (key: PropertyKeySubstrate) => PropertyDescriptorSubstrate | null
  readonly defineOwnProperty: (key: PropertyKeySubstrate, descriptor: PropertyDescriptorSubstrate) => boolean
  readonly hasProperty: (key: PropertyKeySubstrate) => boolean
  readonly get: (key: PropertyKeySubstrate, receiver: unknown) => unknown
  readonly set: (key: PropertyKeySubstrate, value: unknown, receiver: unknown) => boolean
  readonly deleteProperty: (key: PropertyKeySubstrate) => boolean
  readonly ownPropertyKeys: () => readonly PropertyKeySubstrate[]
}

/**
 * A slot's presence is a fact separate from its value: a hole and a stored
 * `undefined` are different observations (`0 in arr`, `Object.keys`, and
 * iteration all differ), and collapsing this to `ElementCarrier | undefined`
 * is exactly the shortcut that erases hole semantics.
 */
export type ArrayElementSlotSubstrate<ElementCarrier> =
  { readonly present: true; readonly value: ElementCarrier } | { readonly present: false }

/**
 * `ArrayObject<ElementCarrier>`: an exotic object with element presence
 * separate from element value, an array-index key domain disjoint from
 * arbitrary string keys, and the `length` define/delete/truncation rules
 * ECMA-262 10.4.2 assigns only to Array exotic objects. A dense
 * `std::vector` is one storage choice made *after* these semantics exist,
 * never a substitute for them.
 */
export interface ArrayObjectSubstrate<ElementCarrier> extends OrdinaryObjectSubstrate {
  readonly length: () => number
  /** Defining `length` to a smaller value deletes every own index at or above it, in descending order. */
  readonly defineLength: (newLength: number) => boolean
  readonly getElement: (index: number) => ArrayElementSlotSubstrate<ElementCarrier>
  readonly defineElement: (index: number, slot: ArrayElementSlotSubstrate<ElementCarrier>) => boolean
  readonly deleteElement: (index: number) => boolean
  /** The array-index key domain is exactly the canonical numeric strings 0 .. 2^32-2; nothing outside it may alias an element slot. */
  readonly isArrayIndexKey: (key: PropertyKeySubstrate) => boolean
}

/** `CallableObject<Abi>`: adds `[[Call]]` while retaining the native argument/result carriers named by `Abi`. */
export interface CallableObjectSubstrate<Abi> extends OrdinaryObjectSubstrate {
  readonly call: (thisArgument: unknown, argumentList: Abi) => unknown
}

/** `ConstructorObject<Abi>`: a callable that additionally supports `[[Construct]]` with an explicit `newTarget`. */
export interface ConstructorObjectSubstrate<Abi> extends CallableObjectSubstrate<Abi> {
  readonly construct: (argumentList: Abi, newTarget: ConstructorObjectSubstrate<Abi>) => unknown
}

/**
 * `ProxyObject<TargetCarrier, HandlerCarrier>`: owns exactly the proxy
 * target, handler, and revoked state -- no more, no less. Every internal
 * method performs standard trap lookup on `handler`, invokes a found trap
 * through generic `Call`, enforces the trap's invariants against `target`,
 * and otherwise forwards to `target`'s own corresponding internal method with
 * the *original* receiver -- never the proxy, never the handler. Once
 * `revoked` is true every internal method must throw before any lookup runs.
 */
export interface ProxyObjectSubstrate<
  TargetCarrier extends OrdinaryObjectSubstrate,
  HandlerCarrier extends OrdinaryObjectSubstrate
> extends OrdinaryObjectSubstrate {
  readonly target: TargetCarrier
  readonly handler: HandlerCarrier
  readonly revoked: boolean
}

/**
 * A proxy over a callable target is itself callable: its `[[Call]]` traps
 * through `handler.apply` and otherwise forwards to `target.call` with the
 * original `thisArgument` -- never the proxy or the handler as receiver.
 */
export interface CallableProxyObjectSubstrate<Abi>
  extends ProxyObjectSubstrate<CallableObjectSubstrate<Abi>, OrdinaryObjectSubstrate>, CallableObjectSubstrate<Abi> {}

/**
 * A proxy over a constructor is itself a constructor: its `[[Construct]]`
 * traps through `handler.construct` and otherwise forwards to
 * `target.construct` with the original `newTarget` -- never the proxy
 * substituted in its place.
 */
export interface ConstructableProxyObjectSubstrate<Abi>
  extends ProxyObjectSubstrate<ConstructorObjectSubstrate<Abi>, OrdinaryObjectSubstrate>, ConstructorObjectSubstrate<Abi> {}
