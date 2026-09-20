import type { DeclarationId, StructuralTypeId } from '../../identity/ids.js'
import type {
  AbiParameter,
  CallableAbi,
  Ownership,
  RecordField,
  Representation,
  ScalarDomain,
  TaggedUnionArm,
  TypedArrayElementDomain
} from '../../representation/model.js'
import { arrayExtensionKey, representationKey } from '../../representation/model.js'
import type { ConstantLiteral } from '../../semantics/model/operands.js'
import { symbolPropertyKeyDeclarationOf } from '../../semantics/model/structural-types.js'

/**
 * Representation -> physical C++ type spelling. This is the one authoritative
 * mapping: nothing downstream re-derives a carrier's C++ type from generated
 * text, a name, or a second table. `cppTypeOf`'s switch has no `default` on
 * purpose -- adding a `Representation` kind in `representation/model.ts`
 * without adding a case here is a compile error, not a silently-wrong runtime
 * fallback.
 */

const cppIdentifierCharacters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'

/**
 * Checker/semantic identities are opaque strings that may contain characters
 * a C++ identifier cannot (the `|` `identity/ids.ts` uses as a field
 * separator, for one). No RegExp is admitted under this directory, so
 * sanitization walks the string one code point at a time instead of matching
 * a pattern against it.
 */
const cppDigits = '0123456789'

export const sanitizeForCppIdentifier = (raw: string): string => {
  let sanitized = ''
  for (const character of raw) {
    sanitized += cppIdentifierCharacters.includes(character) ? character : '_'
  }
  return sanitized
}

/** The emitted file-scope variable name for a binding cell a run-once region owns. */
export const cppGlobalName = (declaration: DeclarationId): string => `gea_global_${sanitizeForCppIdentifier(declaration)}`

/** The emitted struct name for a closed record shape (or a native record's own shape). The one authority other sections must also call. */
export const cppRecordStructName = (shapeId: string): string => `gea_record_${sanitizeForCppIdentifier(shapeId)}`

/**
 * An injective identifier encoding for an opaque structural identity.
 *
 * `sanitizeForCppIdentifier` intentionally repairs ordinary display-derived
 * names, but it is not injective (`a-b` and `a_b` both repair to `a_b`). A
 * recursive wrapper's name IS its carrier identity, so every non-alphanumeric
 * code point is escaped rather than repaired. Underscores are escaped too,
 * making the `_x..._` escapes self-delimiting and collision-free.
 */
const encodeStructuralIdentityForCpp = (identity: string): string => {
  let encoded = ''
  for (const character of identity) {
    if (cppIdentifierCharacters.includes(character) && character !== '_') {
      encoded += character
      continue
    }
    encoded += `_x${(character.codePointAt(0) ?? 0).toString(16)}_`
  }
  return encoded
}

/**
 * The file-scope wrapper which closes one recursive native container equation.
 *
 * This is named from the sealed structural identity, never a source spelling:
 * aliases can be anonymous or share a display name, while an interned id is
 * the one fact derivation, verification, and every C++ use site agree names
 * this one physical object type.
 */
export const cppRecursiveContainerName = (type: StructuralTypeId | string): string =>
  `gea_recursive_${encodeStructuralIdentityForCpp(type)}`

/**
 * The emitted struct name for the typed fields an array-extending interface
 * adds (`array-object.extension`). Named by the FIELDS' own identity --
 * `arrayExtensionKey`, the same text the carrier's key carries -- hashed
 * (FNV-1a, 64-bit, stable across runs) because a field list is not a C++
 * identifier; two interfaces declaring the same fields over the same
 * carriers share one struct, exactly as they share one carrier.
 */
export const cppArrayExtensionStructName = (extension: readonly RecordField[]): string => {
  const key = arrayExtensionKey(extension)
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < key.length; index += 1) {
    hash ^= BigInt(key.charCodeAt(index))
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return `gea_arrayext_${hash.toString(16)}`
}

/** The emitted variable name for one try statement's finally-clause scope guard, keyed by the region's own operation id so two in a function never collide. */
export const cppFinallyGuardName = (region: string): string => `gea_finally_${sanitizeForCppIdentifier(region)}`

/** The slot one try statement parks an in-flight exception in while its finally clause runs; keyed the same way, and for the same reason, as the guard beside it. */
export const cppFinallyPendingName = (region: string): string => `gea_finally_pending_${sanitizeForCppIdentifier(region)}`

/**
 * Struct declarations for every `record` / `native-record-ref` carrier a
 * program's selected representations require.
 *
 * `cppTypeOf` (types.ts) spells a record carrier as a bare identifier --
 * `cppRecordStructName(shapeId)` -- because a use site only ever needs the
 * name, never the body. Something still has to emit the body once per struct,
 * and this is that something: the one place a `RecordField[]` actually
 * becomes C++ member declarations.
 */

const cppIdentifierStartCharacters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'
const cppIdentifierContinueCharacters = `${cppIdentifierStartCharacters}0123456789`
/**
 * No `RegExp` literal is admitted under `src/targets/cpp/` (architecture.mjs
 * enforces it), so identifier shape is a character walk, exactly like
 * `sanitizeForCppIdentifier` in types.ts. Unlike that helper, this one never
 * repairs what it finds: a field key is a record's own shape, not a name this
 * renderer is free to invent a substitute for.
 */
const isCppIdentifierShaped = (candidate: string): boolean => {
  let sawCharacter = false
  let atStart = true
  for (const character of candidate) {
    const allowed = atStart ? cppIdentifierStartCharacters.includes(character) : cppIdentifierContinueCharacters.includes(character)
    if (!allowed) return false
    sawCharacter = true
    atStart = false
  }
  return sawCharacter
}

/**
 * A small, non-exhaustive set of C++ reserved words. Exhaustiveness is not the
 * point -- a field key colliding with an obscure alternative-operator keyword
 * (`bitand`, `compl`, ...) is vanishingly unlikely from TypeScript source, and
 * the fail-closed behaviour below only needs to catch the common case: a field
 * named `class`, `new`, `template`, and the like.
 */
const cppReservedKeywords = new Set([
  'alignas',
  'alignof',
  'and',
  'and_eq',
  'asm',
  'auto',
  'bool',
  'bitand',
  'bitor',
  'break',
  'case',
  'catch',
  'char',
  'char8_t',
  'char16_t',
  'char32_t',
  'class',
  'concept',
  'const',
  'const_cast',
  'consteval',
  'constexpr',
  'constinit',
  'compl',
  'continue',
  'co_await',
  'co_return',
  'co_yield',
  'default',
  'delete',
  'decltype',
  'do',
  'double',
  'dynamic_cast',
  'else',
  'enum',
  'explicit',
  'export',
  'extern',
  'false',
  'float',
  'for',
  'friend',
  'goto',
  'if',
  'inline',
  'int',
  'long',
  'mutable',
  'namespace',
  'new',
  'noexcept',
  'not',
  'not_eq',
  'nullptr',
  'operator',
  'or',
  'or_eq',
  'private',
  'protected',
  'public',
  'register',
  'requires',
  'reinterpret_cast',
  'return',
  'short',
  'signed',
  'sizeof',
  'static',
  'static_assert',
  'static_cast',
  'struct',
  'switch',
  'template',
  'this',
  'thread_local',
  'throw',
  'true',
  'try',
  'typedef',
  'typeid',
  'typename',
  'union',
  'unsigned',
  'using',
  'virtual',
  'void',
  'volatile',
  'wchar_t',
  'while',
  'xor',
  'xor_eq'
])

/**
 * The textual marker `derive.ts`'s `recordFieldKeyOf` publishes for a
 * symbol-keyed record field: `sym(<declaration>)`, the identical convention
 * `structuralShapeKey`'s `keyOfPropertyKey` (semantics/model/structural-types.ts)
 * already uses to key a symbol member into a shape's own canonical identity.
 * Reusing that exact text is deliberate, not cosmetic: it is the one string a
 * symbol key is already known by throughout this compiler, so a second,
 * independently-invented spelling here would be a second opinion about what
 * names the same field.
 *
 * `derive.ts` is target-neutral and states only *which* member a field names;
 * this module is the one place that name becomes a C++ member spelling --
 * exactly the split a tuple's positional key (`String(position)`, recognized
 * below by shape alone) already uses. Symbol keys need an explicit marker
 * instead of a shape test because a declaration id's own text (`decl|...`) is
 * not self-describing the way an all-digit position is.
 */

/**
 * The declaration id inside a `sym(<declaration>)` marker, or `null` when
 * `key` is not shaped like one.
 *
 * A source-spelled property name that happens to match this exact shape is a
 * theoretical collision this function cannot rule out by construction -- the
 * same residual risk `cppReservedKeywords` and the `gea_` prefix reservation
 * below already accept for the identical reason: catching the case that
 * actually occurs is the bar, not exhaustive proof against a name no real
 * program spells. Getting it wrong is not silent, either: two fields that
 * collapsed to one marker would still need to disagree on `value`'s shape to
 * go unnoticed, and disagreeing on the struct member itself is a duplicate
 * C++ member declaration, which clang refuses.
 */
const symbolFieldDeclarationOf = symbolPropertyKeyDeclarationOf

/**
 * The reserved member-name prefix a symbol-keyed field mangles into.
 *
 * Placing it inside the `gea_` namespace is what makes recognizing it safe:
 * every key that still carries a plain `gea_` prefix by the time it reaches
 * `cppRecordFieldName` is refused a few lines below, so no key this compiler
 * did not mint itself can ever arrive already wearing this prefix.
 */
const cppSymbolFieldNamePrefix = 'gea_sym_'

/**
 * The reserved member-name prefix an escaped key mangles into, and the one
 * character inside an escaped name that does not stand for itself.
 *
 * `gea_key_` is the third member of the `gea_` family, alongside `gea_slot_`
 * (a tuple position) and `gea_sym_` (a symbol's declaration). Those three and
 * `records.ts`'s `gea_dynamic` sidecar are pairwise separated by the character
 * right after `gea_` -- `k`, `s`, `s`, `d`, with `slot`/`sym` parting one
 * character later -- and none of them is reachable by a key that passes
 * through unchanged, because a pass-through key inside the `gea_` prefix is
 * escaped instead. The four families are disjoint by construction, not by
 * hoping no program spells one of these names.
 *
 * `q` introduces an escape. A letter rather than `_` is deliberate: the prefix
 * already ends in `_`, so an escape that began with one would put `__` -- a
 * spelling C++ reserves to the implementation in every scope ([lex.name]/3) --
 * at the head of every name minted from a key that does not start with a
 * letter. `q` is the rarest letter in ordinary property names, so the readable
 * half of a mangled name stays readable.
 */
const cppEscapedFieldNamePrefix = 'gea_key_'
const cppEscapeIntroducer = 'q'
const cppHexDigits = '0123456789abcdef'

/**
 * A code point as fixed-width lowercase hex.
 *
 * Fixed width is what makes an escape self-delimiting without a terminator:
 * a reader always knows how many characters belong to it, so no character has
 * to be reserved as a separator. Spelled by walking nibbles rather than
 * through `toString(16)` for the same reason `sanitizeForCppIdentifier` walks
 * characters -- one visible rule, and no library formatting to drift from.
 */
const cppHexOfCodePoint = (value: number, width: number): string => {
  let text = ''
  for (let shift = width - 1; shift >= 0; shift -= 1) text += cppHexDigits[(value >> (shift * 4)) & 0xf] ?? '0'
  return text
}

/**
 * An arbitrary property key as the tail of an escaped member name.
 *
 * `[A-Za-z0-9]` stands for itself; every other code point -- `_` and the
 * introducer `q` included -- becomes `q` + a width tag + that many hex digits.
 * Escaping `_` is not about whether C++ accepts it (it would): it is what
 * holds the tail's alphabet to exactly `[A-Za-z0-9]` plus escapes, so no `__`
 * can be minted here and the prefix's own trailing `_` cannot begin one
 * either. Escaping `q` is what makes the result readable backwards -- `q`
 * means "an escape follows" and nothing else, so `counterqz2dvalue` has
 * exactly one reading.
 *
 * That single reading is the injectivity argument, and injectivity is the
 * whole point: two distinct keys arriving at one struct member is a layout the
 * program never described, and it compiles. Every produced tail is decoded by
 * one deterministic left-to-right walk -- on `q`, take the tag and its fixed
 * run of hex digits; otherwise take the character -- so this encoder has a
 * left inverse, and a function with a left inverse cannot collapse two inputs.
 * Repair-style sanitization has no such inverse, which is exactly why it is
 * not what this does: `-` -> `_` would map `counter-value` and `counter_value`
 * -- two different properties of the same object -- onto one member.
 *
 * The width tag is always the smallest that fits (`z` <= 0xff, `y` <= 0xffff,
 * `x` for the astral range), which is what makes the encoding a function of
 * the key alone and not of anything about how the key was reached; there is no
 * counter and no visit order anywhere in it, so the same key spells the same
 * member on every run. Iteration is `for...of`, so an astral character is one
 * code point rather than two surrogate halves, and an unpaired surrogate is
 * still a code point and still encodes -- a JS property key is an arbitrary
 * UTF-16 sequence, and this map is required to be total over all of them.
 */
const escapeForCppMemberName = (key: string): string => {
  let escaped = ''
  for (const character of key) {
    if (character !== cppEscapeIntroducer && character !== '_' && cppIdentifierContinueCharacters.includes(character)) {
      escaped += character
      continue
    }
    const code = character.codePointAt(0) ?? 0
    if (code <= 0xff) escaped += `${cppEscapeIntroducer}z${cppHexOfCodePoint(code, 2)}`
    else if (code <= 0xffff) escaped += `${cppEscapeIntroducer}y${cppHexOfCodePoint(code, 4)}`
    else escaped += `${cppEscapeIntroducer}x${cppHexOfCodePoint(code, 6)}`
  }
  return escaped
}

/**
 * The emitted member name for a record field. Total: a JS property key is an
 * arbitrary string, a C++ struct member is an identifier, and this is the one
 * mapping between them.
 *
 * A tuple's slots are record fields keyed by their position -- `"0"`, `"1"` --
 * because a position really is the key, and there is no separate tuple carrier
 * by design. C++ has no such member name, so a positional key is spelled with
 * the reserved `gea_` prefix rather than being prefixed ad hoc: `"0"` and a
 * source property literally named `_0` would otherwise collide, and two
 * distinct fields sharing one member is a silently wrong layout.
 *
 * A symbol-keyed field is the identical situation with a different shape of
 * key: `derive.ts` publishes it as `sym(<declaration>)` rather than digits,
 * and this is the one place that becomes `gea_sym_<mangled declaration>` --
 * an ordinary struct member, not a runtime lookup, because a symbol key is a
 * compile-time constant identity. Naming it by declaration id rather than by
 * the symbol's own printable description is what keeps `{[Symbol.iterator]:
 * f}` and `{"Symbol(Symbol.iterator)": f}` -- two different objects -- from
 * ever mangling to the same member: the declaration id is stable identity,
 * the description is not even unique (`Symbol('x')` and a second, unrelated
 * `Symbol('x')` print identically and are still different symbols).
 *
 * A key that is already a C++ identifier, is not a reserved word, and is not
 * inside this compiler's own `gea_` prefix passes through byte-for-byte, which
 * is nearly every key any program writes: a member is named after the property
 * it carries, so that reading the emitted struct against the source type is
 * possible at all.
 *
 * Everything else is escaped into `gea_key_` -- a CSS class name used as a key
 * (`counter-value`), a C++ keyword (`class`, `template`), a key that starts
 * with a digit without spelling a position (`0x`), a non-ASCII key, the empty
 * key, and any key already wearing the `gea_` prefix. Each of those used to
 * throw. Throwing broke the contract `cppRecordDeclarations` states in
 * `records.ts` -- "A gap here is reported, never thrown ... an exception
 * escaping from there takes down a compilation that has a perfectly good
 * report to give" -- and it was not even a gap to report: `{'counter-value':
 * 1}` is ordinary, correct TypeScript, so a total spelling is what this
 * function owes its callers rather than something it may decline to provide.
 * Refusing by name would have been the fail-closed answer to a genuine gap;
 * there is no gap here, only a name that has to be minted, and
 * `escapeForCppMemberName` above carries the argument that minting it cannot
 * collapse two properties into one member.
 */
/**
 * Whether a record field key names a SYMBOL member rather than a string one.
 *
 * The two halves of a JavaScript object's key space are physically different
 * at runtime -- `Object.keys` lists one and not the other -- and a dynamic
 * `[[Get]]` arrives holding a `gea::Symbol` id minted while the program ran,
 * which no compile-time declaration id can be compared against. So the field
 * dispatcher `records.ts` renders has to know which of its fields it can match
 * by text and which it cannot, and asking here rather than re-testing the
 * `sym(...)` spelling in a second module keeps one authority over that marker.
 */
export const cppRecordFieldKeyIsSymbol = (key: string): boolean => symbolFieldDeclarationOf(key) !== null

export const cppRecordFieldName = (key: string): string => {
  const symbolDeclaration = symbolFieldDeclarationOf(key)
  if (symbolDeclaration !== null) return `${cppSymbolFieldNamePrefix}${sanitizeForCppIdentifier(symbolDeclaration)}`
  // A key already inside the reserved prefix takes the escaped path instead of
  // passing through: `gea_dynamic` is a legal property name *and* the sidecar
  // member `records.ts` mints, and only one of the two may own that spelling.
  if (key.length > 0 && !key.startsWith('gea_')) {
    if (cppDigits.includes(key[0] ?? '')) {
      let positional = true
      for (const character of key) positional = positional && cppDigits.includes(character)
      if (positional) return `gea_slot_${key}`
    } else if (isCppIdentifierShaped(key) && !cppReservedKeywords.has(key)) return key
  }
  return `${cppEscapedFieldNamePrefix}${escapeForCppMemberName(key)}`
}

/**
 * The presence bit paired with an optional record field.
 *
 * `RecordField.required` distinguishes a missing property from a property
 * whose value is `undefined`; the value carrier cannot always do that (and an
 * `optional<undefined | T>` must not be asked to).  Generated record structs
 * therefore keep this independent bit.  The `gea_` prefix is collision-free
 * with source members because `cppRecordFieldName` escapes every source key
 * beginning with that reserved prefix.
 */
export const cppRecordFieldPresenceName = (key: string): string => `gea_present_${cppRecordFieldName(key)}`

/**
 * The environment a record carries for one accessor half whose body captures.
 *
 * An accessor occupies no storage for its VALUE -- that is what makes it an
 * accessor -- but a getter written inside a function closes over that
 * function's locals, and the only thing that can carry those to it is the
 * object the getter is reached through. So a capturing accessor does occupy
 * storage: one type-erased `gea::PackedEnvironment`, exactly what a
 * `CallableObject` holds for the same reason, populated where the literal is
 * allocated and read back at every call.
 */
export const cppRecordAccessorEnvironmentName = (key: string, half: 'getter' | 'setter'): string =>
  `gea_env_${half === 'getter' ? 'get' : 'set'}_${cppRecordFieldName(key)}`

/** The descriptor-attribute cell paired with one fixed native field. */
export const cppRecordFieldAttributesName = (key: string): string => `gea_attributes_${cppRecordFieldName(key)}`

/**
 * A constant's C++ spelling, decided by the carrier that holds it.
 *
 * `OperandSource.constant.text` is the language's own literal form, which is
 * not always C++'s: a string's text is the *contents*, with no quotes and no
 * escaping, so emitting it verbatim spells an identifier rather than a literal
 * and the field key `x` becomes a reference to a variable named `x`. The
 * carrier is what says which reading is meant, which is why this takes one
 * rather than guessing from the text.
 */
/**
 * Whether a carrier has an empty value that behaves like absence: using it
 * faults rather than answering. Every one of these is a pointer or a handle
 * whose default state is "refers to nothing".
 */
const carriesAbsence = (representation: Representation): boolean => {
  if (representation.kind === 'native-handle' || representation.kind === 'array-object' || representation.kind === 'optional') return true
  if (
    representation.kind === 'record' ||
    representation.kind === 'record-with-index' ||
    representation.kind === 'native-record-ref' ||
    representation.kind === 'typed-array' ||
    representation.kind === 'array-buffer' ||
    representation.kind === 'shared-array-buffer' ||
    representation.kind === 'data-view'
  ) {
    return representation.ownership === 'shared-refcount'
  }
  return representation.kind === 'class-ref' && representation.ownership === 'shared-refcount'
}

/**
 * The one spelling of `undefined` as a value.
 *
 * Both the constant path (a literal `undefined` in source) and `void`'s result
 * name the same value, so they name it through the same constant rather than
 * each spelling the struct themselves -- two places writing the same C++ text
 * is exactly how the two drift apart when the runtime's spelling changes.
 */
export const cppUndefinedValue = 'gea::Undefined{}'

/**
 * The value `undefined`, spelled into a carrier that can hold it -- `null` for
 * one that cannot.
 *
 * Two sites ask this exact question and each used to answer it: an OMITTED
 * argument (`emit-context.ts`, whose slot receives the `undefined` the language
 * binds an unpassed parameter to, ECMA-262 10.2.11) and a `[[Get]]` of a key an
 * object does not have (`emit-union-properties.ts`, 10.1.8 step 3). They are one
 * question -- what is `undefined` in this carrier -- so they are one renderer.
 *
 * The four carriers that hold it, and no wider set: `undefined` itself; a
 * `dynamic` box, which default-constructs to `Tag::Undefined`; an `optional`
 * whose absence IS `undefined` (one spending its absence on `null` cannot);
 * and a tagged union with an `undefined` ARM, named by index because a
 * default-constructed union holds its FIRST arm, which need not be that one.
 *
 * Deliberately narrower than `carriesAbsence` below. That predicate answers
 * "has an empty value that faults when used", which an empty `Ref<T>` does --
 * but an empty `Ref` is a null pointer, not `undefined`, and handing one back
 * for a property read would answer a program that compares the result to
 * `undefined` with a crash instead of `true`.
 */
export const cppUndefinedIn = (representation: Representation): string | null => {
  if (representation.kind === 'undefined') return cppUndefinedValue
  if (representation.kind === 'dynamic') return `${cppTypeOf(representation)}()`
  if (representation.kind === 'optional' && representation.absence === 'undefined') return `${cppTypeOf(representation)}()`
  if (representation.kind === 'tagged-union') {
    const index = representation.arms.findIndex((arm) => arm.value.kind === 'undefined')
    if (index < 0) return null
    const union = cppTypeOf(representation)
    return `${union}::ofArm<${index}>(${union}::ArmType<${index}>{})`
  }
  return null
}

const carriesConstantLiteral = (representation: Representation, literal: ConstantLiteral): boolean => {
  if (representation.kind === 'tagged-union') return representation.arms.some((arm) => carriesConstantLiteral(arm.value, literal))
  if (literal === 'undefined' || literal === 'null') return representation.kind === literal
  if (literal === 'string') return representation.kind === 'string'
  if (literal === 'boolean') return representation.kind === 'scalar' && representation.domain === 'boolean'
  if (literal === 'bigint') return representation.kind === 'scalar' && representation.domain === 'bigint'
  return representation.kind === 'scalar' && representation.domain === 'number'
}

export const cppConstantLiteral = (text: string, literal: ConstantLiteral, representation: Representation): string => {
  // A reference to one member of a generic function set IS its index -- the
  // constant `ir/lower.ts` mints for a read of the member's own name.
  if (representation.kind === 'generic-function-set') return `static_cast<std::uint8_t>(${text})`
  // `null` and `undefined` are spelled by their carriers, not by their source
  // text: the language writes `null` and C++ has no such name, so emitting the
  // text verbatim spells a reference to an identifier that does not exist.
  // Which of the two this is comes from the literal form and never from the
  // text, because the string `'undefined'` -- the right operand of every
  // `typeof x !== 'undefined'` guard -- spells itself the same way.
  if (literal === 'undefined' || literal === 'null') {
    if (representation.kind === 'null') return 'nullptr'
    if (representation.kind === 'undefined') return cppUndefinedValue
    if (representation.kind === 'tagged-union') {
      const index = representation.arms.findIndex((arm) => arm.value.kind === literal)
      const arm = representation.arms[index]
      if (arm) return `${cppTypeOf(representation)}::ofArm<${index}>(${cppConstantLiteral(text, literal, arm.value)})`
    }
    // A `dynamic` carrier is a `gea::Value`, and unlike every carrier
    // `carriesAbsence` below recognizes, it is not merely absence-shaped --
    // it is the JS value model itself, which already has a tag for exactly
    // this. `Value()` default-constructs to `Tag::Undefined` (`gea_runtime.h`'s
    // own comment: "a hoisted cell holds *some* value from the moment it
    // exists"), the same spelling `emit-narrowing.ts`'s tagged-union widening
    // already uses for its untaken-arm fallback -- reused here rather than
    // restated, so the two can't drift. `null` has no default-construction
    // shortcut, so it goes through `box` explicitly with the identical tag
    // `emit-narrowing.ts`'s `dynamicTagFor` states for `{ kind: 'null' }`.
    // Both are reachable the moment a value whose STATIC type is `any` --
    // this constant's own carrier, chosen upstream because nothing narrowed
    // it -- happens to hold the literal `null`/`undefined`: an unresolvable
    // global read as `typeof`'s operand (ECMA-262 13.5.1.2) is exactly one
    // such case, but neither this literal nor this carrier is specific to it.
    if (representation.kind === 'dynamic') {
      if (literal === 'undefined') return 'gea::Value()'
      return 'gea::Value::box(gea::Value::Tag::Null, static_cast<std::nullptr_t>(nullptr))'
    }
    // `undefined as unknown as T` -- TypeScript's own double assertion, which
    // the framework uses to declare an ambient global that a target may not
    // inject. The value really is absent; only its carrier is T's. An empty T
    // is the faithful spelling wherever T *has* an empty value that faults on
    // use, the same way reading a property of `undefined` faults. A carrier
    // with no such value -- a `double`, where an empty one is `0` and would
    // answer arithmetic instead of faulting -- is refused rather than zeroed.
    if (!carriesAbsence(representation)) {
      throw new Error(
        `the constant \`${literal}\` was asserted into a ${representationKey(representation)} carrier, which has no absent value that faults when used`
      )
    }
    return `${cppTypeOf(representation)}{}`
  }
  // Contextual typing can publish a literal directly in its union carrier.
  // The literal still occupies one specific arm, so construct that arm here
  // instead of emitting the bare C++ scalar into a TaggedUnion declaration.
  if (representation.kind === 'tagged-union') {
    const index = representation.arms.findIndex((arm) => carriesConstantLiteral(arm.value, literal))
    const arm = representation.arms[index]
    if (arm) return `${cppTypeOf(representation)}::ofArm<${index}>(${cppConstantLiteral(text, literal, arm.value)})`
  }
  // A constant materialized DIRECTLY in a boxed carrier, which is what an
  // operand whose declared type is `any` gets: `f(x: any = 1)`'s default is a
  // `1` the merge holds in a `gea::Value`, and there is no conversion step to
  // box it because the constant was never anything else first. Emitting the
  // bare literal spelled `v0 = (1);` against a `gea::Value` cell -- no viable
  // overloaded `=`, an uncompilable unit from a program that says nothing
  // unusual.
  //
  // The tag comes from the LITERAL FORM, which is the only thing known about a
  // constant here, and every form has one: this is the same tag table
  // `emit-narrowing.ts`'s `dynamicTagFor` states for the conversion path,
  // restricted to the four literal kinds that reach this line (`null` and
  // `undefined` returned above).
  //
  // The value is force-cast to that same literal form's C++ type before it
  // reaches `box`, for the identical reason `emit-narrowing.ts`'s
  // `widenedStoreText` now does the same at its own dynamic-boxing site:
  // `box`'s template argument otherwise deduces from `text`'s bare C++
  // spelling, and a bare numeric literal like `1` is a C++ `int`, not the
  // `double` the `Number` tag promises -- `box` then records `int` as the
  // payload's static type, and a checked unboxer downstream, comparing that
  // against the carrier's declared `double`, refuses; an unchecked one reads
  // the wrong byte width back as garbage. `static_cast<double>(1)` converts
  // before boxing, exactly like direct-initializing a `double`-typed
  // parameter with `1` already does.
  if (representation.kind === 'dynamic') {
    const tag = literal === 'string' ? 'String' : literal === 'boolean' ? 'Boolean' : literal === 'bigint' ? 'BigInt' : 'Number'
    const cppType = literal === 'string' ? 'std::string' : literal === 'boolean' ? 'bool' : literal === 'bigint' ? 'gea::BigInt' : 'double'
    const rendered =
      literal === 'string' ? cppStringLiteral(text) : literal === 'bigint' ? `gea::BigInt::parse(${cppStringLiteral(text)})` : text
    return `gea::Value::box(gea::Value::Tag::${tag}, static_cast<${cppType}>(${rendered}))`
  }
  if (literal === 'bigint') return `gea::BigInt::parse(${cppStringLiteral(text)})`
  if (literal !== 'string') return text
  return cppStringLiteral(text)
}

/**
 * The escapes C++ spells with a letter, for the control characters that have one.
 *
 * Named rather than numeric because the emitted text is read by people: a
 * `split("\n")` that emitted `split("\012")` would be correct and unreadable.
 */
const cppNamedEscapes: ReadonlyMap<string, string> = new Map([
  ['\n', '\\n'],
  ['\r', '\\r'],
  ['\t', '\\t'],
  ['\v', '\\v'],
  ['\f', '\\f'],
  ['\b', '\\b'],
  ['\u0007', '\\a']
])

/**
 * A string as a C++ literal expression, retaining embedded zero bytes.
 *
 * A newline is NOT legal raw inside one, whatever this used to claim. C++ ends
 * a narrow string literal at the physical line, so a `"\n"` written through
 * verbatim emits an unterminated literal and the next line of the program is
 * read as a continuation of it -- a compile error three lines from the string
 * that caused it. The corpus hid this for as long as no program put a control
 * character in a string; `body.split('\n')` in an ordinary editor app is all it
 * takes.
 *
 * The remaining control characters get an OCTAL escape rather than a hex one.
 * `\x` is greedy -- it consumes every hex digit that follows, so `\x01` before a
 * literal `2` becomes the single character `\x012` -- while an octal escape is
 * at most three digits, and three are always written. Everything else,
 * including non-ASCII UTF-8, is legal as itself and stays exactly as the source
 * wrote it.
 */
const rawCppStringLiteral = (content: string): string => {
  let quoted = '"'
  for (const character of content) {
    if (character === '"' || character === '\\') {
      quoted += `\\${character}`
      continue
    }
    const named = cppNamedEscapes.get(character)
    if (named !== undefined) {
      quoted += named
      continue
    }
    const code = character.codePointAt(0) ?? 0
    // for...of combines valid pairs, leaving only unpaired UTF-16 units here.
    // A UTF-8 file writer replaces those units with U+FFFD. Spell their WTF-8
    // bytes explicitly so the native string retains JavaScript's exact units.
    if (code >= 0xd800 && code <= 0xdfff) {
      for (const byte of [0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)])
        quoted += `\\${byte.toString(8).padStart(3, '0')}`
      continue
    }
    quoted += code < 0x20 || code === 0x7f ? `\\${code.toString(8).padStart(3, '0')}` : character
  }
  return `${quoted}"`
}

/** A literal view retains embedded NUL bytes without allocating or borrowing a temporary string. */
export const cppStringViewLiteral = (content: string): string => {
  const literal = rawCppStringLiteral(content)
  return `std::string_view{${literal}, sizeof(${literal}) - 1}`
}

export const cppStringLiteral = (content: string): string => {
  const literal = rawCppStringLiteral(content)
  // An implicit std::string(const char*) conversion stops at the first NUL.
  // Let C++ measure the literal's encoded byte length so non-ASCII text is
  // counted correctly without duplicating the runtime's UTF-8 encoding.
  return content.includes('\u0000') ? `std::string(${literal}, sizeof(${literal}) - 1)` : literal
}

/** The emitted class name for a nominal class declaration. */
export const cppClassName = (declaration: DeclarationId): string => `gea_class_${sanitizeForCppIdentifier(declaration)}`

/** The emitted function that performs one class's `[[Construct]]`: allocate, run field initializers, run the constructor body. */
export const cppConstructName = (declaration: DeclarationId): string => `gea_construct_${sanitizeForCppIdentifier(declaration)}`

/**
 * The emitted function that runs one class's initialization against an object
 * that already exists -- the half of `[[Construct]]` after the allocation.
 *
 * `super(...)` needs exactly that half and no other: the derived construction
 * allocated the object, and the base must initialize *it* rather than allocate
 * a second one of its own type. Only a class some other class extends gets one
 * emitted, because only such a class is ever initialized through a receiver it
 * did not allocate.
 */
export const cppInitializeName = (declaration: DeclarationId): string => `gea_initialize_${sanitizeForCppIdentifier(declaration)}`

/** The emitted function name for one executable body: a function, or a module/class-evaluation region. */
export const cppBodyName = (owner: string): string => `gea_body_${sanitizeForCppIdentifier(owner)}`

/**
 * The SOURCE DECLARATION a monomorphic copy belongs to: the owner id minus its
 * `@N` copy ordinal.
 *
 * A generic function compiled for two instantiations is two bodies and two
 * thunks, and it is still ONE JavaScript function object. `@N` is a copy
 * ordinal, not a site, so stripping it is the whole of "which declaration is
 * this". Anything that is not a trailing run of digits after the last `@` is
 * left alone -- an owner that never had a copy ordinal is its own declaration.
 */
export const callableDeclarationOf = (owner: string): string => {
  const at = owner.lastIndexOf('@')
  if (at < 0) return owner
  const ordinal = owner.slice(at + 1)
  const numeric = ordinal.length > 0 && [...ordinal].every((character) => character >= '0' && character <= '9')
  return numeric ? owner.slice(0, at) : owner
}

/**
 * The one program-wide object whose ADDRESS identifies a source declaration.
 *
 * `gea::identifyCallable<&X>` tags a callable with
 * `detail::CallableDeclarationTag<X>`, documented in the runtime as "one
 * program-wide address per emitted source declaration". Instantiating it on the
 * per-COPY thunk pointer gave every copy its own tag, which is what made
 * `stateStack[i] !== State.done` true forever in
 * `generic-state-function-array.ts`. This name is shared by every copy of one
 * declaration, so the tag finally is what its own comment says.
 */
export const cppCallableDeclarationTagName = (owner: string): string =>
  `gea_decl_tag_${sanitizeForCppIdentifier(callableDeclarationOf(owner))}`

/** The one static module-record accessor for a resolved CommonJS module body. */
export const cppCommonJsModuleName = (owner: string): string => `gea_commonjs_module_${sanitizeForCppIdentifier(owner)}`
export const cppCommonJsRecordName = (owner: string): string => `gea_commonjs_record_${sanitizeForCppIdentifier(owner)}`

/** The tag type spelled inside `gea::NativeHandle<...>` for one versioned host protocol. */
const cppNativeHandleTag = (protocol: string, version: number): string =>
  `gea_native_protocol_${sanitizeForCppIdentifier(protocol)}_v${version}`

// `ScalarDomain | TypedArrayElementDomain`: this is also the one authority a
// typed-array element's C++ type is spelled from (`cppTypeOf`'s `typed-array`
// case, below), rather than a second table that could disagree with this one
// on the six domain names the two types share.
export const cppScalarType = (domain: ScalarDomain | TypedArrayElementDomain): string => {
  switch (domain) {
    case 'boolean':
      return 'bool'
    case 'number':
      return 'double'
    case 'bigint':
      return 'gea::BigInt'
    case 'int8':
      return 'int8_t'
    case 'uint8':
      return 'uint8_t'
    // A DISTINCT C++ type, not `uint8_t`, so `Uint8ClampedArray`'s write rule
    // (ECMA-262 7.1.11 `ToUint8Clamp` -- clamp to [0, 255], round halves to
    // EVEN) is selected by overload resolution rather than by a runtime kind
    // flag. `gea::ClampedUint8` is one byte wide and standard-layout, so a
    // view over it aliases the same bytes any other view does.
    case 'uint8-clamped':
      return 'gea::ClampedUint8'
    case 'int16':
      return 'int16_t'
    case 'uint16':
      return 'uint16_t'
    case 'int32':
      return 'int32_t'
    case 'uint32':
      return 'uint32_t'
    case 'float32':
      return 'float'
    case 'float64':
      return 'double'
  }
}

/**
 * Ownership is a property of the physical carrier, not of the value's shape:
 * the same record shape is a bare struct when owned, a `shared_ptr` when
 * refcounted, and a reference when borrowed. Wrapping happens once, here,
 * rather than at each call site that spells a class-ref/record/dictionary type.
 */
const cppOwnershipWrap = (ownership: Ownership, inner: string): string => {
  switch (ownership) {
    case 'owned':
      return inner
    case 'shared-refcount':
      return `gea::Ref<${inner}>`
    case 'borrowed':
      return `${inner}&`
  }
}

/**
 * A parameter's ownership replaces the carrier's own, it does not stack on top
 * of it. The two state different facts -- how the value is stored versus how it
 * is passed -- and applying both spells `std::shared_ptr<std::shared_ptr<T>>`
 * for a shared record passed by shared reference: valid C++, and wrong.
 *
 * This is the one spelling of a formal, and the body's own declaration of the
 * value it reads out of that formal must use it too. When the two were spelled
 * separately -- the formal from the ABI's passing mode, the local from the
 * carrier's storage -- they disagreed for every reference parameter.
 */
export const cppAbiParameterType = (parameter: AbiParameter): string => {
  // `ArrayBuffer`'s bytes have observable reference identity: every TypedArray
  // view aliases that one block. A function-value signature can retain an
  // `owned` passing-mode residue even after publication selects the standard
  // buffer carrier as shared-refcounted; applying that stale mode here copies
  // the vector while the parameter operation and every use hold `Ref` to the
  // block. Keep the shared carrier in that one impossible pairing. Borrowed
  // and already-shared conventions remain exactly as declared.
  const aliasing =
    parameter.value.kind === 'array-buffer' ||
    parameter.value.kind === 'shared-array-buffer' ||
    // A `DataView` and a `TypedArray` are the same argument one step out: each
    // is an object with observable reference identity over a block it does not
    // own, so a by-value formal copies the view while its own operations and
    // every other use hold `Ref` to it -- clang's `no viable overloaded '='`
    // on `b0 = gea_arg_0`, from a `DataView` parameter in ordinary code.
    parameter.value.kind === 'data-view' ||
    parameter.value.kind === 'typed-array'
  if (aliasing && parameter.value.ownership === 'shared-refcount' && parameter.ownership === 'owned') {
    return cppTypeOf(parameter.value)
  }
  return cppTypeOf(parameter.value, parameter.ownership)
}

/**
 * Whether a receiver's carrier is a refcounted handle.
 *
 * A body that takes one BY VALUE increments and decrements a count on every
 * call, for an object the caller already holds for the whole call -- so the
 * count buys nothing and sits on the hot path of every method. Measured on
 * `bench/comparison/fixtures/method_calls.ts`: 31.9ms taking the receiver by
 * value, 15.9ms taking it by reference, against 19.0ms for the hand-written
 * baseline whose receiver is a stack object.
 *
 * The ABI is untouched -- a `CallableObject` still stores the by-value
 * convention every caller agrees on -- so this is the BODY's spelling only, the
 * same split `formalsOf`'s `narrowed` makes.
 */
export const cppRefcountedReceiver = (representation: Representation): boolean =>
  'ownership' in representation && representation.ownership === 'shared-refcount'

/**
 * A result position, where `void` is a real spelling rather than an error.
 *
 * `cppTypeOf` refuses `void` because no *value* can be carried by it, and that
 * refusal is correct everywhere a value is stored. A function's return type is
 * the one position where "carries nothing" is expressible in C++, and routing
 * it through `cppTypeOf` made every `void`-returning callable unspellable --
 * which read as a missing physical type for the whole carrier.
 */
export const cppResultTypeOf = (representation: Representation): string =>
  representation.kind === 'void' ? 'void' : cppTypeOf(representation)

/**
 * A broad source `Function` still carries a Value because it has no static
 * callable ABI, but inside a typed sum it is not that sum's dynamic remainder.
 * Give that arm a distinct physical type so runtime union admission can retain
 * its checker-published Function-tag discriminator after Representation facts
 * are no longer available to the C++ adapter.
 */
export const cppTaggedUnionArmType = (arm: TaggedUnionArm): string =>
  arm.runtimeDiscriminator.kind === 'callable-tag' ? 'gea::FunctionValue' : cppTypeOf(arm.value)

/**
 * The calling convention as a C++ function-type spelling: result first, then
 * the receiver (if any) as the first formal, then the declared parameters --
 * mirroring `abiKey` in `representation/model.ts`, which keys this exact
 * shape for plan-conflict detection. `function`/`function-family`/
 * `constructor-family`/`function-value-family`/`function-value-dispatch` all
 * carry one `CallableAbi` and therefore all resolve through this one helper.
 */
export const cppAbiType = (abi: CallableAbi): string => {
  const receiver = abi.receiver === null ? [] : [cppTypeOf(abi.receiver)]
  const parameters = abi.parameters.map(cppAbiParameterType)
  return `${cppResultTypeOf(abi.result)}(${[...receiver, ...parameters].join(', ')})`
}

/**
 * `ownership` overrides the carrier's own ownership for this one spelling. It is
 * how a parameter position states its passing mode without a second table that
 * could disagree with this one.
 */
/**
 * Every tagged union a translation unit spells, bound to one short name.
 *
 * A union's C++ spelling is its whole arm list, and the arm list of three's
 * `NativeUniformValue | null | undefined` is 1.3KB. Spelled at every field,
 * formal, local, cast and `ofArm<k>` site, unions were 12.9MB of the three.js app's
 * 38.7MB unit -- 25,410 spellings of a few hundred distinct types. While a
 * unit is being rendered (`beginUnionAliasing` .. `endUnionAliasing`,
 * `translation-unit.ts`), `cppTypeOf` answers the alias instead and records
 * the spelling; the unit then declares `using gea_union_N = <spelling>;`
 * once, ahead of the first use. Aliases are assigned in first-spelling
 * order, which is also dependency order: an inner union is spelled -- and
 * so named -- while its outer union's arm list is being built.
 *
 * Spelling equality is preserved: two representations with one spelling get
 * one alias, so every `cppTypeOf(a) === cppTypeOf(b)` test in the emitter
 * answers exactly as it did on the spellings.
 */
const unionAliasing: { active: boolean; readonly aliases: Map<string, string> } = { active: false, aliases: new Map() }

export const beginUnionAliasing = (): void => {
  unionAliasing.aliases.clear()
  unionAliasing.active = true
}

/** The aliases recorded since `beginUnionAliasing`, in declaration order, and the end of aliasing. */
export const endUnionAliasing = (): readonly { readonly name: string; readonly spelling: string }[] => {
  const recorded = [...unionAliasing.aliases].map(([spelling, name]) => ({ name, spelling }))
  unionAliasing.aliases.clear()
  unionAliasing.active = false
  return recorded
}

export const cppTypeOf = (representation: Representation, ownership: Ownership | null = null): string => {
  switch (representation.kind) {
    case 'unresolved':
      throw new Error(`unresolved representation (${representation.reason}) is lattice bottom and has no physical C++ type`)
    case 'void':
      throw new Error('void is not a value carrier and has no physical C++ type')
    case 'scalar':
      return cppScalarType(representation.domain)
    case 'string':
      return 'std::string'
    case 'symbol':
      return 'gea::Symbol'
    case 'null':
      return 'std::nullptr_t'
    case 'undefined':
      return 'gea::Undefined'
    case 'class-ref':
      return cppOwnershipWrap(ownership ?? representation.ownership, cppClassName(representation.declaration))
    case 'native-handle':
      // The host's own type, spelled verbatim, wherever the plugin installing
      // the protocol stated one. Nothing is derived from `protocol` in that
      // case -- deriving a spelling is how `cppNativeHandleTag` below came to
      // name tags `gea_runtime.h` had never heard of. The tagged handle stays
      // for a protocol with no stated carrier, which is the honest physical
      // answer for a boundary this compiler has been told nothing about.
      return representation.native ?? `gea::NativeHandle<${cppNativeHandleTag(representation.protocol, representation.version)}>`
    case 'record':
    // The struct name is the whole spelling either way: the named fields and
    // the dictionary sidecar for the index-signature half are both members of
    // the one struct `cppRecordStructName` names, rendered by `records.ts`,
    // never a second type a use site would have to spell differently.
    case 'record-with-index':
      return cppOwnershipWrap(ownership ?? representation.ownership, cppRecordStructName(representation.shapeId))
    case 'proxy-object':
      return `gea::ProxyObject<${cppTypeOf(representation.target)}, ${cppTypeOf(representation.handler)}>`
    case 'native-record-ref':
      // A recursive container uses the same name-shaped indirection records
      // use, but its definition is a generated wrapper over a runtime
      // container rather than a record layout. `native` is only the private
      // records-walker marker; the structural identity is the C++ authority.
      if (representation.recursive)
        return cppOwnershipWrap(ownership ?? representation.ownership, cppRecursiveContainerName(representation.recursive.type))
      // The host's own struct name when one was stated, exactly as
      // `native-handle` spells its carrier: the type is the engine's, and a
      // `gea_record_*` name minted here would be a second, incompatible
      // identity for the same value. The layout still derives -- what is
      // suppressed is the DEFINITION (`records.ts`), never the check.
      return cppOwnershipWrap(ownership ?? representation.ownership, representation.native ?? cppRecordStructName(representation.shapeId))
    case 'borrowed-ref':
      return `${cppTypeOf(representation.referent)}&`
    case 'array-object':
      if (representation.recursive)
        return cppOwnershipWrap(ownership ?? representation.ownership, cppRecursiveContainerName(representation.recursive.type))
      return cppOwnershipWrap(ownership ?? representation.ownership, `gea::ArrayObject<${cppTypeOf(representation.element)}>`)
    case 'dense-buffer':
      return `std::vector<${cppTypeOf(representation.element)}>`
    case 'typed-array':
      return cppOwnershipWrap(ownership ?? representation.ownership, `gea::TypedArray<${cppScalarType(representation.element)}>`)
    // The SAME block `gea::TypedArray` stores its bytes behind -- `gea::
    // ArrayBuffer` is an alias of `std::vector<std::uint8_t>` -- so
    // `view.buffer` hands back the very block the view reads rather than a
    // copy of it, and `new Uint8Array(buffer)` aliases rather than copies.
    // That identity is the whole observable content of ECMA-262 25.1.
    case 'array-buffer':
      return cppOwnershipWrap(ownership ?? representation.ownership, 'gea::ArrayBuffer')
    case 'shared-array-buffer':
      return cppOwnershipWrap(ownership ?? representation.ownership, 'gea::SharedArrayBuffer')
    case 'data-view':
      return cppOwnershipWrap(ownership ?? representation.ownership, 'gea::DataView')
    case 'native-sequence':
      return `gea::NativeSequence<${cppTypeOf(representation.element)}>`
    case 'iterator': {
      // `gea::Iterator<E, TReturn, TNext>` (`runtime/gea_runtime.h`) defaults
      // both trailing parameters to `void`, which is what every non-generator
      // cursor and every generator whose completion/resume never resolved to
      // a native carrier (`representation/derive.ts`'s `nativeOrUndefined`)
      // needs -- so the 2-argument spelling stays available for them, and
      // only a carrier that genuinely stores a completion value and/or a
      // resume value spells the wider form. `cppTypeOf` itself refuses to
      // spell bare `void` (it is not a value type), so a valueless slot is
      // spelled `void` HERE, literally, rather than routed through it.
      const isValueless = (carrier: Representation): boolean => carrier.kind === 'void' || carrier.kind === 'undefined'
      const completionValueless = isValueless(representation.completion)
      const resumeValueless = isValueless(representation.resume)
      if (completionValueless && resumeValueless) return `gea::Iterator<${cppTypeOf(representation.element)}>`
      const completionType = completionValueless ? 'void' : cppTypeOf(representation.completion)
      const resumeType = resumeValueless ? 'void' : cppTypeOf(representation.resume)
      return `gea::Iterator<${cppTypeOf(representation.element)}, ${completionType}, ${resumeType}>`
    }
    case 'promise':
      // `cppTypeOf(representation.value)` would throw for `Promise<void>` --
      // `cppTypeOf` refuses to spell `void` on purpose, since `void` is not
      // a value type; only `cppResultTypeOf` (defined above in this same
      // file, and already calling back into `cppTypeOf` for every other
      // kind) knows the ABI-position special case where a bare `void` is the
      // right spelling. `gea::Promise<void>` is that ABI position for the
      // payload, so it is spelled through the same function.
      return `gea::Promise<${cppResultTypeOf(representation.value)}>`
    case 'keyed-collection': {
      if (representation.recursive)
        return cppOwnershipWrap(ownership ?? representation.ownership, cppRecursiveContainerName(representation.recursive.type))
      // Four containers, not one parameterized by a flag: a Set has no value
      // slot at all, and a weak family's key equality is reference identity
      // rather than SameValueZero, so they are genuinely different storage
      // (the same reasoning `array-object`/`dense-buffer` and
      // `Dictionary`/`NumericDictionary`/`SymbolDictionary` already state above).
      const template =
        representation.family === 'map'
          ? 'gea::Map'
          : representation.family === 'set'
            ? 'gea::Set'
            : representation.family === 'weak-map'
              ? 'gea::WeakMap'
              : 'gea::WeakSet'
      const key = cppTypeOf(representation.key)
      const arguments_ = representation.value === null ? key : `${key}, ${cppTypeOf(representation.value)}`
      return cppOwnershipWrap(ownership ?? representation.ownership, `${template}<${arguments_}>`)
    }
    case 'dictionary': {
      if (representation.recursive)
        return cppOwnershipWrap(ownership ?? representation.ownership, cppRecursiveContainerName(representation.recursive.type))
      // `key` names which runtime container this domain is stored in --
      // `gea::Dictionary` for strings, `gea::NumericDictionary` for numbers,
      // and `gea::SymbolDictionary` for symbol identity. A symbol description
      // is not an identity, so coercing one into a string table would conflate
      // keys the language keeps distinct.
      const container =
        representation.key === 'number'
          ? 'gea::NumericDictionary'
          : representation.key === 'symbol'
            ? 'gea::SymbolDictionary'
            : 'gea::Dictionary'
      return cppOwnershipWrap(ownership ?? representation.ownership, `${container}<${cppTypeOf(representation.value)}>`)
    }
    // The identity half every callable already carries -- `gea::CallableObject`
    // holds one of these beside its thunk -- so a callable converts into it by
    // reading a field rather than by fabricating anything. It has no calling
    // convention, which is the whole point: a call through it is refused.
    case 'callable-identity':
      return 'gea::Ref<gea::FunctionObjectIdentity>'
    case 'function-value-dispatch':
      // A signature that mentions itself has no finite expansion: the wrapper
      // name is the whole spelling, by value, exactly as the recursive
      // containers spell theirs through their own name.
      if (representation.recursive) return cppRecursiveContainerName(representation.recursive.type)
      return `gea::CallableObject<${cppAbiType(representation.abi)}>`
    case 'function':
    case 'function-family':
    case 'function-value-family':
      return `gea::CallableObject<${cppAbiType(representation.abi)}>`
    // The tag of a choice among generic source functions: an index into the
    // carrier's sorted `members`. See `generic-function-set` (model.ts).
    case 'generic-function-set':
      return 'std::uint8_t'
    case 'constructor-family':
    case 'constructor-value-dispatch':
      return `gea::ConstructorObject<${cppAbiType(representation.abi)}>`
    case 'function-and-constructor':
      return `gea::CallableConstructorObject<${cppAbiType(representation.call)}, ${cppAbiType(representation.construct)}>`
    case 'optional':
      return `gea::Optional<${cppTypeOf(representation.payload)}>`
    case 'tagged-union': {
      const spelling = `gea::TaggedUnion<${representation.arms.map(cppTaggedUnionArmType).join(', ')}>`
      if (!unionAliasing.active) return spelling
      const existing = unionAliasing.aliases.get(spelling)
      if (existing !== undefined) return existing
      const name = `gea_union_${unionAliasing.aliases.size}`
      unionAliasing.aliases.set(spelling, name)
      return name
    }
    case 'dynamic':
      // `gea::Value` (gea_runtime.h) is storage for a value whose type the
      // program never states: a tag and a type-erased holder, with copy, move
      // and destroy, and no dynamic operation whatsoever.
      //
      // Spelling it here says only that the carrier has a physical type, which
      // is what `manifest.ts`'s `isSpellable` asks -- it decides
      // `physicalTypes`/`verifierRecipes`/`emitterRecipes` by whether this
      // function throws. It says nothing about property access, calls or
      // arithmetic on a box: none of those are claimed anywhere in the
      // manifest, so a program that performs one is still refused by
      // preflight with the gap named. `ToBoolean` is now the one operation
      // that is claimed (`conversion:to-boolean:dynamic`, manifest.ts) --
      // holding a box and using one are still two different claims, and
      // `ToBoolean` is the only "using" claim made so far.
      return 'gea::Value'
  }
}

/**
 * The C++ carrier for a captured cell this backend shares by aliasing rather
 * than by copying (`emit-context.ts`'s `CaptureSlot.boxed`): a heap-allocated,
 * reference-counted box every frame that touches the declaration -- the frame
 * that owns it and every closure that captures it -- holds a copy of the same
 * pointer to, reading and writing through one dereference.
 *
 * `std::shared_ptr`, not a bespoke cell type: it is the same reference-counted
 * ownership `cppOwnershipWrap`'s `'shared-refcount'` arm already grants a
 * record, class instance, or array -- copying the pointer aliases the same
 * allocation, which is exactly the sharing a captured, mutated JavaScript
 * binding needs. This is a distinct spelling from that wrap on purpose: a
 * boxed cell's OWN representation can be a plain scalar (`aspectScale:
 * number`) that has no `ownership` field of its own to override, so this
 * wraps the whole physical type `cppTypeOf` already spells for it instead of
 * threading a second, representation-shaped ownership parameter through.
 */
/**
 * The integer a narrowed `number` is held in.
 *
 * 64 bits rather than 32: the values this narrowing admits are bounded by 2^53
 * or grow with a loop's trip count, and both overflow an `int`. A `long long`
 * holds every integer a double can hold exactly, so the narrowed and the
 * unnarrowed form agree everywhere the census says they do.
 */
export const cppNarrowedIntegerType = 'long long'

export const cppBoxedType = (representation: Representation): string => `gea::Ref<${cppTypeOf(representation)}>`
