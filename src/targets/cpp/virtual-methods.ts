import type { DeclarationId, FunctionId } from '../../identity/ids.js'
import type { AbiParameter, CallableAbi, Representation } from '../../representation/model.js'
import type { ClassLayout } from '../../projection/classes.js'
import {
  extendsClass,
  virtualDispatchKey,
  virtualMethodFamiliesOf,
  type VirtualDispatchVerdict,
  type VirtualFamilyRefusal,
  type VirtualFamilyVerdict,
  type VirtualMemberRole,
  type VirtualMethodFamily,
  type VirtualMethodImplementor
} from '../../projection/dispatch.js'
export {
  extendsClass,
  virtualDispatchKey,
  virtualMethodFamiliesOf,
  type VirtualDispatchVerdict,
  type VirtualFamilyRefusal,
  type VirtualFamilyVerdict,
  type VirtualMemberRole,
  type VirtualMethodFamily,
  type VirtualMethodImplementor
}
import { cppFormalName } from './emit-context.js'
import {
  cppAbiParameterType,
  cppBodyName,
  cppClassName,
  cppRecordFieldName,
  cppResultTypeOf,
  cppStringLiteral,
  cppTypeOf,
  cppUndefinedIn
} from './types.js'
import { alignedValueText, dynamicCarrierBoxText, type ConversionSite } from './emit-narrowing.js'

/**
 * Dispatch for a method the program overrides.
 *
 * `class-layout.ts` resolves a member by walking UP from the receiver's class,
 * which is the language's lookup only when the receiver's class is known
 * exactly. It is not what a CALL does: a receiver annotated as a base holds
 * whatever was constructed, and the language runs that object's implementation.
 * Binding the body the upward walk found is therefore right only while nothing
 * below redeclares the key -- and when something does, the emitted program runs
 * the base's body for every instance of a subclass, compiles, links, and is
 * silently wrong. gea3d-cube is the worked case: `Object3D.collectSelf` is
 * empty and `Mesh`/`Light` override it, so the renderer's scene walk collected
 * zero meshes and painted a cleared frame with no diagnostic anywhere.
 *
 * The mechanism here is C++'s own. The emitted structs already model the
 * language's inheritance as C++ inheritance (`records.ts`), single and with the
 * base subobject at offset zero -- which `gea::Ref`'s converting constructor
 * asserts -- so a virtual member on the root struct dispatches exactly as the
 * language specifies, at the cost of one vtable pointer per object. Nothing
 * else in the emission has to change shape: the member forwards to the same
 * free-function body the direct bind used to name.
 */

// `VirtualMemberRole`, `VirtualMethodFamily`, `VirtualMethodImplementor`,
// `extendsClass`, `virtualMethodFamiliesOf`, `virtualDispatchKey` and the
// dispatchability VERDICT (`VirtualDispatchVerdict`, `VirtualFamilyVerdict`,
// `VirtualFamilyRefusal`, `virtualDispatchVerdictOf` -- imported where used
// below, not re-exported by name since nothing outside this file and
// `translation-unit.ts` calls it directly) all moved to `projection/
// dispatch.ts`: they are pure functions of `ClassLayout` plus the published
// `IrBody.facts` capture answer, no C++ text among them, and re-exported here
// so nothing consuming them by this module's old name has to change.
//
// What is left here is the one thing that IS a C++ spelling: turning a
// verdict this file no longer decides into struct members and out-of-line
// definitions -- `virtualMethodEmission` below -- and the parameter/receiver/
// result conversion TEXT an adapter body needs, which `virtualDispatchVerdictOf`
// already proved exists (`virtualMethodAdapterOf`'s job is therefore now to
// SPELL those conversions, not to decide whether they exist).

export interface VirtualMethodRefusal {
  readonly key: string
  readonly owner: DeclarationId
  readonly reason: string
}

/**
 * The C++ member one family dispatches through.
 *
 * Prefixed rather than named after the key alone: a class may declare a FIELD
 * and a method whose names would otherwise collide inside one struct, and the
 * field's spelling is already `cppRecordFieldName`'s.
 */
export const cppVirtualMemberName = (key: string, role: VirtualMemberRole = 'call'): string =>
  `${role === 'set' ? 'gea_vset_' : role === 'get' ? 'gea_vget_' : 'gea_vcall_'}${cppRecordFieldName(key)}`

/** The parameter list a family's member takes: the body's ABI minus the receiver, which becomes `this`. */
const memberFormalsOf = (abi: CallableAbi): readonly string[] =>
  abi.parameters.map((parameter: AbiParameter, ordinal: number) => `${cppAbiParameterType(parameter)} ${cppFormalName(ordinal)}`)

/**
 * The receiver/parameter/result conversion TEXT for a class-ref pair.
 *
 * `projection/dispatch.ts`'s `virtualDispatchVerdictOf` already proved this
 * pair is one of the two shapes below (same-or-ancestor, or a runtime-checked
 * descendant) before this file is ever asked to spell it -- see that module's
 * `classRefConvertible`, the identical structural test with no text attached.
 * A `null` return here on a pair the verdict approved is therefore this
 * file's own bug, not a program defect, and `virtualMethodAdapterOf` treats it
 * as exactly that (a thrown internal error, never a refusal).
 */
const classRefConversionText = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  source: Extract<Representation, { kind: 'class-ref' }>,
  target: Extract<Representation, { kind: 'class-ref' }>,
  text: string
): string | null => {
  if (source.ownership !== 'shared-refcount' || target.ownership !== 'shared-refcount') return null
  if (source.declaration === target.declaration || extendsClass(classes, source.declaration, target.declaration)) {
    return `${cppTypeOf(target)}(${text})`
  }
  if (!extendsClass(classes, target.declaration, source.declaration)) return null
  const possible = [...classes.keys()]
    .filter((declaration) => declaration === target.declaration || extendsClass(classes, declaration, target.declaration))
    .sort((left, right) => String(left).localeCompare(String(right)))
  if (possible.length === 0) return null
  const test = `gea::host::hasNativeClassLayoutRef<${possible.map(cppClassName).join(', ')}>(${text})`
  const failure =
    `std::fprintf(stderr, "gea: virtual dispatch argument is not an instance of ${String(target.declaration)}\\n"); ` + 'std::abort();'
  return `[&]() -> ${cppTypeOf(target)} { if (!${test}) { ${failure} } return gea::host::downcastClassRef<${cppClassName(target.declaration)}>(${text}); }()`
}

const virtualValueConversionText = (
  site: ConversionSite,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  source: Representation,
  target: Representation,
  text: string
): string | null => {
  if (source.kind === 'class-ref' && target.kind === 'class-ref') return classRefConversionText(classes, source, target, text)
  return alignedValueText(site, 'virtual-methods.ts:189', source, target, text)
}

interface VirtualMethodAdapter {
  readonly result: string
}

/**
 * One implementor's out-of-line body, as an expression the family's member
 * forwards to.
 *
 * Every conversion here was already PROVED to exist by `virtualDispatchVerdictOf`
 * -- this function only has to spell it. A `null`/`undefined` from a text
 * builder that the verdict already cleared is therefore an internal
 * consistency error (this file drifting from `projection/dispatch.ts`'s own
 * predicate), reported as a thrown `Error` rather than folded into
 * `VirtualMethodEmission.refused`: refusing here would silently drop a
 * program the verdict certified as dispatchable, which is worse than crashing
 * loudly on a compiler bug.
 */
const virtualMethodAdapterOf = (
  site: ConversionSite,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  family: VirtualMethodFamily,
  implementor: VirtualMethodImplementor,
  rootAbi: CallableAbi,
  actualAbi: CallableAbi
): VirtualMethodAdapter => {
  // Every `?? drift(...)` below leans on `drift`'s `never` return type to
  // both throw AND narrow the left-hand side to its non-null variant, rather
  // than on an `if`-then-throw's control-flow narrowing -- the same value,
  // asked the more robust of the two ways this file's own architecture
  // rules already prefer over a non-null assertion.
  const drift = (what: string): never =>
    throwVirtualAdapterDrift(family, implementor, `the dispatch verdict proved ${what} converts, but this file could not spell it`)
  const receiverAbi = actualAbi.receiver ?? drift('a receiver')
  const instanceValue = classes.get(implementor.declaration)?.instance ?? null
  const instance = instanceValue !== null && instanceValue.kind === 'class-ref' ? instanceValue : drift('a class-ref instance carrier')
  const receiverText =
    virtualValueConversionText(
      site,
      classes,
      instance,
      receiverAbi,
      `gea::Ref<${cppClassName(implementor.declaration)}>::adopt(this, true)`
    ) ?? drift('a receiver')
  const actuals: string[] = [receiverText]
  for (const [position, parameter] of actualAbi.parameters.entries()) {
    const source = rootAbi.parameters[position]
    if (source !== undefined) {
      actuals.push(
        virtualValueConversionText(site, classes, source.value, parameter.value, cppFormalName(position)) ?? drift(`parameter ${position}`)
      )
      continue
    }
    if (actualAbi.restFrom === position && parameter.value.kind === 'array-object') {
      actuals.push(`gea::makeRef<gea::ArrayObject<${cppTypeOf(parameter.value.element)}>>()`)
      continue
    }
    actuals.push(cppUndefinedIn(parameter.value) ?? drift(`an undefined default for parameter ${position}`))
  }
  const invocation = `${cppBodyName(implementor.callable)}(${actuals.join(', ')})`
  const result = virtualValueConversionText(site, classes, actualAbi.result, rootAbi.result, invocation) ?? drift('the result')
  return { result }
}

const throwVirtualAdapterDrift = (family: VirtualMethodFamily, implementor: VirtualMethodImplementor, reason: string): never => {
  throw new Error(`virtual method adapter for ${implementor.declaration}.${family.key}: ${reason}`)
}

export interface VirtualMethodEmission {
  /** Member declarations to place inside each struct, by struct name. */
  readonly membersByStruct: ReadonlyMap<string, readonly string[]>
  /** Out-of-line definitions, emitted after every body has been declared. */
  readonly definitions: readonly string[]
  /** Families that cannot be dispatched, so the call sites refuse rather than bind one body. */
  readonly refused: readonly VirtualMethodRefusal[]
  /** Every `class key` a call site may dispatch, with the root member ABI it must call. */
  readonly dispatched: ReadonlyMap<string, CallableAbi>
}

/**
 * The struct members and out-of-line definitions for every family
 * `verdict` already proved dispatchable.
 *
 * This function used to decide dispatchability itself (an ABI-compatibility
 * walk plus a capture-environment refusal, both duplicated between here and
 * whatever asked the same question before a call site was allowed to bind a
 * body directly). That verdict is `projection/dispatch.ts`'s
 * `virtualDispatchVerdictOf` now, computed once by `translation-unit.ts` from
 * the published `IrBody.facts` and threaded in as `verdict` -- this file
 * reads the fact and renders it, rather than re-deriving it from a whole-unit
 * capture index at render time the way `targets/cpp/captures.ts`'s
 * `buildCaptureIndex` used to require.
 */
export const virtualMethodEmission = (
  site: ConversionSite,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  abiOf: (callable: FunctionId) => CallableAbi | null,
  verdict: VirtualDispatchVerdict
): VirtualMethodEmission => {
  const membersByStruct = new Map<string, string[]>()
  const definitions: string[] = []

  for (const { family, rootAbi } of verdict.families) {
    const adapters = new Map<DeclarationId, VirtualMethodAdapter>()
    for (const implementor of family.implementors) {
      const actualAbi =
        abiOf(implementor.callable) ??
        throwVirtualAdapterDrift(family, implementor, 'the dispatch verdict proved a callable convention exists, but this file found none')
      adapters.set(implementor.declaration, virtualMethodAdapterOf(site, classes, family, implementor, rootAbi, actualAbi))
    }

    const formals = memberFormalsOf(rootAbi).join(', ')
    const result = cppResultTypeOf(rootAbi.result)
    if (family.abstractRoot) {
      // Declared on the root and DEFINED, rather than pure virtual: nothing in
      // the program can construct an abstract class, but `gea::Ref`'s
      // operations table and every downcast name the root type, and an
      // abstract C++ type is a different type for all of them. TypeScript
      // already proves every concrete subclass overrides this, so the
      // definition is unreachable and says so instead of returning a value it
      // would have to invent.
      const failure = `std::fprintf(stderr, "gea: abstract method ${String(family.root)}.${family.key} has no implementation\\n"); std::abort();`
      membersByStruct.set(cppClassName(family.root), [
        ...(membersByStruct.get(cppClassName(family.root)) ?? []),
        `  virtual ${result} ${cppVirtualMemberName(family.key, family.role)}(${formals});`
      ])
      definitions.push(
        `${result} ${cppClassName(family.root)}::${cppVirtualMemberName(family.key, family.role)}(${formals}) { ${failure} }`
      )
    }
    for (const implementor of family.implementors) {
      const structName = cppClassName(implementor.declaration)
      const isRoot = implementor.declaration === family.root && !family.abstractRoot
      const members = membersByStruct.get(structName) ?? []
      members.push(
        `  ${isRoot ? 'virtual ' : ''}${result} ${cppVirtualMemberName(family.key, family.role)}(${formals})${isRoot ? '' : ' override'};`
      )
      membersByStruct.set(structName, members)
      const adapter = adapters.get(implementor.declaration)
      if (adapter === undefined) throw new Error(`virtual method adapter for ${implementor.declaration}.${family.key} was not retained`)
      definitions.push(
        `${result} ${structName}::${cppVirtualMemberName(family.key, family.role)}(${formals}) { ${result === 'void' ? '' : 'return '}${adapter.result}; }`
      )
    }
  }

  return {
    membersByStruct,
    definitions,
    refused: verdict.refused.map((refusal: VirtualFamilyRefusal) => ({ key: refusal.key, owner: refusal.owner, reason: refusal.reason })),
    dispatched: new Map([...verdict.dispatched].map(([key, entry]) => [key, entry.rootAbi]))
  }
}

export interface PrototypeReadHooks {
  readonly membersByStruct: ReadonlyMap<string, readonly string[]>
  readonly definitions: readonly string[]
}

/**
 * The runtime's `NativePrototypeTable` hooks for every class that declares a
 * getter or method, so a boxed instance answers a dynamic read of either.
 *
 * A class accessor has no storage (`ClassLayout.accessors`), so the boxed
 * payload's field table cannot see it, and `Value::getProperty` found nothing
 * and answered `undefined` -- `@hono/node-server` reads `request.method` off
 * an `Object.create`d instance it only holds as `any`. The hook calls the
 * getter's own body on the instance and boxes its result; a getter whose
 * result has no boxed form is left out rather than answered wrongly.
 *
 * The nearest ancestor with getters declares the members `virtual`, so the
 * runtime's `static_cast` to the box's declared class still reaches the
 * dynamic class's getters; a class without getters of its own inherits them.
 *
 * `readDynamically` is the reflection census's verdict per class (the same
 * `full`-demand answer `records.ts` spells the struct's own dynamic field
 * protocol from, bases included): only a class some box can hold is ever
 * asked for a prototype property through `gea::Value`, and a class no box
 * holds gets no hook -- the hook's method arm boxes every method into a
 * `gea::Value` function object, which a program whose classes never reach a
 * dynamic carrier must not spell at all (`test/stored-listener-native-flow`,
 * `native-method-overrides`' `emitted-lacks: gea::Value::box`).
 */
export const prototypeReadHooks = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  abiOf: (callable: FunctionId) => CallableAbi | null,
  capturesNothing: (callable: FunctionId) => boolean,
  readDynamically: (declaration: DeclarationId) => boolean
): PrototypeReadHooks => {
  // A method read yields a fresh function object over the body: a dynamic
  // read is followed by a call, and nothing on that path compares identities.
  const methods = (layout: ClassLayout): { readonly key: string; readonly text: string }[] =>
    layout.methods.flatMap((method) => {
      if (method.callable === null || !capturesNothing(method.callable)) return []
      const abi = abiOf(method.callable)
      if (abi === null || abi.receiver === null) return []
      const value: Representation = { kind: 'function-value-dispatch', abi }
      const receiver = abi.receiver
      const formals = [
        `${cppTypeOf(receiver)} gea_receiver`,
        ...abi.parameters.map((p, i) => `${cppAbiParameterType(p)} ${cppFormalName(i)}`)
      ]
      const actuals = ['gea_receiver', ...abi.parameters.map((_, i) => cppFormalName(i))]
      const thunk = `+[](void*, ${formals.join(', ')}) -> ${cppResultTypeOf(abi.result)} { return ${cppBodyName(method.callable)}(${actuals.join(', ')}); }`
      const boxed = dynamicCarrierBoxText(value, `${cppTypeOf(value)}{${thunk}, nullptr}`)
      return boxed === null ? [] : [{ key: method.key, text: boxed }]
    })
  const readable = (layout: ClassLayout): { readonly key: string; readonly text: string }[] => [
    ...layout.accessors.flatMap((accessor) => {
      if (accessor.getter === null || !capturesNothing(accessor.getter)) return []
      const abi = abiOf(accessor.getter)
      if (abi === null || abi.receiver === null || abi.parameters.length > 0 || abi.restFrom !== null) return []
      if (layout.instance?.kind !== 'class-ref' || abi.receiver.kind !== 'class-ref') return []
      const self = `gea::Ref<${cppClassName(layout.declaration)}>::adopt(const_cast<${cppClassName(layout.declaration)}*>(this), true)`
      const receiver = classRefConversionText(classes, layout.instance, abi.receiver, self)
      if (receiver === null) return []
      const invocation = `${cppBodyName(accessor.getter)}(${receiver})`
      if (abi.result.kind === 'undefined' || cppResultTypeOf(abi.result) === 'void') return []
      const boxed = abi.result.kind === 'dynamic' ? invocation : dynamicCarrierBoxText(abi.result, invocation)
      return boxed === null ? [] : [{ key: accessor.key, text: boxed }]
    }),
    ...methods(layout)
  ]
  const own = new Map<DeclarationId, { readonly key: string; readonly text: string }[]>()
  for (const [declaration, layout] of classes) {
    if (!readDynamically(declaration)) continue
    const getters = readable(layout)
    if (getters.length > 0) own.set(declaration, getters)
  }
  const hookedAncestorOf = (declaration: DeclarationId): DeclarationId | null => {
    for (let base = classes.get(declaration)?.base ?? null; base !== null; base = classes.get(base)?.base ?? null)
      if (own.has(base)) return base
    return null
  }
  const membersByStruct = new Map<string, string[]>()
  const definitions: string[] = []
  for (const [declaration, getters] of own) {
    const struct = cppClassName(declaration)
    const ancestor = hookedAncestorOf(declaration)
    const [lead, tail] = ancestor === null ? ['virtual ', ''] : ['', ' override']
    membersByStruct.set(struct, [
      `  ${lead}bool gea_readPrototypeProperty(const gea::PropertyKey& gea_key, gea::Value& gea_out) const${tail};`,
      `  ${lead}bool gea_hasPrototypeProperty(const gea::PropertyKey& gea_key) const${tail};`,
      `  ${lead}gea::detail::NativePrototypeOps::SetResult gea_setPrototypeProperty(const gea::PropertyKey& gea_key, const gea::Value& gea_value, const gea::Value& gea_receiver)${tail};`
    ])
    const inherited = ancestor === null ? null : cppClassName(ancestor)
    const names = getters.map((getter) => cppStringLiteral(getter.key))
    definitions.push(
      [
        `bool ${struct}::gea_readPrototypeProperty(const gea::PropertyKey& gea_key, gea::Value& gea_out) const {`,
        '  if (!gea_key.isSymbol()) {',
        '    const std::string& gea_name = gea_key.text();',
        ...getters.map((getter, index) => `    if (gea_name == ${names[index]}) { gea_out = ${getter.text}; return true; }`),
        '  }',
        `  return ${inherited === null ? 'false' : `${inherited}::gea_readPrototypeProperty(gea_key, gea_out)`};`,
        '}',
        `bool ${struct}::gea_hasPrototypeProperty(const gea::PropertyKey& gea_key) const {`,
        `  if (!gea_key.isSymbol() && (${names.map((name) => `gea_key.text() == ${name}`).join(' || ')})) return true;`,
        `  return ${inherited === null ? 'false' : `${inherited}::gea_hasPrototypeProperty(gea_key)`};`,
        '}',
        // Setters stay on the static paths; a dynamic write falls through to the payload's own fields.
        `gea::detail::NativePrototypeOps::SetResult ${struct}::gea_setPrototypeProperty(const gea::PropertyKey&, const gea::Value&, const gea::Value&) {`,
        '  return gea::detail::NativePrototypeOps::SetResult::Absent;',
        '}'
      ].join('\n')
    )
  }
  return { membersByStruct, definitions }
}
