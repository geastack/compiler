import ts from 'typescript'
import { heritageClassOrInterfaceOf, type SourceClass, type ValueFlowIndex, type ValueWrite } from './model.js'
import { sourceClassKeyReadPlanOf } from './source-class-data.js'
import { classConstructorKeepsInstanceOf } from './member-call-forwarding.js'
import { unwrapNaming } from './targets.js'
import {
  annotationStatesNothing,
  isGlobalObjectConstructor,
  isStandardGlobalValue,
  isUnusableEvidence
} from '../derived-expression-type.js'
import { createPropertyKeyDomains, type PropertyKeyDomain } from '../property-key-domain.js'
import { objectPrototypeMemberNames } from '../../../representation/record-fields.js'
import {
  deferredIntrinsicProtocolLedgerOf,
  intrinsicProtocolRequirementKind,
  type DeferredIntrinsicProtocolLedger,
  type IntrinsicProtocolRequirement
} from '../deferred-intrinsic-protocols.js'
import { computedKeySetOf, type ComputedKeySetAuthority } from './computed-key-set.js'
import { closedCallableAuthorityOf } from './callable-reach.js'
import { censusArgumentsObjects } from '../arguments-objects.js'

/**
 * A member read through a receiver whose static class does not declare the
 * member, answered from the CLOSED family of objects that receiver can hold.
 *
 * three's `WebGLPrograms.getParameters` builds one 135-field shader-parameters
 * record, and three of its fields read a member only some subclasses declare:
 *
 *     glslVersion: material.glslVersion,          // ShaderMaterial only
 *     fogExp2: ( !! fog && fog.isFogExp2 ),       // FogExp2 only; Fog is a sibling root
 *     depthPacking: material.depthPacking || 0,   // MeshDepthMaterial only
 *
 * To the checker each is an unknown member of `Material` (or of the union
 * `Fog | FogExp2`) and reads `any`, so the WHOLE record -- 931 plan values,
 * and roughly a thousand more that contain it (`WebGLProgram`'s `parameters`,
 * the program cache-key helpers) -- carried a `dynamic` leaf. The
 * `subclass-member-overlay-transform.ts` source overlay covers the idiom when
 * every declarer's type text is a primitive keyword; these three spell theirs
 * with named constants (`@type {?(GLSL1|GLSL3)}`,
 * `{(BasicDepthPacking|RGBADepthPacking|...)}`) or live on a class with no
 * common base, so the overlay rightly leaves them alone.
 *
 * ## The fact this states
 *
 * JavaScript reads an absent property as `undefined`. If every object a
 * receiver can hold is an instance of an ENUMERATED set of source classes,
 * then `receiver.k` is either the value one of those classes' own data `k`
 * holds, or `undefined` for a class that has no `k` anywhere on its prototype
 * chain. The read's type is the
 * union of the declaring classes' carriers, plus `undefined` when some
 * member lacks `k`. That is exact, not an over-approximation -- provided the
 * set really is closed and nothing can give a lacking instance its own `k`.
 *
 * ## What "closed" has to prove, and where each proof comes from
 *
 * - Every instance is enumerated, and each class classified: this is
 *   `sourceClassKeyReadPlanOf` (`source-class-data.ts`), which closes the
 *   family through `ownedClassReceiverInventoryOf` (every reachable subclass,
 *   every construction attributed, no class binding handed to code that could
 *   construct or extend it unseen, no `X.prototype` use beyond a read-only
 *   method identity), walks every class's chain, and marks each class absent
 *   / data / code for `k`. A class whose `k` runs code -- a method or
 *   accessor anywhere on its chain -- refuses the read. For an absent class
 *   the plan also requires the intrinsic Object prototype intact (see "The
 *   Object obligation" below). The plan states only what classes DECLARE;
 *   an expando store is left to its caller, which is the rest of this list.
 * - No expando write of `k`: every named write of `k` in the shared flow
 *   inventory (`o.k = v`, `o['k'] = v`, compound/logical/destructuring forms)
 *   has a receiver that cannot hold a family member lacking `k`.
 * - No keyed write can create `k`: every `o[key] = v` whose key domain
 *   (`property-key-domain.ts`) may spell `k` has such a receiver too -- or is
 *   a store GUARDED by the same slot's absence test (see
 *   `guardedAbsentKeyStore`), which is `Material.setValues`'s own shape.
 * - No reflective write or prototype change: `Object.assign`/
 *   `defineProperty`/`defineProperties`/`setPrototypeOf` and their `Reflect`
 *   twins, and `o.__proto__ = v`, against a receiver that may hold a family
 *   member.
 * - Every declarer's carrier is known: a declarer whose `k` the checker types
 *   `any` (or vacuously, or as an unsubstituted type parameter) refuses the
 *   whole read -- a union with a hole in it is a guess.
 *
 * "May hold a family member" is answered from the receiver's static type and
 * nothing else: `any`/`unknown` and vacuous object types (`Object`, `{}`)
 * may hold anything; a source class may hold the family members it is, or is
 * an ancestor of; a structural type may hold a member assignable to it. A
 * receiver the checker cannot type therefore refuses, rather than being
 * trusted to be something else.
 *
 * ## Receivers the checker cannot type
 *
 * Three stores through receivers the checker types `any`:
 * `currentRenderState.state.transmissionRenderTarget[ camera.id ] = ...`,
 * `programs[ programCacheKey ] = program`, `data.arrayBuffers[ uuid ] = ...`.
 * Read from the checker alone each "may hold" a Material, and each blocked
 * the whole family. Where the checker says nothing, the caller's SETTLED
 * binding census is asked instead: it types the first receiver
 * `Record<string, WebGLRenderTarget | undefined>` and `camera.id` `number`.
 * That carrier is the value set the compiled program holds there -- storing a
 * Material into it would need a conversion from a class instance into that
 * dictionary, which certification refuses -- so a family instance cannot be
 * the receiver. A census that also has no answer leaves the checker's `any`,
 * which still refuses.
 *
 * ## The Object obligation
 *
 * The deferred protocol ledger holds a requirement only inside an active
 * capture, and the parameter census captures only its own inference. A member
 * read reaches this module at `typeAt` time, outside any capture, so the plan
 * is asked under this module's own capture, and a SURVIVING answer's
 * requirements are published under this module's ledger scope (and into any
 * capture that encloses the query). The final host mutation census discharges
 * them with everyone else's; a failure is a certification diagnostic, never a
 * silently wrong type. The scope accumulates across inference rounds, so a
 * requirement a later round no longer needs stays asked -- which can only
 * over-require.
 *
 * The obligation an absent class needs is PER KEY -- "Object.prototype
 * lacks `glslVersion`" -- and it is admitted by default exactly when the plan
 * published it in that form (`requirePrototypeKeys('Object', { names: [key]
 * })`). A plan that still publishes the whole-prototype `require('Object')`
 * is refused by default, for the reason below, and admitted only under
 * `GEA_FAMILY_MEMBER_ABSENT_KEYS=1`; `=0` refuses every absent class. A host
 * that knows its programs take the wildcard states that `=0` refusal for every
 * build loading it (`PluginCapabilities.refusesObjectPrototypeAbsenceProofs`,
 * carried on the ledger), which `=1` does not override.
 *
 * The whole-prototype form is what used to be refused BY DEFAULT. The three.js app's final host
 * census holds the `*` wildcard: `native-webgl-angle`'s troika text writes
 * `material.color.r = ...` and `this.material.opacity = ...` through
 * receivers it cannot prove non-global, and `nativeWebGL.ts` hands values to
 * `threeWebGLBufferData( ... )`. Under `*` every Object-prototype requirement
 * fails, so `glslVersion`, `isFogExp2` and `depthPacking` became 8
 * `intrinsic-protocol/Object` diagnostics and the certificate was lost -- a
 * sound outcome, but a worse one than the boxed read it replaced. A
 * preliminary scan must not substitute for that sealed evidence
 * (`deferred-intrinsic-protocols.ts`), so this module does not prove the
 * prototype intact on its own. When the census stops taking the wildcard
 * there, or a local proof of `Object.prototype` is ruled acceptable in its
 * place, the switch is the only thing to remove.
 *
 * Every refusal leaves the read exactly as it was -- `any`, boxed.
 */

interface FamilyWriteInventory {
  /** Named writes by member name, excluding an object literal's own initial members and binding-pattern reads. */
  readonly memberWrites: ReadonlyMap<string, readonly ValueWrite[]>
  /**
   * Every write that puts a value in a slot of that NAME, on ANY object --
   * `memberWrites` PLUS an object literal's own `{ k: v }` members, which that
   * map deliberately drops because they are the fresh literal's own members
   * rather than an expando on something that already existed.
   *
   * `excludesFamily` asks the opposite question -- "what can a slot of this
   * name hold" -- and for that a literal's own member IS an origin. Keyed by
   * name alone because the receiver whose slot is being asked about is
   * typically `any` (three's `data.arrayBuffers`, `clone`'s `@param {Object}`),
   * so no symbol narrows it; a union over every object in the program is the
   * only sound over-approximation available, and over-approximating can only
   * make that proof refuse.
   */
  readonly namedOrigins: ReadonlyMap<string, readonly ValueWrite[]>
  /** Computed-key writes (`o[key] = v` and its compound/logical/destructuring forms). */
  readonly keyedWrites: readonly ValueWrite[]
  /** Direct `Object.*`/`Reflect.*` calls that can add a property or change a prototype. */
  readonly reflectiveCalls: readonly { readonly call: ts.CallExpression; readonly method: string }[]
  /** A reflective method referenced other than as a direct callee: its calls cannot be enumerated. */
  readonly reflectiveAlias: ts.Node | null
  /**
   * The keyed writes whose key may spell `key` -- `keyedWrites` filtered, and
   * memoized, because a consumer asking it per member name would otherwise
   * rescan every `o[k] = v` in the program once per name.
   */
  readonly keyedWritesNaming: (key: string) => readonly ValueWrite[]
  /**
   * Whether any reflective mutator call could CREATE `key` on an object this
   * proof cannot name. Memoized for the same reason.
   */
  readonly reflectionMayCreate: (key: string) => boolean
  readonly keys: {
    readonly of: (expression: ts.Expression) => PropertyKeyDomain
    readonly mayName: (domain: PropertyKeyDomain, name: string) => boolean
  }
}

interface ClosureRefusal {
  readonly reason: string
  readonly at?: ts.Node
}

const KEYED_EDGES: ReadonlySet<ValueWrite['edge']> = new Set([
  'index-assignment',
  'compound-assignment',
  'logical-assignment',
  'destructuring',
  'destructuring-default',
  'iteration-binding'
])

/** `Object.<method>` calls that add own properties or replace the prototype. */
const OBJECT_MUTATORS: ReadonlySet<string> = new Set(['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf'])
/** `Reflect.<method>` calls that add own properties or replace the prototype. */
const REFLECT_MUTATORS: ReadonlySet<string> = new Set(['set', 'defineProperty', 'setPrototypeOf'])
const MUTATOR_OWNERS: readonly (readonly [string, ReadonlySet<string>])[] = [
  ['Object', OBJECT_MUTATORS],
  ['Reflect', REFLECT_MUTATORS]
]
const INERT_COMPARISONS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.InstanceOfKeyword
])

/**
 * A mention of the global `Object`/`Reflect` value that cannot hand one of
 * its mutators out: a member read (the member's own symbol is then scanned),
 * a call or construction of it, or an identity/`instanceof` comparison --
 * three's `value.constructor === Object` style checks.
 */
const globalValueUseIsInert = (reference: ts.Node): boolean => {
  let node = reference
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === node
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) return parent.expression === node
  return ts.isBinaryExpression(parent) && INERT_COMPARISONS.has(parent.operatorToken.kind)
}

const PRIMITIVE_FLAGS =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.EnumLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.Void |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Null |
  ts.TypeFlags.Never

const skipParentheses = (expression: ts.Expression): ts.Expression => unwrapNaming(expression)

const debugName = process.env['GEA_FAMILY_MEMBER_DEBUG']
const debugAllName = process.env['GEA_FAMILY_MEMBER_DEBUG_ALL']
/** `GEA_FAMILY_MEMBER_ORIGIN_DEBUG=<member>[,<member>]|*` names the exact sub-check that refused a member slot in `memberExcludesFamily`. */
const originDebug = process.env['GEA_FAMILY_MEMBER_ORIGIN_DEBUG']
/**
 * `GEA_MEMBER_READ_DEBUG=<member>[,<member>]|*` is `GEA_FAMILY_MEMBER_DEBUG_ALL`
 * widened two ways. First, `debugAllName`'s enumeration used to cover only the
 * write/keyed-write scan in `computeClosureRefusal`: a hit there returned
 * `blocking[0]` immediately, so the reflective-call scan right after it (
 * `Object.assign`/`defineProperties`/`Reflect.set`/…) never ran and never got
 * a chance to add its own refusals to the list. This value makes BOTH scans
 * enumerate into the same `blocking` array before anything returns. Second,
 * `classFamilyMemberReadTypeOf` (the caller) prints the Object obligation the
 * closure proof would have recorded -- `plan.needsDefaultPrototype` and the
 * requirement count -- which the closure proof itself never sees, because
 * that fact is computed one layer up, before the proof is even asked.
 */
const memberReadDebug = process.env['GEA_MEMBER_READ_DEBUG']
const memberReadWatching = (name: string): boolean =>
  memberReadDebug !== undefined && (memberReadDebug === '*' || memberReadDebug.split(',').includes(name))

/** ` file:line text` for a debug line, or nothing. */
const describeAt = (at: ts.Node | undefined): string => {
  const file = at?.getSourceFile()
  return at && file
    ? ` ${file.fileName.split('/').pop()}:${file.getLineAndCharacterOfPosition(at.getStart()).line + 1} ${at.getText().slice(0, 100)}`
    : ''
}

/** The source class an INSTANCE type is an instance of -- never `typeof C`, whose symbol is the same class symbol. */
const instanceClassOf = (type: ts.Type): SourceClass | null => {
  if ((type.flags & ts.TypeFlags.Object) === 0) return null
  const objectFlags = (type as ts.ObjectType).objectFlags
  const target = (objectFlags & ts.ObjectFlags.Reference) !== 0 ? (type as ts.TypeReference).target : type
  if (!target.isClassOrInterface() || (target.objectFlags & ts.ObjectFlags.Class) === 0) return null
  const declaration = target.getSymbol()?.valueDeclaration
  if (!declaration || (!ts.isClassDeclaration(declaration) && !ts.isClassExpression(declaration))) return null
  return declaration.getSourceFile().isDeclarationFile ? null : declaration
}

const isConstVariable = (declaration: ts.Declaration | undefined): declaration is ts.VariableDeclaration =>
  declaration !== undefined &&
  ts.isVariableDeclaration(declaration) &&
  ts.isVariableDeclarationList(declaration.parent) &&
  (declaration.parent.flags & ts.NodeFlags.Const) !== 0

const carriesTypeParameter = (type: ts.Type): boolean =>
  (type.flags & ts.TypeFlags.TypeParameter) !== 0 || (type.isUnionOrIntersection() && type.types.some(carriesTypeParameter))

const inventories = new WeakMap<ValueFlowIndex, FamilyWriteInventory>()
/**
 * A settled binding census, asked for the value set of a store receiver or key
 * the checker types `any` -- see "Receivers the checker cannot type" above.
 */
export interface FamilyReceiverCensus {
  readonly typeAt: (node: ts.Node) => ts.Type | null
}

/** Closure verdicts per flow and census, keyed by member name and the family's split: the refusal, or `null` when closed. */
/** A closure verdict alongside the intrinsic obligations it assumed -- see `closureRefusalOf`. */
interface ClosureProof {
  readonly refusal: ClosureRefusal | null
  readonly requirements: readonly IntrinsicProtocolRequirement[]
}
const closures = new WeakMap<ValueFlowIndex, WeakMap<object, Map<string, ClosureProof>>>()
const NO_CENSUS: object = {}

/**
 * Whether a computed write's key is PROVEN to range over a finite set that
 * excludes `target` -- three's `for ( const key in values ) { this[ key ] =
 * newValue }` in `Texture.setValues`/`Material.setValues`, whose `values`
 * only ever holds the options literals the program passes, none of which
 * spell `isFogExp2` or `arrayBuffers`. `computed-key-set.ts` proves the exact
 * set (`this[key]` in `Texture.setValues` is 13 keys, `Material.setValues` is
 * 7, neither containing either name).
 *
 * `false` whenever the set cannot be proven -- an open caller, an unresolved
 * alias, anything `computed-key-set.ts`'s own header lists -- and the write
 * still blocks exactly as before: this only ever NARROWS a `mayName` that was
 * already true, never widens one that was already false.
 *
 * Uses the enclosing proof's complete frame authority. The inventory of
 * possible keys must not shrink because a consumer omitted origin queries.
 */
const keyProvenToExclude = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  key: ts.Expression,
  target: string,
  authority: ComputedKeySetAuthority
): boolean => {
  const keys = computedKeySetOf(checker, flow, key, authority)
  return keys !== null && !keys.has(target)
}

/** The KEY expression of a write recorded as `receiver[key] = value` -- `null` for any other write shape. */
const elementAccessKeyOf = (write: ValueWrite): ts.Expression | null => {
  const receiver = write.naming
  const access = receiver?.parent
  if (!receiver || !access || !ts.isElementAccessExpression(access) || access.expression !== receiver) return null
  return access.argumentExpression
}

const writeInventoryOf = (checker: ts.TypeChecker, flow: ValueFlowIndex): FamilyWriteInventory => {
  const held = inventories.get(flow)
  if (held) return held
  const memberWrites = new Map<string, ValueWrite[]>()
  const namedOrigins = new Map<string, ValueWrite[]>()
  const keyedWrites: ValueWrite[] = []
  for (const write of flow.allWrites) {
    if (write.slot === 'member' && write.member !== null) {
      // `namedOrigins` takes the write before the two exclusions below: a
      // literal's own `{ k: v }` member is not an expando, but it IS one of
      // the values a slot of that name can hold. A `delete` still states only
      // that the slot existed, and a binding pattern's `member` edge is a READ.
      if (
        write.edge !== 'delete' &&
        !((write.edge === 'destructuring' || write.edge === 'destructuring-default') && ts.isBindingElement(write.site))
      ) {
        const origins = namedOrigins.get(write.member)
        if (origins) origins.push(write)
        else namedOrigins.set(write.member, [write])
      }
      // `{ k: v }` initializing a fresh literal is that literal's own member,
      // never an expando on an object that already existed; a binding
      // pattern's `member` edge is a READ of its source.
      if (ts.isPropertyAssignment(write.site) || ts.isShorthandPropertyAssignment(write.site)) continue
      if ((write.edge === 'destructuring' || write.edge === 'destructuring-default') && ts.isBindingElement(write.site)) continue
      // A delete never creates a property.
      if (write.edge === 'delete') continue
      const list = memberWrites.get(write.member)
      if (list) list.push(write)
      else memberWrites.set(write.member, [write])
    } else if (write.slot === 'element' && KEYED_EDGES.has(write.edge)) keyedWrites.push(write)
  }
  const reflectiveCalls: { call: ts.CallExpression; method: string }[] = []
  let reflectiveAlias: ts.Node | null = null
  const directCallees = new Set<ts.Node>()
  for (const { call } of flow.calls) {
    if (!ts.isCallExpression(call)) continue
    const callee = skipParentheses(call.expression)
    if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) continue
    const method = callee.name.text
    const owner = callee.expression
    const mutates =
      (OBJECT_MUTATORS.has(method) && isGlobalObjectConstructor(checker, owner, checker.getTypeAtLocation(owner))) ||
      (REFLECT_MUTATORS.has(method) && isStandardGlobalValue(checker, owner, 'Reflect'))
    if (!mutates) continue
    reflectiveCalls.push({ call, method })
    directCallees.add(callee.name)
  }
  // `const define = Object.defineProperty; define(o, 'k', d)`, or
  // `const R = Reflect; R.set(o, 'k', v)`, calls a mutator the scan above
  // never recorded. The mutators are resolved from the globals themselves,
  // not from the calls, so a program that only ever aliases one is still
  // seen: any mention other than a recorded direct callee name leaves the
  // inventory open. The globals' own values may be read for their members,
  // compared, or called; any other use (`const { defineProperty } = Object`,
  // `Object[key]`, passing `Reflect` along) hands the mutators out unnamed.
  for (const [global, methods] of MUTATOR_OWNERS) {
    let value = checker.resolveName(global, undefined, ts.SymbolFlags.Value, false)
    if (value && (value.flags & ts.SymbolFlags.Alias) !== 0) value = checker.getAliasedSymbol(value)
    if (!value) continue
    for (const reference of flow.memberReferencesToSymbol(value)) {
      if (!globalValueUseIsInert(reference) && reflectiveAlias === null) reflectiveAlias = reference
    }
    const valueType = checker.getTypeOfSymbol(value)
    for (const method of methods) {
      const member = checker.getPropertyOfType(valueType, method)
      if (!member) continue
      for (const reference of flow.memberReferencesToSymbol(member)) {
        if (!directCallees.has(reference) && reflectiveAlias === null) reflectiveAlias = reference
      }
    }
  }
  // Every write this index holds is already reachable: the flow walk prunes
  // unreachable members before it records anything.
  const keys = createPropertyKeyDomains(checker, flow, () => true)
  // A spread-free object literal is the only source that can be shown not to
  // carry `key`; anything else (a variable, a call result, a spread) may.
  const literalMayNameKey = (expression: ts.Expression | undefined, key: string): boolean => {
    const literal = expression && skipParentheses(expression)
    if (!literal || !ts.isObjectLiteralExpression(literal)) return true
    return literal.properties.some((property) => {
      if (ts.isSpreadAssignment(property)) return true
      const propertyName = property.name
      if (!propertyName) return true
      if (ts.isComputedPropertyName(propertyName)) return keys.mayName(keys.of(propertyName.expression), key)
      if (ts.isIdentifier(propertyName) || ts.isStringLiteralLike(propertyName) || ts.isNumericLiteral(propertyName)) {
        if (ts.isPropertyAssignment(property) && propertyName.text === '__proto__' && !ts.isStringLiteralLike(propertyName)) return false
        return propertyName.text === key
      }
      return true
    })
  }
  const keyedByName = new Map<string, readonly ValueWrite[]>()
  const reflectionByName = new Map<string, boolean>()
  const keyedWritesNaming = (key: string): readonly ValueWrite[] => {
    const held = keyedByName.get(key)
    if (held) return held
    const matching = keyedWrites.filter((write) => {
      const access = write.naming?.parent
      // A keyed write this layer could not attribute to an element access has
      // no key to test, so it may name anything.
      if (!write.naming || !access || !ts.isElementAccessExpression(access) || access.expression !== write.naming) return true
      return keys.mayName(keys.of(access.argumentExpression), key)
    })
    keyedByName.set(key, matching)
    return matching
  }
  const reflectionMayCreate = (key: string): boolean => {
    const held = reflectionByName.get(key)
    if (held !== undefined) return held
    const answer = reflectiveCalls.some(({ call, method }) => {
      const args = call.arguments
      // A spread hides which argument is the target and which the key.
      if (args.some(ts.isSpreadElement)) return true
      // A replaced prototype can bring any member with it.
      if (method === 'setPrototypeOf') return true
      const owner = skipParentheses(call.expression)
      const isReflect = ts.isPropertyAccessExpression(owner) && isStandardGlobalValue(checker, owner.expression, 'Reflect')
      // `Object.assign(a, b)` is NAME-PRESERVING: the only value it can put in
      // `a.k` is the one that already sat in some `b.k`, which a union keyed by
      // NAME therefore already holds. A source whose own `k` was written with a
      // COMPUTED key is the exception, and the keyed-write scan covers it.
      if (method === 'assign' && !isReflect) return false
      // `defineProperties(a, map)` is not: `a.k` becomes `map.k.value`, so the
      // value arrives under a DESCRIPTOR rather than under the name itself.
      if (method === 'defineProperties') return literalMayNameKey(args[1], key)
      // `defineProperty` (either owner) and `Reflect.set`: the value is stated
      // outright, under no name a member write would have recorded.
      const named = args[1]
      return named === undefined || ts.isSpreadElement(named) || keys.mayName(keys.of(named), key)
    })
    reflectionByName.set(key, answer)
    return answer
  }
  const inventory: FamilyWriteInventory = {
    memberWrites,
    namedOrigins,
    keyedWrites,
    reflectiveCalls,
    reflectiveAlias,
    keyedWritesNaming,
    reflectionMayCreate,
    keys
  }
  inventories.set(flow, inventory)
  return inventory
}

/**
 * Whether a keyed store can only overwrite a key the receiver already holds.
 *
 * three's `Material.setValues` is the shape, and it is the only computed-key
 * store on a `Material` receiver:
 *
 *     for ( const key in values ) {
 *       ...
 *       const currentValue = this[ key ];
 *       if ( currentValue === undefined ) { warn( ... ); continue; }
 *       ...
 *       else this[ key ] = newValue;
 *     }
 *
 * On an instance that has no `k` anywhere -- no field, nothing on its
 * prototype chain, and (inductively, since every other writer is proved not
 * to add one) no own expando -- `this[ k ]` reads `undefined`, the guard
 * leaves the iteration, and the store never runs. So the store can overwrite
 * a declarer's own `k` (which the declarer's carrier already describes) but
 * never create `k` on an instance lacking it.
 *
 * Admitted only exactly: the receiver is `this`; the key is a `const` binding
 * (so guard and store name one slot); and some statement preceding the store
 * in an enclosing block of the SAME function is `if (<absence of this[key]>)`
 * whose consequent unconditionally leaves (`continue`/`break`/`return`/
 * `throw`). The absence test reads the slot directly or through a `const`
 * initialized from it in the same function, compared `=== undefined`,
 * `== undefined`/`== null`, `typeof ... === 'undefined'`, or negated.
 */
const guardedAbsentKeyStore = (checker: ts.TypeChecker, write: ValueWrite, access: ts.ElementAccessExpression): boolean => {
  if (write.edge !== 'index-assignment' && write.edge !== 'compound-assignment' && write.edge !== 'logical-assignment') return false
  if (skipParentheses(access.expression).kind !== ts.SyntaxKind.ThisKeyword) return false
  const key = skipParentheses(access.argumentExpression)
  if (!ts.isIdentifier(key)) return false
  const keySymbol = checker.getSymbolAtLocation(key)
  if (!keySymbol || !isConstVariable(keySymbol.valueDeclaration)) return false
  const owner = ts.findAncestor(access, ts.isFunctionLike)
  if (!owner) return false
  const readsSlotDirectly = (expression: ts.Expression): boolean => {
    const read = skipParentheses(expression)
    if (!ts.isElementAccessExpression(read) || skipParentheses(read.expression).kind !== ts.SyntaxKind.ThisKeyword) return false
    const readKey = skipParentheses(read.argumentExpression)
    return (
      ts.isIdentifier(readKey) && checker.getSymbolAtLocation(readKey) === keySymbol && ts.findAncestor(read, ts.isFunctionLike) === owner
    )
  }
  const readsSlot = (expression: ts.Expression): boolean => {
    const read = skipParentheses(expression)
    if (readsSlotDirectly(read)) return true
    if (!ts.isIdentifier(read)) return false
    const declaration = checker.getSymbolAtLocation(read)?.valueDeclaration
    return isConstVariable(declaration) && declaration.initializer !== undefined && readsSlotDirectly(declaration.initializer)
  }
  const isUndefinedValue = (expression: ts.Expression): boolean => {
    const value = skipParentheses(expression)
    if (ts.isVoidExpression(value)) return true
    return ts.isIdentifier(value) && value.text === 'undefined' && isStandardGlobalValue(checker, value, 'undefined')
  }
  const testsAbsence = (condition: ts.Expression): boolean => {
    const test = skipParentheses(condition)
    if (ts.isPrefixUnaryExpression(test) && test.operator === ts.SyntaxKind.ExclamationToken) return readsSlot(test.operand)
    if (!ts.isBinaryExpression(test)) return false
    const operator = test.operatorToken.kind
    // Either disjunct holding makes the whole condition hold.
    if (operator === ts.SyntaxKind.BarBarToken) return testsAbsence(test.left) || testsAbsence(test.right)
    const strict = operator === ts.SyntaxKind.EqualsEqualsEqualsToken
    if (!strict && operator !== ts.SyntaxKind.EqualsEqualsToken) return false
    const absentValue = (side: ts.Expression): boolean =>
      isUndefinedValue(side) || (!strict && skipParentheses(side).kind === ts.SyntaxKind.NullKeyword)
    if ((absentValue(test.right) && readsSlot(test.left)) || (absentValue(test.left) && readsSlot(test.right))) return true
    const typeofSide = (side: ts.Expression, other: ts.Expression): boolean => {
      const unary = skipParentheses(side)
      const literal = skipParentheses(other)
      return ts.isTypeOfExpression(unary) && ts.isStringLiteralLike(literal) && literal.text === 'undefined' && readsSlot(unary.expression)
    }
    return typeofSide(test.left, test.right) || typeofSide(test.right, test.left)
  }
  const exits = (statement: ts.Statement): boolean => {
    if (
      ts.isContinueStatement(statement) ||
      ts.isBreakStatement(statement) ||
      ts.isReturnStatement(statement) ||
      ts.isThrowStatement(statement)
    )
      return true
    if (!ts.isBlock(statement)) return false
    const last = statement.statements[statement.statements.length - 1]
    return last !== undefined && exits(last)
  }
  for (let child: ts.Node = access, parent = access.parent; parent !== undefined; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent) || ts.isClassLike(parent) || ts.isSourceFile(parent)) return false
    if (!ts.isBlock(parent) && !ts.isCaseClause(parent) && !ts.isDefaultClause(parent)) continue
    const statements = parent.statements
    const at = statements.indexOf(child as ts.Statement)
    for (let index = 0; index < at; index++) {
      const statement = statements[index]!
      if (ts.isIfStatement(statement) && testsAbsence(statement.expression) && exits(statement.thenStatement)) return true
    }
  }
  return false
}

const familyKeyOf = (classes: Iterable<SourceClass>): string =>
  [...classes]
    .map((owner) => `${owner.getSourceFile().fileName}:${owner.pos}`)
    .sort()
    .join(',')

/**
 * What can give a `lacking` instance its own `name`, or replace a family
 * instance's prototype -- the part of closure `sourceClassKeyReadPlanOf`
 * leaves to its caller. `null` when nothing can. The write inventory and every
 * type this consults are fixed for one flow index, so the verdict is cached
 * per flow, member name and family split; the plan itself, and the ledger
 * obligation it raises, is asked again on every query.
 */
const closureRefusalOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  instances: ReadonlyMap<SourceClass, ts.InterfaceType>,
  lacking: ReadonlySet<SourceClass>,
  name: string,
  census: FamilyReceiverCensus | null
): ClosureProof => {
  let byCensus = closures.get(flow)
  if (!byCensus) closures.set(flow, (byCensus = new WeakMap()))
  let byKey = byCensus.get(census ?? NO_CENSUS)
  if (!byKey) byCensus.set(census ?? NO_CENSUS, (byKey = new Map()))
  const key = `${name}|${familyKeyOf(instances.keys())}|${familyKeyOf(lacking)}`
  const held = byKey.get(key)
  if (held) return held
  // The finite-key-set consultation `computeClosureRefusal` may now make
  // (via `keyProvenToExclude`) is itself an intrinsic obligation --
  // `computedKeySetOf`'s for-in/`Object.keys` arms register a requirement on
  // whichever capture is ACTIVE (`deferred-intrinsic-protocols.ts`), and with
  // none active that registration silently no-ops. Wrapping the whole proof
  // in one capture here, once, is what lets a memoized cache hit still carry
  // forward the obligations the FIRST computation incurred: they are stored
  // beside the verdict and replayed by the caller on every hit, never
  // re-derived and never dropped.
  const ledger = deferredIntrinsicProtocolLedgerOf(flow)
  const proof: ClosureProof = ledger
    ? (({ value, requirements }) => ({ refusal: value, requirements }))(
        ledger.capture(() => computeClosureRefusal(checker, flow, instances, lacking, name, census))
      )
    : { refusal: computeClosureRefusal(checker, flow, instances, lacking, name, census), requirements: [] }
  byKey.set(key, proof)
  return proof
}

const computeClosureRefusal = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  instances: ReadonlyMap<SourceClass, ts.InterfaceType>,
  lacking: ReadonlySet<SourceClass>,
  name: string,
  census: FamilyReceiverCensus | null
): ClosureRefusal | null => {
  const refuse = (reason: string, at?: ts.Node): ClosureRefusal => (at ? { reason, at } : { reason })
  /** The checker's type, or -- only where the checker says nothing -- the settled census's. */
  const typeOf = (expression: ts.Expression): ts.Type => {
    const own = checker.getTypeAtLocation(expression)
    if (!census || (own.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0) return own
    const settled = census.typeAt(expression)
    return settled && (settled.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0 ? settled : own
  }
  let keysAuthority: ComputedKeySetAuthority | undefined
  const completeKeys = (): ComputedKeySetAuthority => {
    if (keysAuthority) return keysAuthority
    const argumentsByFile = new Map<ts.SourceFile, ReturnType<typeof censusArgumentsObjects>>()
    keysAuthority = closedCallableAuthorityOf(checker, flow, typeOf, (owner) => {
      const file = owner.getSourceFile()
      let census = argumentsByFile.get(file)
      if (!census) argumentsByFile.set(file, (census = censusArgumentsObjects(checker, [file])))
      return census.usesByOwner.get(owner)
    })
    return keysAuthority
  }
  const family = new Set(instances.keys())
  const ancestorsOf = new Map<SourceClass, ReadonlySet<SourceClass>>()
  const ancestry = (member: SourceClass): ReadonlySet<SourceClass> => {
    const known = ancestorsOf.get(member)
    if (known) return known
    const found = new Set<SourceClass>()
    const visit = (type: ts.Type): void => {
      const declared = heritageClassOrInterfaceOf(type)
      for (const base of declared === null ? [] : checker.getBaseTypes(declared)) {
        const declaration = instanceClassOf(base)
        if (declaration && !found.has(declaration)) found.add(declaration)
        visit(base)
      }
    }
    visit(instances.get(member)!)
    ancestorsOf.set(member, found)
    return found
  }
  const typeMayHold = (type: ts.Type, targets: ReadonlySet<SourceClass>, depth = 0): boolean => {
    if (depth > 8 || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return true
    if (type.isUnionOrIntersection()) return type.types.some((part) => typeMayHold(part, targets, depth + 1))
    if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
      const constraint = checker.getBaseConstraintOfType(type)
      return constraint === undefined || constraint === type ? true : typeMayHold(constraint, targets, depth + 1)
    }
    if ((type.flags & PRIMITIVE_FLAGS) !== 0) return false
    if ((type.flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive)) === 0) return true
    const declaration = instanceClassOf(type)
    if (declaration) return [...targets].some((target) => target === declaration || ancestry(target).has(declaration))
    return [...targets].some((target) => checker.isTypeAssignableTo(instances.get(target)!, type))
  }
  /**
   * Whether every value `expression` can hold was allocated by something that
   * is not a family constructor -- `const cache = {}` in three's
   * `WebGLPrograms`/`WebGLShaderCache`, typed `{}` by the checker and so
   * assignable-from every class. A literal is a fresh object; a `new` of a
   * library constructor or of a source class outside the family (whose
   * constructor provably returns its own `this`) is an instance of that class;
   * an unwritten-elsewhere `const`/`let` holds only what its writes put there.
   */
  const excludesFamily = (expression: ts.Expression, active = new Set<ts.Node>()): boolean => {
    let value = skipParentheses(expression)
    while (ts.isAsExpression(value) || ts.isTypeAssertionExpression(value) || ts.isSatisfiesExpression(value))
      value = skipParentheses(value.expression)
    if (active.has(value)) return true
    active.add(value)
    if (
      ts.isObjectLiteralExpression(value) ||
      ts.isArrayLiteralExpression(value) ||
      ts.isFunctionExpression(value) ||
      ts.isArrowFunction(value) ||
      ts.isRegularExpressionLiteral(value)
    )
      return true
    if (ts.isNewExpression(value)) {
      const constructed = checker.getTypeAtLocation(value)
      const declaration = instanceClassOf(constructed)
      if (declaration) {
        const instance = constructed.isClassOrInterface() ? constructed : null
        return (
          !family.has(declaration) &&
          ![...family].some((member) => ancestry(member).has(declaration)) &&
          instance !== null &&
          classConstructorKeepsInstanceOf(checker, flow, instance)
        )
      }
      const callee = checker.getSymbolAtLocation(value.expression)?.valueDeclaration
      return callee !== undefined && callee.getSourceFile().isDeclarationFile && !typeMayHold(constructed, family)
    }
    if (ts.isPropertyAccessExpression(value)) return memberExcludesFamily(value.name.text, active)
    if (!ts.isIdentifier(value)) return false
    const declaration = flow.targetOf(value)?.declaration
    if (!declaration || !ts.isVariableDeclaration(declaration)) return false
    const whole = flow.writesToDeclaration(declaration).filter((write) => write.slot === 'whole')
    return (
      whole.length > 0 &&
      whole.every(
        (write) =>
          (write.edge === 'declaration-initializer' || write.edge === 'identifier-assignment') &&
          write.value !== null &&
          excludesFamily(write.value, active)
      )
    )
  }
  /**
   * `excludesFamily` for a MEMBER slot: what can a slot of this name hold,
   * anywhere in the program.
   *
   * The receiver is asked by NAME rather than by symbol because the receivers
   * that reach here have none -- three's `data.arrayBuffers` is an expando on
   * a `@param {Object} [data]`, so the checker declares no such member and
   * `flow.targetOf` resolves nothing. A union over every object in the
   * program is the sound over-approximation of "some object whose slot of
   * this name is being written": it can only add values, so it can only make
   * this proof refuse.
   *
   * For that union to be a superset, every way a slot can acquire a value has
   * to be accounted for, and each one that cannot be enumerated is a refusal:
   * an ACCESSOR is not a stored slot at all (its value is whatever the body
   * returns, and no write records it); a REFLECTIVE mutator can create any
   * name on any object; and a KEYED store whose key may spell this name is
   * one more origin of it. What remains is the recorded writes, and every one
   * of them must state a value that excludes the family.
   */
  const memberExcludesFamily = (key: string, active: Set<ts.Node>): boolean => {
    // Which of the five sub-checks refused decides what to fix, and they are
    // indistinguishable from the outside. See `originDebug`.
    const tracing = originDebug !== undefined && (originDebug === '*' || originDebug.split(',').includes(key))
    const traced = (reason: string, at?: ts.Node): false => {
      if (tracing) console.error(`[FAMILY-MEMBER-ORIGIN] ${key} ${reason}${at ? describeAt(at) : ''}`)
      return false
    }
    if (flow.hasComputedAccessorName) return traced('computed-accessor-name-somewhere')
    if (flow.accessorNames.has(key)) return traced('declared-by-an-accessor')
    if (writes.reflectionMayCreate(key)) return traced('reflective-mutator-may-create')
    // The same conjunction `mayHold` uses, and for the same reason: the
    // checker's own answer settles most origins outright (`x.slice(0).buffer`
    // is an `ArrayBufferLike`, and no class in the family is one), and only a
    // value the checker cannot rule out needs its allocation traced. Asking
    // `excludesFamily` alone would refuse every host-typed value, because a
    // member no source file writes has no origin to enumerate.
    const cannotBeFamily = (value: ts.Expression | null): boolean =>
      value !== null && (!typeMayHold(typeOf(value), family) || excludesFamily(value, active))
    for (const keyed of writes.keyedWritesNaming(key)) {
      // `keyedWritesNaming` answers from `property-key-domain.ts`'s coarser,
      // forever-cached "may name" proof; `computed-key-set.ts` can PROVE a
      // finite key set for the same expression (a `for (const k in values)`
      // loop closed over an options literal, three's `Texture`/`Material`
      // `setValues`) and rule this one write out even where that coarser
      // proof would not. Asked fresh on every call -- never folded into that
      // cache -- so the intrinsic requirement it raises lands in whichever
      // capture `closureRefusalOf` has open right now, not a stale one from
      // an earlier round or a different family.
      const keyExpression = elementAccessKeyOf(keyed)
      if (keyExpression && keyProvenToExclude(checker, flow, keyExpression, key, completeKeys())) continue
      if (!cannotBeFamily(keyed.value)) return traced('keyed-write-may-create', keyed.site)
    }
    const origins = writes.namedOrigins.get(key) ?? []
    if (origins.length === 0) return traced('no-origin')
    for (const write of origins) if (!cannotBeFamily(write.value)) return traced('origin-unproven', write.site)
    return true
  }
  const mayHold = (expression: ts.Expression | null, targets: ReadonlySet<SourceClass>): boolean =>
    expression === null || (targets.size > 0 && typeMayHold(typeOf(expression), targets) && !excludesFamily(expression))
  /** A key typed purely number/symbol can never spell an identifier-shaped `name` (numeric names are refused up front). */
  const keyCannotName = (key: ts.Expression): boolean => {
    const type = typeOf(key)
    const parts = type.isUnion() ? type.types : [type]
    const typed = parts.every(
      (part) =>
        (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0 &&
        (part.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.ESSymbolLike)) !== 0
    )
    if (typed || !writes.keys.mayName(writes.keys.of(key), name)) return true
    return keyProvenToExclude(checker, flow, key, name, completeKeys())
  }
  const writes = writeInventoryOf(checker, flow)
  if (writes.reflectiveAlias) return refuse('reflective-mutator-escapes', writes.reflectiveAlias)
  // `GEA_FAMILY_MEMBER_DEBUG_ALL=<name|*>` (or the newer `GEA_MEMBER_READ_DEBUG`,
  // see its own comment) lists EVERY store that blocks the family rather than
  // stopping at the first -- which one to discharge next. Without it the scan
  // still returns at the first refusal. The two write scans below AND the
  // reflective-call scan after them all feed the same `blocking` array, so a
  // member blocked by e.g. one keyed write and one `Reflect.set` reports both
  // in one run instead of needing a re-run per fix.
  const listing = (debugAllName !== undefined && (debugAllName === '*' || debugAllName === name)) || memberReadWatching(name)
  const blocking: ClosureRefusal[] = []
  const blocked = (reason: string, at: ts.Node): ClosureRefusal | null => {
    const refusal = refuse(reason, at)
    if (!listing) return refusal
    blocking.push(refusal)
    return null
  }
  // A MEASUREMENT ARM, and DELIBERATELY UNSOUND -- never a fix.
  // `GEA_FAMILY_MEMBER_FORCE_ABSENT=<name>[,<name>...]` (or `*`) skips the
  // blocking write scan for those member names, granting the absence proof as
  // if every store had been discharged. It exists because this proof sits at
  // the head of a long causal chain -- `isFogExp2` alone decides whether
  // three's `WebGLPrograms` parameters record has a boxed field, which decides
  // whether the program cache key is built at all -- and the only honest way
  // to price a discharge before writing it is to grant it and measure what
  // moves. Anything it makes green is a claim about the chain, never about the
  // program being correct.
  const forcedAbsent = process.env['GEA_FAMILY_MEMBER_FORCE_ABSENT']
  const forced = forcedAbsent !== undefined && (forcedAbsent === '*' || forcedAbsent.split(',').includes(name))
  if (!forced) {
    for (const write of writes.memberWrites.get(name) ?? []) {
      const refusal = mayHold(write.naming, lacking) ? blocked('expando-write', write.site) : null
      if (refusal) return refusal
    }
    for (const write of writes.memberWrites.get('__proto__') ?? []) {
      const refusal = mayHold(write.naming, family) ? blocked('prototype-write', write.site) : null
      if (refusal) return refusal
    }
    for (const write of writes.keyedWrites) {
      const receiver = write.naming
      const access = receiver?.parent
      if (!receiver || !access || !ts.isElementAccessExpression(access) || access.expression !== receiver) {
        const refusal = mayHold(receiver ?? null, lacking) ? blocked('keyed-write-unattributed', write.site) : null
        if (refusal) return refusal
        continue
      }
      if (keyCannotName(access.argumentExpression)) continue
      if (!mayHold(receiver, lacking)) continue
      if (guardedAbsentKeyStore(checker, write, access)) continue
      const refusal = blocked('keyed-write', write.site)
      if (refusal) return refusal
    }
  }
  /** Whether an `Object.assign` source or `defineProperties` map can carry `name`: only a spread-free literal says it cannot. */
  const literalMayName = (expression: ts.Expression | undefined): boolean => {
    const literal = expression && skipParentheses(expression)
    if (!literal || !ts.isObjectLiteralExpression(literal)) return true
    return literal.properties.some((property) => {
      if (ts.isSpreadAssignment(property)) return true
      const key = property.name
      if (!key) return true
      if (ts.isComputedPropertyName(key)) return writes.keys.mayName(writes.keys.of(key.expression), name)
      if (ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) {
        // `{ __proto__: v }` sets the literal's own prototype, never an own key.
        if (ts.isPropertyAssignment(property) && key.text === '__proto__' && !ts.isStringLiteralLike(key)) return false
        return key.text === name
      }
      return true
    })
  }
  const keyMayName = (expression: ts.Expression | undefined): boolean =>
    expression === undefined || ts.isSpreadElement(expression) || writes.keys.mayName(writes.keys.of(expression), name)
  for (const { call, method } of writes.reflectiveCalls) {
    const args = call.arguments
    // A spread hides which argument is the target and which the key, so the
    // rest of this call's checks below (which index into `args` positionally)
    // cannot run meaningfully -- move to the next call even while listing.
    if (args.some(ts.isSpreadElement)) {
      const refusal = blocked('reflective-spread-arguments', call)
      if (refusal) return refusal
      continue
    }
    const target = args[0] && !ts.isSpreadElement(args[0]) ? args[0] : null
    const owner = skipParentheses(call.expression) as ts.PropertyAccessExpression
    const isReflect = isStandardGlobalValue(checker, owner.expression, 'Reflect')
    if (method === 'setPrototypeOf') {
      if (mayHold(target, family)) {
        const refusal = blocked('prototype-replaced', call)
        if (refusal) return refusal
      }
      continue
    }
    if (method === 'assign' && !isReflect) {
      if (mayHold(target, lacking) && args.slice(1).some((source) => literalMayName(source))) {
        const refusal = blocked('object-assign', call)
        if (refusal) return refusal
      }
      continue
    }
    if (method === 'defineProperties') {
      if (mayHold(target, lacking) && literalMayName(args[1])) {
        const refusal = blocked('define-properties', call)
        if (refusal) return refusal
      }
      continue
    }
    // `defineProperty` (either owner) and `Reflect.set`, whose optional
    // fourth argument is the receiver a data property is created on.
    const receivers = method === 'set' && isReflect && args[3] ? [target, args[3]] : [target]
    if (receivers.some((receiver) => mayHold(receiver, lacking)) && keyMayName(args[1])) {
      const refusal = blocked(`reflective-${method}`, call)
      if (refusal) return refusal
    }
  }
  if (blocking.length > 0) {
    const clauses = new Map<string, number>()
    for (const { reason } of blocking) clauses.set(reason, (clauses.get(reason) ?? 0) + 1)
    for (const { reason, at } of blocking) console.error(`[FAMILY-MEMBER-BLOCK] ${name} ${reason}${describeAt(at)}`)
    if (memberReadWatching(name))
      console.error(
        `[MEMBER-READ-SUMMARY] ${name} refused=${blocking.length} clauses=${[...clauses].map(([clause, count]) => `${clause}:${count}`).join(',')}`
      )
    return blocking[0]!
  }
  return null
}

/**
 * Whether `type` is a plain, closed record shape -- an object literal's type,
 * or the same shape after the parameter census widens an assigned value --
 * with no index signature and no call/construct signature: `_emptyScene` in
 * three's `WebGLRenderer` (`{ background: null, fog: null, environment: null,
 * overrideMaterial: null, isScene: true }`), assigned into a parameter cell
 * right beside real class instances as a sentinel default. It is never a
 * class or a declared interface (no constructor, no prototype chain to
 * enumerate) and never open-ended (no index signature lets an unrelated key
 * appear, no call signature makes it a callable with its own dispatch), so
 * its OWN declared members are the complete, closed answer for anything read
 * off it -- unlike a source class, which needs the whole closure proof below
 * to rule out an expando or a subclass.
 *
 * Deliberately NOT gated on `ObjectFlags.ObjectLiteral`: the census's own
 * write-join widens an assigned literal's type (`writeSetTypeOf`/`widestOf`)
 * before this module ever sees it, which measurably drops that flag while
 * leaving the shape -- no index signature, no call surface, not a class --
 * exactly as closed as the literal it came from.
 */
const isClosedRecordType = (checker: ts.TypeChecker, type: ts.Type): boolean => {
  if ((type.flags & ts.TypeFlags.Object) === 0) return false
  if (type.isClassOrInterface()) return false
  if (instanceClassOf(type) !== null) return false
  if (checker.getIndexInfosOfType(type).length > 0) return false
  if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0) return false
  if (checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0) return false
  return true
}

/**
 * `receiver.name` read off ONE closed object-literal union member -- `null`
 * when this member cannot be trusted as a plain carrier (the property is
 * itself unusable evidence, or -- because JavaScript reads an absent
 * property as `undefined`, and this module has no write-safety proof for a
 * receiver that is not a `SourceClass` -- the literal simply lacks `name`,
 * which `memberWrites`/`keyedWrites`/reflective-mutator scans below are never
 * asked about a bare literal type). A literal missing the member therefore
 * refuses the WHOLE split (see the caller), exactly as a class whose carrier
 * is unusable does.
 */
const literalMemberCarrierOf = (checker: ts.TypeChecker, type: ts.Type, name: string): ts.Type | null => {
  const member = checker.getPropertyOfType(type, name)
  if (!member?.valueDeclaration) return null
  const memberType = checker.getTypeOfSymbolAtLocation(member, member.valueDeclaration)
  if (isUnusableEvidence(memberType) || (memberType.flags & ts.TypeFlags.Unknown) !== 0 || carriesTypeParameter(memberType)) return null
  return memberType
}

/**
 * The type of `receiver.name` when some class the receiver can hold does not
 * declare `name` -- see this module's header. `null` whenever the checker
 * already answers, the receiver is not a union of source class instances,
 * or any closure proof fails.
 */
export const classFamilyMemberReadTypeOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  receiver: ts.Type,
  name: string,
  census?: FamilyReceiverCensus
): ts.Type | null => {
  // The measurement arm, kept runnable the way `GEA_BAG_OFF` is.
  if (process.env['GEA_FAMILY_MEMBER_OFF']) return null
  if (objectPrototypeMemberNames.has(name) || name === '__proto__' || String(Number(name)) === name) return null
  const wholeReceiver = checker.getNonNullableType(receiver)
  const watching = debugName !== undefined && (debugName === '*' || debugName === name)
  const refuse = (reason: string, at?: ts.Node): null => {
    if (watching) console.error(`[FAMILY-MEMBER] ${checker.typeToString(wholeReceiver)}.${name} ${reason}${describeAt(at)}`)
    return null
  }
  const union = (checker as unknown as { getUnionType?: (types: readonly ts.Type[]) => ts.Type }).getUnionType
  // A receiver flowing through a guarded reassignment -- three's `if (
  // scene.isScene !== true ) scene = _emptyScene` -- holds a union of real
  // class instances AND a sentinel object literal. `familyRootsOf` (below,
  // through `sourceClassKeyReadPlanOf`) can only enumerate a CLASS family; a
  // bare literal in the same union is neither a family member nor an
  // ancestor, so asking it the class question for the WHOLE union refuses
  // outright. Splitting the literal member(s) out first and reading each
  // one's OWN declared member directly is what keeps the class machinery
  // answerable for the rest -- see `isClosedRecordType`'s header.
  const parts = wholeReceiver.isUnion() ? wholeReceiver.types : [wholeReceiver]
  const literalParts = parts.filter((part) => isClosedRecordType(checker, part))
  const classParts = parts.filter((part) => !isClosedRecordType(checker, part))
  let literalCarriers: readonly ts.Type[] | null = null
  if (literalParts.length > 0 && union) {
    const resolved = literalParts.map((part) => literalMemberCarrierOf(checker, part, name))
    if (resolved.every((carrier): carrier is ts.Type => carrier !== null)) literalCarriers = resolved
  }
  // Nothing to split, or the split could not be trusted end to end: fall
  // through exactly as before, over the WHOLE receiver, so a program with no
  // literal-sentinel arm is untouched and a disqualified one still refuses.
  const present =
    literalCarriers && classParts.length < parts.length ? (classParts.length > 0 ? union!.call(checker, classParts) : null) : wholeReceiver
  if (present === null) {
    // Every union member was a closed literal -- there is no class family to
    // ask at all, and the literals' own members are the whole answer.
    return literalCarriers && literalCarriers.length > 0 ? union!.call(checker, literalCarriers) : refuse('no-declarer')
  }
  const ledger = deferredIntrinsicProtocolLedgerOf(flow)
  if (!ledger) return refuse('no-intrinsic-ledger')
  const { value: plan, requirements } = ledger.capture(() =>
    sourceClassKeyReadPlanOf(checker, flow, { kind: 'declared', receiver: present }, name)
  )
  if (!plan) return refuse('no-key-read-plan')
  if (!plan.codeFree) return refuse('member-runs-code')
  if (plan.carriers.length === 0) return refuse('no-declarer')
  // See "The Object obligation": an absent class's `undefined` rests on
  // Object.prototype lacking exactly this key. It is admitted by default when
  // every Object obligation the plan published is that per-key question; a
  // whole-prototype obligation fails under any key write the census cannot
  // attribute, so an answer resting on one is still refused.
  // GEA_FAMILY_MEMBER_ABSENT_KEYS is a kill switch: `0` refuses, `1` admits.
  // The installed hosts can state the `0` refusal for every build that loads
  // them (`ledger.refusesObjectPrototypeAbsenceProofs`); `=1` exists for tests
  // of the proof itself and does not override a host's statement.
  const absentKeys = process.env['GEA_FAMILY_MEMBER_ABSENT_KEYS']
  if (
    plan.needsDefaultPrototype &&
    (ledger.refusesObjectPrototypeAbsenceProofs ||
      (absentKeys !== '1' &&
        (absentKeys === '0' ||
          requirements.some(isWholeObjectPrototypeRequirement) ||
          !requirements.some((requirement) => objectPrototypeLacksKeyRequirement(requirement, name)))))
  )
    return refuse('absent-class-needs-object-prototype')
  const carriers: ts.Type[] = []
  for (const { owner, type } of plan.carriers) {
    if (
      isUnusableEvidence(type) ||
      (type.flags & ts.TypeFlags.Unknown) !== 0 ||
      annotationStatesNothing(checker, owner, type) ||
      carriesTypeParameter(type)
    )
      return refuse('declarer-carrier-unknown', owner)
    carriers.push(type)
  }
  const instances = new Map<SourceClass, ts.InterfaceType>()
  const lacking = new Set<SourceClass>()
  for (const [owner, verdict] of plan.classes) {
    const symbol = owner.name ? checker.getSymbolAtLocation(owner.name) : checker.getTypeAtLocation(owner).getSymbol()
    const type = symbol && checker.getDeclaredTypeOfSymbol(symbol)
    if (!type?.isClassOrInterface()) return refuse('family-member-untyped', owner)
    instances.set(owner, type)
    if (verdict === 'absent') lacking.add(owner)
  }
  const closure = closureRefusalOf(checker, flow, instances, lacking, name, census ?? null)
  // The Object obligation this read would have recorded, independent of
  // whether the closure proof itself refused: `plan.needsDefaultPrototype`
  // and the requirement counts are settled ONE layer above `computeClosureRefusal`
  // (in `plan`, from `sourceClassKeyReadPlanOf`, before the closure proof is
  // even asked), so the closure proof itself has no way to report them --
  // they have to be printed here, at the only point that holds both.
  if (memberReadWatching(name))
    console.error(
      `[MEMBER-READ-OBLIGATION] ${name} needs-default-prototype=${plan.needsDefaultPrototype} plan-requirements=${requirements.length} closure-requirements=${closure.requirements.length} closure-refused=${closure.refusal !== null}`
    )
  if (closure.refusal) return refuse(closure.refusal.reason, closure.refusal.at)
  if (!union) return null
  publish(ledger, closure.requirements.length > 0 ? [...requirements, ...closure.requirements] : requirements)
  const familyCarriers = plan.needsDefaultPrototype ? [...carriers, checker.getUndefinedType()] : carriers
  return union.call(checker, literalCarriers ? [...familyCarriers, ...literalCarriers] : familyCarriers)
}

const isWholeObjectPrototypeRequirement = (requirement: IntrinsicProtocolRequirement): boolean =>
  requirement.intrinsic === 'Object' && requirement.member === undefined && requirement.prototypeKeys === undefined

/** The per-key question an absent class's `undefined` rests on: Object.prototype lacks `name`. */
const objectPrototypeLacksKeyRequirement = (requirement: IntrinsicProtocolRequirement, name: string): boolean =>
  requirement.intrinsic === 'Object' && requirement.member === undefined && requirement.prototypeKeys?.names?.includes(name) === true

const LEDGER_SCOPE = 'class-family-member-read'
const published = new WeakMap<
  DeferredIntrinsicProtocolLedger,
  { readonly all: IntrinsicProtocolRequirement[]; readonly seen: Map<ts.Node, Set<string>> }
>()

/** Keep a surviving answer's intrinsic obligations -- see "The Object obligation". */
const publish = (ledger: DeferredIntrinsicProtocolLedger, requirements: readonly IntrinsicProtocolRequirement[]): void => {
  if (requirements.length === 0) return
  // A parameter inference that asked for this read depends on it too.
  ledger.include(requirements)
  let held = published.get(ledger)
  if (!held) published.set(ledger, (held = { all: [], seen: new Map() }))
  let added = false
  for (const requirement of requirements) {
    let kinds = held.seen.get(requirement.location)
    if (!kinds) held.seen.set(requirement.location, (kinds = new Set()))
    const kind = `${requirement.intrinsic}.${intrinsicProtocolRequirementKind(requirement) ?? ''}`
    if (kinds.has(kind)) continue
    kinds.add(kind)
    held.all.push(requirement)
    added = true
  }
  if (added) ledger.replace(LEDGER_SCOPE, held.all)
}
