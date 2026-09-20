import type { RegExpDeclarationKind } from '../../representation/policies.js'

/**
 * This backend's spelling for each of the three standard regular-expression
 * shapes, and the only place those three C++ names appear outside the runtime
 * header itself.
 *
 * The carrier is selected in `representation/derive.ts` from a policy, and that
 * policy carries the spelling rather than the deriver naming one, because
 * nothing under `src/representation/` may name a C++ type -- it selects
 * carriers for any backend. `compiler.ts` composes the two: the frontend says
 * WHICH declaration is `RegExp`, this table says what this target calls it.
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

/**
 * This backend's entry point for `RegExpAlloc` + `RegExpInitialize` (ECMA-262
 * 22.2.3.1 and 22.2.3.2), which is where 22.2.4.1's three pattern branches all
 * converge. It is `constructPatternOrThrow` rather than a bare
 * `gea::makeRef<Pattern>` so 22.2.3.2's flag and source validation runs and an
 * unknown or repeated flag throws where the language says it throws.
 *
 * A constant for the same reason the three type names above are: two emitters
 * spell this call -- `emit-callable.ts` for the string and Pattern forms and
 * `emit-prototype-regexp.ts` for the object form -- and a name typed twice is
 * a name that can be renamed once.
 */
export const cppConstructPatternEntry = 'gea::runtime::regex::constructPatternOrThrow'

/**
 * This backend's spelling for the ECMAScript String WRAPPER OBJECT (ECMA-262
 * 22.1.5, `new String(x)`), kept in this file rather than a file of its own:
 * it is the identical kind of fact `cppRegExpNativeTypes` above states --
 * "what this target calls a compiler-owned native layout for a
 * core-ECMAScript type, selected by a declaration policy that may not name a
 * C++ type itself" -- for a second such type, not a different concept. Same
 * composition point too: `compiler.ts` joins `frontend.stringObjectDeclaration`
 * (WHICH declaration is `String`) with this constant (what this target calls
 * it), exactly as it joins `frontend.regexpDeclarations` with the table above.
 *
 * `gea::runtime::StringObject` is defined in `runtime/gea_runtime.h`,
 * immediately after `Date` -- same reasoning, same shape: a compiler-owned
 * native layout for a core-ECMAScript type, not a struct `targets/cpp/records.ts`
 * lays out.
 */
export const cppStringObjectNativeType = 'gea::runtime::StringObject'
