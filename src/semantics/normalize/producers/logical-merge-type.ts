import ts from 'typescript'
import type { StructuralTypeId } from '../../../identity/ids.js'
import { classOfConstructorType } from '../derived-expression-type.js'
import { keptLeftPartTypeOf } from '../logical-result-type.js'
import type { ProducerContext } from '../producer-context.js'

/** `type` less its `undefined`/`null` members, or `null` when nothing else is left. */
const presentPartOf = (context: ProducerContext, type: StructuralTypeId): StructuralTypeId | null => {
  const nullish = (id: StructuralTypeId): boolean => {
    const shape = context.table.get(id).shape
    return shape.kind === 'primitive' && (shape.primitive === 'undefined' || shape.primitive === 'null')
  }
  const shape = context.table.get(type).shape
  if (shape.kind !== 'union') return nullish(type) ? null : type
  const present = shape.members.filter((member) => !nullish(member))
  if (present.length === shape.members.length) return type
  if (present.length === 0) return null
  return present.length === 1 ? present[0]! : context.table.intern({ kind: 'union', members: present })
}

/**
 * The receiver an optional chain (`value?.member`) reads once the guard has
 * passed: the cell less its absence.
 *
 * Asked of the checker by default -- its non-nullable type is the present part
 * of every ordinary cell. A census that gave the cell MORE physical arms than
 * the checker's type has (`record-home-arms.ts`'s record arm beside a stated
 * record union) is not ordinary: the checker's present part names only the
 * declared arms, so the guarded read became a narrowing of the cell onto them
 * -- an unchecked selection that read the live record arm as a declared one.
 * There the present part is taken from the cell's own cited type, and only
 * there: every declared arm must survive in it, so this never swaps the
 * checker's answer for a different one, only for a wider one.
 */
export const guardedReceiverTypeOf = (context: ProducerContext, receiver: ts.Expression): StructuralTypeId => {
  const raw = context.types.rawTypeAt(receiver)
  const checkerPresent = context.types.typeOf(context.checker.getNonNullableType(raw))
  const cited = context.types.typeAt(receiver)
  if (cited === context.types.typeOf(raw) || context.table.get(cited).shape.kind !== 'union') return checkerPresent
  const present = presentPartOf(context, cited)
  if (present === null || present === checkerPresent) return checkerPresent
  const membersOf = (id: StructuralTypeId): readonly StructuralTypeId[] => {
    const shape = context.table.get(id).shape
    return shape.kind === 'union' ? shape.members : [id]
  }
  const held = membersOf(present)
  const declared = membersOf(checkerPresent)
  return held.length > declared.length && declared.every((member) => held.includes(member)) ? present : checkerPresent
}

/**
 * The value a logical merge (`a ?? b`, `a || b`, `a && b`, and the merge half
 * of their assignment forms, which pass the BASE operator) publishes, read off
 * its two cited operand types -- or `null` where the checker's own answer for
 * the whole expression stands.
 *
 * ONE authority, asked by both sides of the one value: `computations.ts`
 * publishes the merge's result under this type, and `boundary.ts`'s
 * `resolveExpressionOperand` types every CITATION of that result with it. They
 * had disagreed: the citation re-asked the checker at the whole expression, so
 * `for (const d of descriptions ?? [])` over `descriptions?:
 * Iterable<Description>` saw the subtype-reduced `Iterable<...>` while
 * the merge it cited published the census's array. The `for`-`of` then minted
 * a dynamic `[Symbol.iterator]` lookup over a value carried as an
 * `array-object`, which nothing lowers
 * (`protocol:iterator:get-method:array-object`).
 */
export const logicalMergeTypeOf = (
  context: ProducerContext,
  operator: string,
  node: ts.BinaryExpression,
  leftType: StructuralTypeId,
  rightType: StructuralTypeId
): StructuralTypeId | null => {
  if (operator === '||' || operator === '??') {
    // `a ?? b` and `a || b` evaluate to the LEFT value when it is kept and the
    // RIGHT value otherwise, so the merge holds the union of the two cited
    // operand types -- the left one less the absences the operator discards,
    // which is `getNonNullableType`, the checker's own half of `a ?? b`'s
    // rule. Applied only where the right operand's cited type is not the
    // checker's own for that node: an operand this compiler re-typed
    // (`links.serialized ??= new Map()`, where the allocation is `Map<any,
    // any>` to the checker and `Map<string, number>` to `typeAt`) is exactly
    // the one the checker's expression type absorbed -- `Map<string, number> |
    // Map<any, any>` subtype-reduces to `Map<any, any>` -- so the expression
    // type describes a value nobody publishes. Elsewhere the checker's answer
    // stands: its `||` also drops falsy LITERALS from the left arm, a
    // narrowing this union would not reproduce, and no operand disagrees with
    // it there.
    //
    // The checker's answer also fails to stand where it ABSORBED an arm that
    // is not a member of it: `sd || { version }` (a fallback
    // literal for an optional class instance) is typed `Description` outright, because
    // the literal is contextually typed by the left operand and then reduced
    // away -- yet the literal is no `Description` (it has none of the
    // class's required members or methods), and it is what the merge holds
    // whenever `sd` is absent.
    const checkerRight = context.checker.getTypeAtLocation(node.right)
    const checkerWhole = context.checker.getTypeAtLocation(node)
    // A class constructor is a nominal choice: `responseType ?? DefaultResponse`
    // is typed by the checker as the structural constructor type the class
    // satisfies, which holds the right operand's values but not its class
    // identity, so the merge's family would lose the classes it selects among.
    const rightClass = classOfConstructorType(checkerRight)
    const absorbsClass =
      rightClass !== null &&
      !(checkerWhole.isUnion() ? checkerWhole.types : [checkerWhole]).some((arm) => classOfConstructorType(arm) === rightClass)
    const absorbsRight = absorbsClass || !context.checker.isTypeAssignableTo(checkerRight, checkerWhole)
    if (rightType === context.types.typeOf(checkerRight) && !absorbsRight) return null
    // The LEFT half is read from the left operand's own cited type when a
    // census re-typed it too. An options parser that fills `const
    // parsed = Object.create(null)`, which the checker types `any` at
    // every read while the bag census proves `proxyPort?: number` and
    // `proxyUsername?: string`: the checker's left half made
    // `parsed.proxyPort || parsed.proxyUsername` a `dynamic |
    // string` merge that the number the left operand really carries had no
    // conversion into. Only nullish members are dropped -- the falsy literals
    // `||` also discards stay, a wider but sound arm.
    const checkerLeft = context.checker.getTypeAtLocation(node.left)
    const leftRetyped = leftType !== context.types.typeOf(checkerLeft)
    const kept = leftRetyped ? presentPartOf(context, leftType) : context.types.typeOf(context.checker.getNonNullableType(checkerLeft))
    if (kept === null) return rightType
    return kept === rightType ? kept : context.table.intern({ kind: 'union', members: [kept, rightType] })
  }
  if (operator !== '&&') return null
  // `&&` is the same merge as `||` and `??` above, and its result alone kept
  // coming from a second checker query at the whole expression -- which is
  // exactly the query that cannot see what the operand censuses proved.
  //
  // The shape: a JavaScript record field `denseFog: ( !! fog &&
  // fog.isDenseFog )`. `fog` is `?(Fog|DenseFog)` and `isDenseFog` is declared on
  // only ONE arm, so the checker types the property read `any` (a missing
  // member on a union is an error type, silent in JS) and therefore types the
  // whole `&&` `any`. The member census does NOT agree: it publishes the read
  // as `optional`, having proved the absent arm. The operation's own right
  // operand thus cites `optional` while its result cited `dynamic` -- one
  // expression, two authorities -- and the `dynamic` propagated into the
  // large record literal holding that field.
  //
  // The kept half of the left operand is the FALSY arms, not
  // `getNonNullableType`: `&&` discards the truthy ones. Where there are none
  // -- an object-typed guard, `obj && obj.x` -- the expression IS the right
  // operand, and saying so is what keeps a class carrier from being unioned
  // into a numeric answer.
  if (rightType === context.types.typeOf(context.checker.getTypeAtLocation(node.right))) return null
  const keptType = keptLeftPartTypeOf(context.checker, '&&', context.checker.getTypeAtLocation(node.left))
  // An `any`/`unknown` guard keeps an arm that states nothing, and a union
  // built on it states nothing either -- `inferred-logical-result` (`/**
  // @param {*} value */ value && value.isMarker`) is the measured case: this
  // rule fired because the right operand was re-typed, and unioned `dynamic`
  // against it, producing a carrier no producer publishes and losing the
  // program's emission entirely. The rule exists to stop a STALE expression
  // type from overriding PROVEN operand carriers; where the kept half is
  // itself unproven there is nothing to prove with, and the checker's own
  // answer for the expression -- equally unproven, but the one every consumer
  // already agrees on -- stands.
  if (keptType !== null && (keptType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0) {
    const kept = context.types.typeOf(keptType)
    return kept === rightType ? kept : context.table.intern({ kind: 'union', members: [kept, rightType] })
  }
  // No falsy arm at all -- an object-typed guard -- means the expression IS
  // the right operand, which is exact and needs no union.
  if (keptType === null) return rightType
  return null
}
