import type { CallableAbi, Representation } from '../../../representation/model.js'
import type { RecordLayoutPolicy } from '../../../representation/policies.js'
import { cppAbiParameterType, cppResultTypeOf, cppStringLiteral, cppTypeOf } from '../types.js'
import { toStringTextOver } from '../emit-tostring.js'
import { booleanTestText } from '../emit-presence.js'
import { hostArgumentText } from './emit-host-arity.js'
import type { HostCallSpelling, HostMember } from './host-members.js'
import { fillHostTemplate } from './host-members.js'
import { dateGetters, dateSetters, dateStringForms } from '../prototype/emit-prototype-date.js'

/**
 * A host function READ as a value: the function object the language says it is.
 *
 * `decodeURI` is an ordinary function object in ECMAScript (18.2.6.2 -- a
 * built-in whose value is a callable), so `const d = decodeURI` binds a
 * callable and nothing about it is special. What this backend has is a call
 * SPELLING, not a symbol of the right type, and a C++ function name is not a
 * `CallableObject`. The gap is a rendering, not a language fact.
 *
 * The rendering is the ABI the operand already carries, wrapped in the one
 * shape `CallableObject` accepts: a CAPTURELESS lambda matching its `Invoke`
 * (`Result (*)(void*, Arguments...)`), which converts to a plain function
 * pointer. No top-level helper has to be emitted, and no environment is
 * allocated, because there is nothing to capture -- the spelling is a fixed
 * path known at compile time.
 *
 * `null` for the two cases that genuinely have nothing to wrap, and both are
 * refused by the caller rather than approximated here:
 *
 *  - a spelling that is a TEMPLATE rather than a path, which is a recipe for
 *    filling in a call's own arguments and has no meaning without them;
 *  - a receiver-taking convention, whose thunk would have to capture the
 *    receiver and so could not be captureless.
 */
export const hostFunctionValueText = (representation: Representation, spelling: HostCallSpelling): string | null => {
  if (spelling.kind !== 'path') return null
  return capturelessHostThunkText(representation, (names) => `${spelling.text}(${names.join(', ')})`)
}

/**
 * The one shape a host spelling is wrapped in when it is READ rather than
 * called: a captureless lambda over the slot's own convention.
 *
 * Every host value read reaches this -- a free function, a class's call half, a
 * member of a protocol table -- because they differ only in what C++ text the
 * call is, which is the caller's callback here. What does NOT differ is the
 * wrapper: `CallableObject`'s `Invoke` is `Result (*)(void*, Arguments...)`, a
 * plain function pointer, so the lambda must capture nothing. That is the
 * whole reason a receiver-taking convention returns `null` rather than being
 * approximated -- a thunk that had to carry a receiver could not be one.
 *
 * `callText` may answer `null` for a spelling that cannot be filled from bare
 * formals (a template naming a slot nothing here supplies), which is refused
 * by the caller by name rather than rendered half-filled.
 */
const capturelessHostThunkText = (
  representation: Representation,
  callText: (names: readonly string[], abi: CallableAbi) => string | null
): string | null => {
  if (representation.kind !== 'function-value-dispatch') return null
  const abi = representation.abi
  if (abi.receiver !== null) return null
  const names = abi.parameters.map((_, index) => `a${index}`)
  const formals = abi.parameters.map((parameter, index) => `${cppAbiParameterType(parameter)} ${names[index]}`)
  const result = cppResultTypeOf(abi.result)
  const call = callText(names, abi)
  if (call === null) return null
  const body = abi.result.kind === 'void' ? `${call};` : `return ${call};`
  const signature = `${result}(${abi.parameters.map(cppAbiParameterType).join(', ')})`
  return `gea::CallableObject<${signature}>(+[](void*${formals.map((formal) => `, ${formal}`).join('')}) -> ${result} { ${body} }, nullptr)`
}

/**
 * A host METHOD read as a value: `console.error` in `(options?.onError ??
 * console.error)(e)`, `Object.keys` handed to a `map`.
 *
 * The language has no "method that is only ever a callee": reading
 * `console.error` produces the same function object calling it goes through,
 * and a program is free to store it, pass it, or pick it with `??`. What this
 * backend has instead is a call TEMPLATE keyed by protocol and member, which
 * is a recipe for a call site's arguments and names no C++ symbol on its own.
 *
 * So the read renders the template against a thunk's own formals -- the same
 * closing `hostFunctionValueText` already performs for a free host function,
 * and deliberately the same wrapper, because a host method read as a value is
 * not a different kind of value than a host function read as one.
 *
 * Three template shapes fill from bare formals and one does not:
 *
 *  - a fixed `{argN}` count, which fills positionally and refuses when the
 *    slot's convention has fewer parameters than the spelling names;
 *  - `'pass-through'`, whose single `{args}` slot takes the formals in order
 *    and leaves the overload choice to C++, exactly as a direct call does;
 *  - `'variadic'`, whose `{args}` slot is the ToString JOIN of the arguments
 *    (`console.log(a, b)` prints one space-separated line), computed here from
 *    the formals with the same abstract operation `consoleArgumentsText` runs
 *    over a direct call's operands;
 *  - `'call-site'`, which by definition has no template: its C++ depends on
 *    the static types of a CALL this read does not have. That refuses, and
 *    the refusal is honest rather than a guess at which renderer applies.
 *
 * A `{receiver}` cannot be filled either: the member was reached off a
 * receiver expression whose value this read did not keep, and a thunk holding
 * one would not be captureless. Every protocol whose members take a receiver
 * therefore refuses here by name.
 */
export const hostMemberValueText = (representation: Representation, host: HostMember, layouts: RecordLayoutPolicy): string | null => {
  if (host.kind !== 'method') return null
  return capturelessHostThunkText(representation, (names, abi) => {
    const crossed = names.map((name, index) => {
      const parameter = abi.parameters[index]
      return parameter === undefined ? name : hostArgumentText(parameter.value, name)
    })
    if (host.arity === 'call-site') return null
    if (host.arity === 'pass-through') return fillHostTemplate(host.emit, null, [], crossed.join(', '))
    if (host.arity === 'variadic') {
      // A convention that PACKS its trailing arguments has no per-argument
      // formals to stringify: the language binds the rest to ONE Array, and
      // that array is the whole argument list. This is the shape a value read
      // of a variadic member normally has, because the slot states the
      // member's own declared signature -- `(...data: unknown[]) => void` for
      // `console.error` in `(options?.onError ?? console.error)(e)`.
      //
      // So `{args}` fills with the formal itself, which is exactly what a
      // SPREAD call site already renders (`emit-host-invoke.ts`'s
      // `argumentsAreSpread` branch) and for the same reason: C++ overload
      // resolution picks the host's own array overload --
      // `gea::host::console::error(const Ref<ArrayObject<Value>>&)` -- which
      // joins with the single space `consoleArgumentsText` renders at a
      // per-operand call. Rendering the ToString join here instead would
      // stringify the ARRAY, and `Array.prototype.join`'s comma is not the
      // console's space, nor does it print `undefined` for an absent element
      // the way the console does.
      //
      // Only the whole-list shape: a convention with named parameters BEFORE
      // the rest would need the host's `(Value, std::vector<Value>)` overload,
      // whose second half no formal here holds, so it declines by name.
      if (abi.restFrom !== null) {
        const only = names[0]
        const parameter = abi.parameters[0]
        if (abi.restFrom !== 0 || names.length !== 1 || only === undefined || parameter === undefined) return null
        if (parameter.value.kind !== 'array-object' || parameter.value.element.kind !== 'dynamic') return null
        return fillHostTemplate(host.emit, null, [], only)
      }
      const parts: string[] = []
      for (const [index, name] of names.entries()) {
        const parameter = abi.parameters[index]
        if (parameter === undefined) return null
        const text = toStringTextOver(name, parameter.value, layouts)
        if (text === null) return null
        parts.push(text)
      }
      const joined = parts.length === 0 ? 'std::string()' : parts.reduce((left, right) => `${left} + std::string(" ") + ${right}`)
      return fillHostTemplate(host.emit, null, [], joined)
    }
    if (crossed.length < host.arity) return null
    return fillHostTemplate(host.emit, null, crossed.slice(0, host.arity))
  })
}

/**
 * The carriers `gea_runtime.h` itself declares a `gea_json_read`/
 * `gea_json_write` overload for, independent of any call site.
 *
 * Every other shape's overload is GENERATED, one per record shape a CALL site
 * reaches (`emit-json.ts`'s prepass walks `CallOperation`s). A value read is
 * not a call and contributes no shape to that walk, so a thunk over one would
 * name an overload nothing emitted -- a C++ error at the bottom of a header
 * instead of a refusal with this member's name on it.
 */
const jsonRuntimeDeclaredCarrier = (representation: Representation): boolean =>
  representation.kind === 'dynamic' ||
  representation.kind === 'string' ||
  (representation.kind === 'scalar' && (representation.domain === 'number' || representation.domain === 'boolean'))

/**
 * `JSON.parse` / `JSON.stringify` read as a VALUE -- `this.text().then(JSON.parse)`
 * in `@hono/node-server`'s `LightRequest.json`.
 *
 * The two JSON members are the one pair in `host-members.ts` whose `emit` is a
 * PLACEHOLDER rather than a template: their C++ is generated per call site
 * from the static type the call asserts, and that table says so in full.
 * Filling the ordinary thunk from that placeholder would splice a comment
 * where the call belongs, so this renders the same body `jsonCallText` does,
 * against the thunk's own formals and the slot's own carrier.
 *
 * Narrower than the call form on purpose, for the reason
 * `jsonRuntimeDeclaredCarrier` states. `JSON.parse` with nothing asserting a
 * type is the case that matters and the case that fits: its result is `any`,
 * which is `gea::Value` -- one of the four genuinely dynamic boundaries
 * `representation/model.ts` admits, and a carrier the runtime header reads
 * into directly.
 */
export const hostJsonMemberValueText = (member: string, representation: Representation): string | null => {
  if (member !== 'parse' && member !== 'stringify') return null
  if (representation.kind !== 'function-value-dispatch') return null
  // The thunk's convention is the member's REQUIRED parameter, not every slot
  // `lib.es5.d.ts` declares. `JSON.parse(text, reviver?)` carries two, and a
  // two-parameter `CallableObject` is not invocable with the one argument
  // `Promise::then` hands a fulfillment handler -- a hard overload-resolution
  // error at the header, for a slot the program never fills. ECMA-262's own
  // `Function.length` counts exactly the required ones, and the reviver (like
  // `stringify`'s replacer and space) is a second operation this backend
  // refuses at a real call anyway, so declaring it here could only produce a
  // thunk that refuses the moment it is filled.
  const required: Representation = {
    kind: 'function-value-dispatch',
    abi: { ...representation.abi, parameters: representation.abi.parameters.slice(0, 1) }
  }
  return capturelessHostThunkText(required, (names, abi) => {
    const only = names[0]
    if (names.length !== 1 || only === undefined) return null
    if (member === 'parse') {
      if (!jsonRuntimeDeclaredCarrier(abi.result)) return null
      return (
        `[&]() { gea::json::Reader gea_json_reader(${only}); ${cppTypeOf(abi.result)} gea_json_result{}; ` +
        `gea_json_read(gea_json_reader, gea_json_result); return gea_json_result; }()`
      )
    }
    const argument = abi.parameters[0]
    if (argument === undefined || !jsonRuntimeDeclaredCarrier(argument.value)) return null
    return `[&]() { std::string gea_json_out; gea_json_write(gea_json_out, ${only}); return gea_json_out; }()`
  })
}

/**
 * A BUILTIN function read as a value, for reflection only.
 *
 * `Object.getOwnPropertyDescriptor(Array.from, 'name')` never calls what it is
 * handed, and `Array.from` has no single calling convention to hand it: its
 * four `lib.d.ts` overloads disagree at parameter 0, so
 * `representation/derive.ts` carries the read as `callable-identity` -- the
 * function OBJECT without a frame. This renders that object, and the runtime
 * gives it the `name` and `length` ECMA-262 10.2.4/10.2.9 say it has.
 *
 * Keyed by the builtin's spec path rather than by this site, so every spelling
 * of `Array.from` in a program is the same function object. A call through the
 * value is refused at emission (`call-abi:no-invoke-path:callable-identity`),
 * which is why nothing here has to invent an invoke that would then throw.
 */
export const hostBuiltinFunctionIdentityText = (protocol: string, member: string, length: number): string =>
  `gea::builtinFunctionIdentity(${cppStringLiteral(`${protocol}.${member}`)}, ${cppStringLiteral(member)}, ` +
  `static_cast<double>(${String(length)}))`

/**
 * A host CLASS read as a value, for the classes whose CALL is one path.
 *
 * `args.map(String)` passes the class object itself, and `String` is not a
 * symbol this backend has -- what it has is a spelling for the CALL, which is
 * the same gap `hostFunctionValueText` above closes for a host function, and
 * the same rendering closes it: a captureless thunk over the slot's own ABI.
 *
 * Only classes whose call is a plain path over the argument the slot declares.
 * `String(x)` is `gea::host::detail::toString(x)`, overloaded for every
 * carrier the runtime states one for, so the thunk type-checks or the C++
 * compiler says it does not -- it never silently picks a different conversion.
 * `new String(x)` is a different operation (a wrapper OBJECT) and is not this:
 * a class read as a value is only ever the callable half.
 */
const hostClassCallPaths: ReadonlyMap<string, string> = new Map([['String', 'gea::host::detail::toString']])

export const hostClassValueText = (representation: Representation, className: string): string | null => {
  // A host class READ carries its own `native-handle`, whose `call` half is
  // the convention the class object is callable under -- the same shape
  // `function-value-dispatch` states for a function, one field deeper.
  const abi = representation.kind === 'native-handle' ? representation.call : null
  const dispatch: Representation | null =
    representation.kind === 'function-value-dispatch' ? representation : abi === null ? null : { kind: 'function-value-dispatch', abi }
  if (dispatch === null) return null
  // `Boolean` is not a path at all: ECMA-262 20.3.1.1 says `Boolean(value)` IS
  // ToBoolean(value), which this backend already answers per carrier rather
  // than through any single C++ function -- an `Optional<string>` tests its
  // flag AND its payload, a union tests the arm it holds, and only a boxed
  // value reaches `gea::host::detail::toBoolean`. So the thunk's body is that
  // same table, asked about the slot's own parameter carrier, which is what
  // makes `values.filter(Boolean)` mean what it means in the language rather
  // than "is this box non-null". A missing argument is ToBoolean(undefined),
  // which is `false`.
  if (className === 'Boolean') {
    return capturelessHostThunkText(dispatch, (names, callAbi) => {
      const first = names[0]
      const parameter = callAbi.parameters[0]
      if (first === undefined || parameter === undefined) return 'false'
      return booleanTestText(first, parameter.value)
    })
  }
  const path = hostClassCallPaths.get(className)
  if (path === undefined) return null
  return hostFunctionValueText(dispatch, { kind: 'path', text: path })
}

/**
 * A prototype method read as a VALUE (`Date.prototype.getTime`): a callable
 * whose facts (`name`, `length`, source text) are what reflection asks for,
 * and whose invoke is the method itself over whatever receiver a caller
 * hands it -- `getTime.call(0)`, `getTime.call(new Date())`. The receiver is
 * the frame's first formal, a `gea::Value` (the prototype object's copy of
 * each method states an `any` receiver, `structural.ts`'s
 * `prototypeMethodBodyOf`), and 21.4.4's `thisTimeValue` is the brand check
 * on it: a Date dispatches to `gea::runtime::Date`'s own member, exactly as
 * `emit-prototype-date.ts` renders a direct `d.getTime()`; anything else is
 * the TypeError the clause specifies. A member this backend has no runtime
 * spelling for, and every non-Date prototype, keeps a throwing invoke, so a
 * call reaching it is an honest refusal at run time rather than a wrong
 * answer. Facts are registered against the invoke pointer so
 * `Value::box(Tag::Function, ...)` installs the own `name`/`length` the same
 * way it does for a program's own function. `signature` is the `R(A...)`
 * spelling of the read's own ABI when the read is typed, `void()` when the
 * value is only ever reflected over.
 */
export const hostPrototypeMethodValueText = (signature: string, protocol: string, member: string, arity: number): string => {
  const parameters = signature.slice(signature.indexOf('(') + 1, -1)
  const result = signature.slice(0, signature.indexOf('('))
  const types = splitTopLevelCommas(parameters)
  const formals = types.map((type, index) => `, [[maybe_unused]] ${type} __gea_a${index}`).join('')
  const signatureFormals = parameters.length === 0 ? '' : `, ${parameters}`
  // `X.prototype.constructor` is X itself: the stub carries the constructor's
  // own name, not the member's.
  const name = member === 'constructor' ? protocol.slice(0, protocol.length - '.prototype'.length) : member
  const text = `function ${name}() { [native code] }`
  const message = `${protocol}.${member} is a prototype method read as a value; this backend renders it for reflection only, so it cannot be called`
  const body =
    prototypeMethodDispatchText(protocol, member, result, types) ??
    `gea::host::throwRuntimeError("TypeError", ${cppStringLiteral(message)});`
  return (
    `([&]() { static constexpr ${result} (*__gea_invoke)(void*${signatureFormals}) = +[](void*${formals}) -> ${result} { ${body} }; ` +
    `static const bool __gea_registered = gea::CallableObject<${signature}>::registerSource<__gea_invoke>(` +
    `${cppStringLiteral(name)}, ${String(arity)}, ${cppStringLiteral(text)}); (void)__gea_registered; ` +
    `return gea::CallableObject<${signature}>(__gea_invoke, nullptr); })()`
  )
}

/** A C++ parameter list split at its top-level commas -- a template argument list's commas stay inside their type. */
const splitTopLevelCommas = (parameters: string): readonly string[] => {
  const types: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < parameters.length; index += 1) {
    const char = parameters[index]
    if (char === '<' || char === '(') depth += 1
    else if (char === '>' || char === ')') depth -= 1
    else if (char === ',' && depth === 0) {
      types.push(parameters.slice(start, index).trim())
      start = index + 1
    }
  }
  const tail = parameters.slice(start).trim()
  if (tail.length > 0) types.push(tail)
  return types
}

const dateValueType = 'gea::Value'

/**
 * The invoke body for a Date prototype method over a boxed receiver, or
 * `null` when the member has no runtime spelling here. A setter's trailing
 * optionals forward as `std::nullopt` when absent -- `Date::setFields`'s own
 * "keep the current field", distinct from a present NaN.
 */
const prototypeMethodDispatchText = (protocol: string, member: string, result: string, types: readonly string[]): string | null => {
  if (protocol !== 'Date.prototype' || types[0] !== dateValueType) return null
  const site = cppStringLiteral(`${protocol}.${member}`)
  const guard =
    `if (!gea::host::instanceOfDate(__gea_a0)) gea::host::throwRuntimeError("TypeError", ` +
    `${cppStringLiteral(`${protocol}.${member} called on incompatible receiver`)}); `
  const self = `gea::detail::unboxValue<gea::Ref<gea::runtime::Date>>(__gea_a0, gea::Value::Tag::Object, ${site})`
  const arguments_ = types.slice(1)
  if (dateGetters.includes(member) || dateStringForms.includes(member)) {
    if (arguments_.length !== 0) return null
    return `${guard}return ${result}(${self}->${member}());`
  }
  const maximum = dateSetters.get(member)
  if (maximum === undefined || arguments_.length === 0 || arguments_.length > maximum) return null
  const forwarded: string[] = []
  for (const [index, type] of arguments_.entries()) {
    const formal = `__gea_a${index + 1}`
    if (type === 'double') forwarded.push(formal)
    else if (type === 'gea::Optional<double>') {
      forwarded.push(`(${formal}.has_value() ? std::optional<double>(*${formal}) : std::optional<double>())`)
    } else return null
  }
  return `${guard}return ${result}(${self}->${member}(${forwarded.join(', ')}));`
}

export const hostPrototypeMethodSignatureText = (representation: Representation): string | null => {
  if (representation.kind !== 'function-value-dispatch') return null
  const { abi } = representation
  const parameters = [...(abi.receiver === null ? [] : [cppTypeOf(abi.receiver)]), ...abi.parameters.map(cppAbiParameterType)]
  return `${cppResultTypeOf(abi.result)}(${parameters.join(', ')})`
}
