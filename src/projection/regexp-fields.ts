import type { Representation } from '../representation/model.js'
import type { RegExpDeclarationKind } from '../representation/policies.js'

/**
 * The C++ target's spelling for each of the three standard regular-expression
 * shapes, and the only place those three C++ names appear outside the runtime
 * header itself.
 *
 * The carrier is selected in `representation/derive.ts` from a policy, and that
 * policy carries the spelling rather than the deriver naming one, because
 * nothing under `src/representation/` may name a C++ type -- it selects
 * carriers for any backend. `compiler.ts` composes the two: the frontend says
 * WHICH declaration is `RegExp`, this table says what the C++ target calls it.
 *
 * All three are ported from v1 geatsc's `targets/cpp/runtime/regex.h`:
 *
 * - `Pattern` is v1's `gea::runtime::regex::Pattern`, name for name.
 * - `ExecResult` is v1's `ExecResult` (regex.h line 32) -- the TYPED result,
 *   deliberately not v1's `gea_cpp_value exec(...)`, which is the boxed one.
 * - `MatchResult` has no v1 counterpart and is stated as new work in the
 *   report: v1's `match` answers `std::vector<std::string>` with no null case
 *   and no `index`/`input`, so there was nothing typed to port. It implements
 *   ES2024 22.1.3.14 `String.prototype.match`, whose two answers
 *   (`RegExpExec` for a non-global pattern, the list of matched substrings for
 *   a global one) are exactly why `lib.es5.d.ts` declares `RegExpMatchArray`'s
 *   `index` and `input` OPTIONAL where `RegExpExecArray`'s are required.
 */
export const cppRegExpNativeTypes: Readonly<Record<RegExpDeclarationKind, string>> = {
  pattern: 'gea::runtime::regex::Pattern',
  'exec-result': 'gea::runtime::regex::ExecResult',
  'match-result': 'gea::runtime::regex::MatchResult'
}

/** The compiler-owned regular-expression layout selected by the backend policy. */
export const regexpRoleOf = (representation: Representation): RegExpDeclarationKind | null => {
  if (representation.kind !== 'native-record-ref' || representation.native === null) return null
  if (representation.native === cppRegExpNativeTypes.pattern) return 'pattern'
  if (representation.native === cppRegExpNativeTypes['exec-result']) return 'exec-result'
  if (representation.native === cppRegExpNativeTypes['match-result']) return 'match-result'
  return null
}

const number: Representation = { kind: 'scalar', domain: 'number' }
const string: Representation = { kind: 'string' }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
export const regexpPatternMethodKeys: ReadonlySet<string> = new Set(['test', 'exec', 'toString'])
const optional = (payload: Representation): Representation => ({ kind: 'optional', payload, absence: 'undefined' })
const booleanPatternFields: ReadonlySet<string> = new Set([
  'global',
  'ignoreCase',
  'multiline',
  'sticky',
  'unicode',
  'dotAll',
  'hasIndices'
])

/** Native fields have no generated record layout; this is their physical contract. */
export const regexpDataMemberStorage = (role: RegExpDeclarationKind, key: string): Representation | null => {
  if (role === 'pattern') {
    if (key === 'source' || key === 'flags') return string
    if (key === 'lastIndex') return dynamic
    return booleanPatternFields.has(key) ? { kind: 'scalar', domain: 'boolean' } : null
  }
  if (key === 'groups') return optional({ kind: 'dictionary', key: 'string', value: string, ownership: 'shared-refcount' })
  if (key === 'length') return number
  if (key === 'index') return role === 'match-result' ? optional(number) : number
  if (key === 'input') return role === 'match-result' ? optional(string) : string
  return null
}

export const regexpFieldStorageOf = (receiver: Representation, key: string): Representation | null => {
  const role = regexpRoleOf(receiver)
  return role === null ? null : regexpDataMemberStorage(role, key)
}

/** Pattern owns the exact property value; its runtime decides writability before matching consumes it. */
export const regexpDynamicSetValueOf = (receiver: Representation, key: string | null): Representation | null =>
  regexpRoleOf(receiver) === 'pattern' && (key === null || (!regexpPatternMethodKeys.has(key) && key !== 'compile')) ? dynamic : null
