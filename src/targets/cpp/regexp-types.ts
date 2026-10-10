// The three native layout names are a published fact of the regular-expression
// projection (`projection/regexp-fields.ts`), which identifies a carrier's role
// by them; this target spells the same table rather than a second copy.
export { cppRegExpNativeTypes } from '../../projection/regexp-fields.js'

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
