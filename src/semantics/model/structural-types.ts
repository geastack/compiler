import type { DeclarationId, StructuralTypeId } from '../../identity/ids.js'

/**
 * Canonical, target-neutral structural types.
 *
 * This table answers "what shape is this value" and nothing else. C++ spelling,
 * ownership, storage, and ABI passing are representation facts and belong to a
 * later layer; putting them here is what produces two answers for one value.
 *
 * Two shapes are the same shape only when their canonical keys are equal. A
 * checker display string is never that key: `typeToString` prints two unrelated
 * anonymous objects identically, and prints one type differently depending on
 * the scope it was printed from.
 */

/** Primitive domains that need no further structure to be identified. */
export const primitiveShapes = [
  'never',
  'void',
  'undefined',
  'null',
  'boolean',
  'number',
  'bigint',
  'string',
  'symbol',
  'unknown',
  'any'
] as const

export type PrimitiveShape = (typeof primitiveShapes)[number]

/**
 * The bodies behind an accessor-backed member.
 *
 * A member written `get width() { ... }` has no storage: reading it runs a
 * body. The declarations are named here rather than left to the allocation
 * site because the *shape* is what decides the member's physical layout, and a
 * shape that could not tell an accessor from a data property would lay out a
 * field for something that has none.
 *
 * Either half may be absent -- a get-only member really has no setter, and
 * writing it is a defect the target refuses by name.
 */
export interface StructuralAccessor {
  readonly getter: DeclarationId | null
  readonly setter: DeclarationId | null
}

/** One member of an object shape. */
export interface StructuralMember {
  readonly key: PropertyKeyShape
  readonly type: StructuralTypeId
  readonly optional: boolean
  readonly readonly: boolean
  /** The bodies backing this member, or `null` when it is an ordinary data property. */
  readonly accessor: StructuralAccessor | null
}

/**
 * A property key as the language sees it: a string, a number that is an array
 * index, or a symbol with a stable declaration identity. A computed key whose
 * value is not statically known is not a key shape -- it is a `ToPropertyKey`
 * operation, and modelling it here would let a dynamic key masquerade as static.
 */
export type PropertyKeyShape =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'symbol'; readonly declaration: DeclarationId }

/** One element position of a tuple shape, with its full element semantics. */
export interface TupleElement {
  readonly type: StructuralTypeId
  readonly optional: boolean
  readonly rest: boolean
  readonly variadic: boolean
}

/** One parameter of a signature shape. */
export interface SignatureParameter {
  readonly type: StructuralTypeId
  /**
   * The type the physical SLOT holds, which is not always the type the body
   * binds.
   *
   * An omitted argument is `undefined`, and a defaulted parameter's initializer
   * runs inside the callee over exactly this slot -- so the slot has to hold
   * "the caller supplied nothing" alongside the payload, while the body binds
   * the payload with that state already eliminated.
   *
   * It is a TYPE and not a flag on top of `type` because widening is a union,
   * and a union is a question only the checker can answer canonically. Layering
   * an absence flag over an already-derived carrier -- what this used to do --
   * cannot express `T | null | undefined`: one flag cannot say which of the two
   * absent values it holds, so `function f(x: T | null = null)` was refused
   * outright, and the JSDoc spelling of it (`@param {?T} [x=null]`, which
   * three.js writes 100+ times) reached the deriver as an already-flat
   * three-armed union and got a redundant fourth state stacked on top. Both are
   * the same mistake: the widening belongs where types are made, not where
   * carriers are chosen.
   *
   * Equal to `type` for a parameter that is neither optional nor defaulted, and
   * for a rest parameter -- whose declared type is already the array the
   * language binds, with no omission to encode.
   */
  readonly slot: StructuralTypeId
  readonly optional: boolean
  readonly rest: boolean
  readonly hasInitializer: boolean
}

/** A callable or constructable signature. */
export interface SignatureShape {
  readonly parameters: readonly SignatureParameter[]
  readonly minimumArity: number
  readonly thisParameter: StructuralTypeId | null
  readonly result: StructuralTypeId
}

/**
 * The structural shape union.
 *
 * `unresolved` is lattice bottom. It is not a shape that a value can have; it
 * records that normalization could not name the shape, and it must fail closed
 * if it reaches representation. It is never interchangeable with `any`, which
 * is a shape the program itself declared.
 */
export type StructuralShape =
  | { readonly kind: 'primitive'; readonly primitive: PrimitiveShape }
  | { readonly kind: 'literal'; readonly primitive: 'boolean' | 'number' | 'bigint' | 'string'; readonly text: string }
  | { readonly kind: 'unique-symbol'; readonly declaration: DeclarationId }
  /**
   * A named declaration reference: interface, enum, or type alias.
   *
   * `body` is the structure the name stands for, interned separately so the
   * nominal identity and the layout stay one answer instead of two. It is
   * `null` only when the declaration has no structural body to name -- an enum
   * is the case that actually occurs -- and consumers must fail closed there
   * rather than inventing a layout.
   */
  | {
      readonly kind: 'declared'
      readonly declaration: DeclarationId
      readonly typeArguments: readonly StructuralTypeId[]
      readonly body: StructuralTypeId | null
    }
  /**
   * The constructor object of a class, distinct from instances of that class.
   *
   * `construct` is the signature shape `new` invokes. Without it the constructor
   * object is a value with no calling convention, and every `new C()` fails to
   * select a carrier -- `null` only when the class declares no construct
   * signature at all.
   */
  | {
      readonly kind: 'class-constructor'
      readonly declaration: DeclarationId
      readonly typeArguments: readonly StructuralTypeId[]
      readonly construct: StructuralTypeId | null
    }
  /**
   * An instance of a class, distinct from the class's constructor object.
   *
   * `body` is the instance's own structure, interned separately so the nominal
   * identity and the layout stay one answer instead of two -- the same split
   * `declared` uses, and for the same reason: a member whose type refers back to
   * the class resolves to the anchor rather than re-entering translation. It is
   * `null` only for a class the compiler did not define, whose layout belongs to
   * a host protocol rather than to a struct guessed here.
   */
  | {
      readonly kind: 'class-instance'
      readonly declaration: DeclarationId
      readonly typeArguments: readonly StructuralTypeId[]
      readonly body: StructuralTypeId | null
    }
  /**
   * The nominal anchor a callable-bearing object literal gets so a method or
   * accessor member reading `this` back to the literal resolves to a finite
   * carrier instead of recursing -- `structural.ts`'s eager, declaration-keyed
   * anchor in `translate`'s plain-object branch, for a literal with at least
   * one method or accessor member and therefore no safe way to intern its
   * shape directly (the member walk could re-enter the literal's own type
   * through the member's own receiver before the literal has any id to
   * resolve to).
   *
   * `body` is never `null`, unlike `declared`/`class-instance`: an object
   * literal is always defined in-program, so its body is always built the
   * instant the anchor is reserved, never deferred to a host protocol.
   */
  | {
      readonly kind: 'object-anchor'
      readonly declaration: DeclarationId
      readonly body: StructuralTypeId
    }
  | {
      readonly kind: 'object'
      readonly members: readonly StructuralMember[]
      readonly index: readonly StructuralIndexShape[]
      /**
       * Whether callable members were FILTERED OUT of `members` when this
       * body was interned. An ambient declaration is enumerated `data-only`
       * (`structural.ts`), so a host interface full of methods and a plain
       * data record arrive here looking identical -- and any later question
       * of the form "is this shape pure data?" would read the projection as
       * the answer. This bit is the difference the filter destroyed, kept
       * next to the members it applies to rather than re-derived from a
       * checker type no later layer still holds.
       */
      readonly membersDropped: boolean
    }
  /**
   * `extension` is the data an interface ADDS to the Array it extends --
   * TypeScript's own `NodeArray<T> extends ReadonlyArray<T>, ReadonlyTextRange`
   * carries `pos`, `end`, `hasTrailingComma` on every node list -- and is
   * empty for a plain `T[]`. Stated on the array shape rather than as an
   * object shape holding the array's members, because the value IS an array:
   * every consumer indexes and iterates it, and enumerating `map<U>`,
   * `filter<S>` and the rest as storage members interned type parameters no
   * copy could ever bind (230 "reached representation without
   * monomorphization" rows on the tsc self-compile, one shape).
   */
  | {
      readonly kind: 'array'
      readonly element: StructuralTypeId
      readonly readonly: boolean
      readonly extension: readonly StructuralMember[]
    }
  | { readonly kind: 'tuple'; readonly elements: readonly TupleElement[]; readonly readonly: boolean }
  | { readonly kind: 'union'; readonly members: readonly StructuralTypeId[] }
  /**
   * `declaration` is the type ALIAS this intersection was written as, when it
   * was written as one at all (`type Rgb565 = number & { readonly __geaRgb565:
   * unique symbol }`) -- `null` for an intersection spelled inline.
   *
   * Carried because a branded alias is the one shape where the nominal name
   * outranks the structure: `Rgb565`'s substantive member is `number`, so the
   * brand erases to `double` and the host's own carrier for the name (the
   * plugin's `nativeTypes`) is lost. `representation/derive.ts` reads it for
   * exactly that -- and only where an installed host states a carrier for the
   * declaration, so an ordinary aliased intersection derives as it always did.
   *
   * Deliberately NOT part of the canonical key below. A brand member is a
   * `unique symbol`, which is tied to its own declaration, so two different
   * branded aliases can never share a member set and are already distinct
   * shapes; keying on it would only split the intersections that legitimately
   * DO share one -- two aliases of the same `A & B` -- into two record structs
   * where one is correct.
   */
  | {
      readonly kind: 'intersection'
      readonly members: readonly StructuralTypeId[]
      readonly declaration: DeclarationId | null
      /**
       * The object shape the CHECKER says this intersection reduces to, or
       * `null` where it was interned without one.
       *
       * "What does key `k` of `A & B` hold" has one right answer and TypeScript
       * already computes it: `getPropertiesOfType` on an intersection
       * synthesizes each property with the constituents' types already
       * intersected, and `getIndexInfosOfType` does the same for index
       * signatures. Deriving that answer a second time from `members` -- which
       * is what `representation/derive.ts` used to do, reconciling carriers
       * pairwise -- is a second authority over one question, and the two
       * disagreed exactly where TypeScript's own reduction is not carrier
       * equality: `{ [k: string]: number } & { [k: string]: any }` is
       * `[k: string]: any` to the checker, and two irreconcilable carriers to a
       * pairwise merge.
       *
       * `members` stays beside it because the questions that are NOT type
       * arithmetic still need it: which member is nominal, which alias a host
       * binds, whether every member is callable. Those are carrier decisions
       * the checker does not make, and `derive.ts` answers them from `members`
       * before it ever reads this.
       *
       * Deliberately NOT part of the canonical key below, for the same reason
       * `declaration` is not: it is a function of `members`, so keying on it
       * could only split shapes that legitimately share one.
       */
      readonly resolved: StructuralTypeId | null
    }
  | {
      readonly kind: 'signature'
      readonly call: readonly SignatureShape[]
      readonly construct: readonly SignatureShape[]
      /**
       * The generic SOURCE function this open signature is the type of, when
       * it is one: `typeof identity` for `function identity<T>(x: T): T`, read
       * from a view that binds none of its type parameters.
       *
       * A value of that type is not a callable the runtime can hold -- there
       * is no one frame -- it is a CHOICE of which generic function a cell
       * holds, and every call through it instantiates the function it chose.
       * `representation/derive.ts` carries it as `generic-function-set`, a
       * tag over the member declarations; a union of such types is one set.
       * Part of the key: two generic functions with one spelling are two
       * different choices.
       */
      readonly generic?: DeclarationId
    }
  | { readonly kind: 'type-parameter'; readonly declaration: DeclarationId }
  /** Bottom. Normalization could not name the shape; consumers must fail closed. */
  | { readonly kind: 'unresolved'; readonly reason: string; readonly fallback?: 'erased-type-expression' }

/** An index signature: the key domain and the value it yields. */
export interface StructuralIndexShape {
  readonly key: 'string' | 'number' | 'symbol'
  readonly value: StructuralTypeId
  readonly readonly: boolean
  /** Declared symbol data members whose evaluated keys live in this native index. */
  readonly runtimeMembers?: readonly DeclarationId[]
  /** This index stores only the named members; it does not broaden the public keyof domain. */
  readonly finite?: boolean
}

export const runtimeSymbolMemberIndexOf = (
  shape: Extract<StructuralShape, { kind: 'object' }>,
  key: PropertyKeyShape
): StructuralIndexShape | null =>
  key.kind === 'symbol' ? (shape.index.find((index) => index.runtimeMembers?.includes(key.declaration)) ?? null) : null

/** A shape plus the canonical identity it was interned under. */
export interface StructuralType {
  readonly id: StructuralTypeId
  readonly shape: StructuralShape
}

/**
 * The canonical static property-key text for a symbol-named member.
 *
 * A symbol has no printable name a member could be keyed by -- two symbols a
 * program never confuses can share a description. A `unique symbol` has a
 * stable structural declaration identity, but each evaluation of that
 * declaration can still create a different runtime Symbol. This marker names
 * the logical member only; runtimeMembers indexes retain evaluated keys rather
 * than reconstructing runtime identity from it. The marker is minted here
 * because three
 * separate consumers need to agree on it exactly:
 *
 * - `structuralShapeKey` below, which keys a shape by its members;
 * - `representation/object-shape.ts`'s `recordFieldKeyOf`, which names the
 *   record field a symbol-named member lays out as;
 * - the producers (`properties.ts`, `class-lifecycle.ts`), which publish the
 *   *constant* key operand a `this[SOME_SYMBOL]` access and a
 *   `[SOME_SYMBOL] = ...` field definition each carry.
 *
 * The third is what makes a symbol-named member reachable at all: the checker
 * resolves `this[GEA_STATIC_ELEMENT]` to a declared member exactly as it
 * resolves `this.rendered`, so the key is compile-time-known and the access is
 * an ordinary struct member load. Two of these three spelled the rule
 * independently before; a fourth copy in a producer is what would eventually
 * disagree, and a disagreement here is a field write that lands on a member no
 * read ever finds.
 */
/**
 * The generic source functions a shape is a choice over, or `null` when it is
 * not such a choice: one open generic signature (see the `generic` field
 * above) or a union of them, every member being one. Sorted, so the same set
 * spelled in two orders is one answer; a call site's closed-family targets and
 * the carrier's tag both read this order.
 */
export const genericFunctionSetMembersOf = (
  shapeOf: (id: StructuralTypeId) => StructuralShape | null,
  shape: StructuralShape
): readonly DeclarationId[] | null => {
  if (shape.kind === 'signature') return shape.generic ? [shape.generic] : null
  if (shape.kind !== 'union' || shape.members.length === 0) return null
  const members = new Set<DeclarationId>()
  for (const member of shape.members) {
    const inner = shapeOf(member)
    if (!inner || inner.kind !== 'signature' || !inner.generic) return null
    members.add(inner.generic)
  }
  return [...members].sort()
}

export const symbolPropertyKeyText = (declaration: DeclarationId): string => `sym(${declaration})`

/** Decode the shared structural symbol-member marker. */
export const symbolPropertyKeyDeclarationOf = (key: string): string | null => {
  if (!key.startsWith('sym(') || !key.endsWith(')')) return null
  const declaration = key.slice(4, -1)
  return declaration.length > 0 ? declaration : null
}

// An accessor-backed member and a data property of the same name and type lay
// out differently -- one has storage, the other a body -- so they are not the
// same shape and must not intern as one.
const keyOfMember = (member: StructuralMember): string =>
  `${keyOfPropertyKey(member.key)}${member.optional ? '?' : ''}:${member.type}` +
  (member.accessor ? `~${member.accessor.getter ?? '-'}/${member.accessor.setter ?? '-'}` : '')

const keyOfPropertyKey = (key: PropertyKeyShape): string => {
  if (key.kind === 'symbol') return symbolPropertyKeyText(key.declaration)
  return `${key.kind}(${JSON.stringify(key.value)})`
}

const keyOfSignature = (signature: SignatureShape): string =>
  [
    signature.parameters
      .map(
        (parameter) =>
          `${parameter.type}${parameter.optional ? '?' : ''}${parameter.rest ? '...' : ''}${parameter.hasInitializer ? '=' : ''}`
      )
      .join(','),
    signature.minimumArity,
    signature.thisParameter ?? '-',
    signature.result
  ].join(';')

/**
 * The canonical key of a shape.
 *
 * Interning by this key is what makes "same shape" mean "same identity". Every
 * component that distinguishes two values semantically must appear here, and
 * nothing that does not -- a source name, a print form -- may appear at all.
 */
export const structuralShapeKey = (shape: StructuralShape): string => {
  switch (shape.kind) {
    case 'primitive':
      return `primitive:${shape.primitive}`
    case 'literal':
      return `literal:${shape.primitive}:${shape.text}`
    case 'unique-symbol':
      return `unique-symbol:${shape.declaration}`
    case 'declared':
      return `declared:${shape.declaration}:${shape.typeArguments.join(',')}:${shape.body ?? '-'}`
    case 'class-constructor':
      return `class-constructor:${shape.declaration}:${shape.typeArguments.join(',')}:${shape.construct ?? '-'}`
    case 'class-instance':
      return `class-instance:${shape.declaration}:${shape.typeArguments.join(',')}`
    case 'object-anchor':
      // The nominal identity a callable-bearing object literal anchors under.
      // Keyed by the literal's own `ObjectLiteralExpression` declaration plus
      // its body's structural id, mirroring `declared`'s own key shape
      // exactly -- the two are the same *kind* of nominal reference, differing
      // only in what names the anchor (a language declaration versus a
      // literal's own source position).
      return `object-anchor:${shape.declaration}:${shape.body}`
    case 'object':
      // `membersDropped` IS part of this key, unlike `readonly` below.
      //
      // It is not a modifier over the same members -- it says the member list
      // is not the type's own, because a projection already filtered it. An
      // empty record and an ambient body whose methods were all dropped both
      // arrive here with zero members, and interning them together makes the
      // FIRST one to arrive decide the flag for every later one: `intern`
      // returns the existing id and discards the incoming shape, so `byId`
      // holds whichever shape got there first. Measured on the three.js app before
      // this line existed: 722 genuinely empty `{}` and 28 methods-only
      // projections collapsed onto one id, the projection won the race, and
      // 722 real empty records read back "members were dropped".
      //
      // That is not inert. `hasNativeEnumerationCursor`'s
      // `isCompleteRecordBody` refused a native cursor for six `for`-`in`
      // receivers that are physically empty records -- against its own doc,
      // which says a zero-member body "is a legitimate, trivially-complete
      // snapshot ... not a reason to refuse". And the direction was luck: had
      // an empty literal interned first, the methods-only types would have
      // read `membersDropped: false`, been judged COMPLETE, and a static
      // field walk would enumerate fewer keys than the value has -- silently
      // wrong rather than merely refused.
      //
      // Splitting an id mints two C++ structs where there was one, which is
      // exactly why `readonly` below must NOT be keyed: `{readonly a: T}` and
      // `{a: T}` are mutually assignable, so two structs for them cannot be
      // passed to each other. That reasoning does not extend here --
      // everything is assignable to `{}`, but `{}` is not assignable to a
      // methods-only interface, so the two are already distinct types.
      // Gated on 124 programs at two commits: cert 118, emit 118, boxed
      // 64914 and violations 6 all unchanged, with three programs gaining a
      // 17-line empty-record struct that answers its own zero-key
      // enumeration natively.
      //
      // `readonly` is deliberately NOT part of this key, for either a member or
      // an index signature. It distinguishes nothing: TypeScript's own
      // assignability ignores a property's `readonly` (`{readonly a: T}` and
      // `{a: T}` are mutually assignable), the layout is byte-identical, and
      // nothing downstream of interning reads the flag -- `representation/`,
      // `projection/` and `targets/cpp/` all lay a member out from its key and
      // type alone. Keying by it therefore did only one thing: mint TWO C++
      // structs for one TypeScript type, whose values then cannot be passed to
      // each other. `core`'s own HTTP surface is the measured case -- the
      // ambient `IncomingMessage` declares four `readonly` members and the
      // runtime's `HttpIncomingMessage` declares the same four without the
      // modifier, so `http.createServer(handler)` typechecked and then refused
      // at emission for a callable whose parameter carried "the other" record.
      // The iterator protocol is the same shape a second time:
      // `producers/protocol.ts` synthesizes `{value, done}` with `readonly:
      // true`, and a program's own result literal has it false.
      return `object${shape.membersDropped ? '!' : ''}:${shape.members.map(keyOfMember).join(',')}:${shape.index.map((index) => `${index.key}:${index.value}${index.runtimeMembers ? `:members(${index.runtimeMembers.join(',')})${index.finite ? ':finite' : ''}` : ''}`).join(',')}`
    case 'array':
      return `array:${shape.element}:${shape.readonly}${shape.extension.length === 0 ? '' : `:{${shape.extension.map(keyOfMember).join(',')}}`}`
    case 'tuple':
      return `tuple:${shape.elements
        .map((element) => `${element.type}${element.optional ? '?' : ''}${element.rest ? '...' : ''}${element.variadic ? '~' : ''}`)
        .join(',')}:${shape.readonly}`
    case 'union':
      return `union:${[...shape.members].sort().join(',')}`
    case 'intersection':
      return `intersection:${[...shape.members].sort().join(',')}`
    case 'signature':
      return `signature:${shape.call.map(keyOfSignature).join('|')}:${shape.construct.map(keyOfSignature).join('|')}${shape.generic ? `:generic=${shape.generic}` : ''}`
    case 'type-parameter':
      return `type-parameter:${shape.declaration}`
    case 'unresolved':
      return `unresolved:${shape.fallback ?? 'none'}:${shape.reason}`
  }
}
