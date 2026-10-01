import ts from 'typescript'
import { isUnusableEvidence } from './derived-expression-type.js'

/**
 * Whether an object-pattern element's key reads `undefined` because its
 * holder's closed object type declares no member for it -- ECMA-262
 * `KeyedBindingInitialization` reads through `GetV` and finds nothing, so
 * `const { fn = function () {} } = {}` binds the default.
 *
 * Only where the checker bound the name `any` (it does in a JavaScript file;
 * TypeScript reports an error instead). A name the checker resolved is a
 * member it found through the holder's declaration even when the holder's
 * type omits it: a CommonJS module's `module.exports.x = ...` export after
 * `module.exports = codes` is absent from the `require` call's own type and
 * present on the module symbol the name resolves through.
 *
 * Only a single object type with no member of that name and no index
 * signature of either kind answers; a union, a primitive, or an open
 * dictionary keeps the ordinary member read. `getPropertyOfType` sees the
 * apparent members too, so a `{ toString }` pattern over `{}` still reads
 * `Object.prototype`'s.
 */
export const readsAbsentKey = (checker: ts.TypeChecker, holder: ts.Type, key: string, element: ts.BindingElement): boolean => {
  if (element.dotDotDotToken) return false
  if ((checker.getTypeAtLocation(element.name).flags & ts.TypeFlags.Any) === 0) return false
  const nonNull = checker.getNonNullableType(holder)
  if (isUnusableEvidence(nonNull) || (nonNull.flags & ts.TypeFlags.Object) === 0) return false
  // A type stated only by declaration files describes an object the program
  // did not build -- a host's, which may carry members its declaration omits
  // (V8's `Error.stackTraceLimit`, which secure-json-parse destructures) -- so
  // the declaration's silence is not the object's.
  const declarations = nonNull.getSymbol()?.declarations ?? []
  if (declarations.length > 0 && declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile)) return false
  // Nor is a module's namespace type (`typeof import('./package.json')`, which
  // thread-stream destructures its `version` out of): the object a JSON or
  // `export =` module hands out is not the namespace the checker types.
  if (declarations.some(ts.isSourceFile)) return false
  return (
    !checker.getPropertyOfType(nonNull, key) &&
    !checker.getIndexTypeOfType(nonNull, ts.IndexKind.String) &&
    !checker.getIndexTypeOfType(nonNull, ts.IndexKind.Number)
  )
}
