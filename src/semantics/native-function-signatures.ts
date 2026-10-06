import ts from 'typescript'
import type { DeclarationId } from '../identity/ids.js'
import type { NativeHostFunctionDeclaration } from '../plugins/model.js'
import { inspectNativeFunctionSignature, type InspectedNativeSignature, type NativeSignatureType } from '../native-signatures.js'
import type { IdentityTable } from './normalize/identities.js'
import { hasExactHostDeclaration } from './host-declaration-provenance.js'
import { declaredIntegerWidthOf } from './declared-integers.js'

export interface NativeFunctionSignatureCensus {
  readonly callbackParameters: ReadonlyMap<
    DeclarationId,
    ReadonlyMap<number, readonly ({ readonly kind: 'bounded'; readonly limit: number } | null)[]>
  >
  readonly assertions: readonly string[]
  readonly signatures: ReadonlyMap<DeclarationId, InspectedNativeSignature>
}

const acceptsNativeScalar = (checker: ts.TypeChecker, declared: ts.Type, native: NativeSignatureType): boolean => {
  const integerWidth = declaredIntegerWidthOf(declared)
  if (integerWidth !== null) {
    // A declared machine integer accepts only a native integer range that fits
    // its signed width. A float or wider unsigned value would change semantics.
    const bits = integerWidth === 'int64' ? 64 : 32
    return native.kind === 'integer' && native.bits - (native.signed ? 1 : 0) <= bits - 1
  }
  if (native.kind === 'integer' || native.kind === 'floating') return (declared.flags & ts.TypeFlags.Number) !== 0
  if (native.kind === 'boolean') return (declared.flags & ts.TypeFlags.Boolean) !== 0
  if (native.kind === 'void') return (declared.flags & ts.TypeFlags.Void) !== 0
  if (native.kind === 'callback') return checker.getSignaturesOfType(declared, ts.SignatureKind.Call).length > 0
  return true
}

export const censusNativeFunctionSignatures = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  identities: IdentityTable,
  configured: readonly NativeHostFunctionDeclaration[]
): NativeFunctionSignatureCensus => {
  const callbackParameters = new Map<
    DeclarationId,
    ReadonlyMap<number, readonly ({ readonly kind: 'bounded'; readonly limit: number } | null)[]>
  >()
  const signatures = new Map<DeclarationId, InspectedNativeSignature>()
  const assertions = new Set<string>()
  if (configured.length === 0) return { callbackParameters, assertions: [], signatures }
  const rows = new Map(configured.map((row) => [row.declarationName, row]))
  const visited = new Set<ts.Symbol>()
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const row = rows.get(node.text)
      let symbol = row === undefined ? undefined : checker.getSymbolAtLocation(node)
      if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol)
      if (row && symbol && !visited.has(symbol) && hasExactHostDeclaration(symbol, row)) {
        visited.add(symbol)
        const declared = checker.getSignaturesOfType(checker.getTypeOfSymbolAtLocation(symbol, node), ts.SignatureKind.Call)
        const signature = declared[0]
        if (declared.length !== 1 || signature === undefined)
          throw new Error(`Native signature requires one TypeScript overload: ${row.declarationName}`)
        const native = inspectNativeFunctionSignature({ ...row.inspection, expectedParameterCount: signature.parameters.length })
        const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
        if (declaration === undefined) throw new Error(`Native function has no authenticated declaration: ${row.declarationName}`)
        const id = identities.declarationIdOf(declaration)
        const callbacks = new Map<number, readonly ({ readonly kind: 'bounded'; readonly limit: number } | null)[]>()
        native.parameters.forEach((parameter, ordinal) => {
          const tsParameter = signature.parameters[ordinal]
          if (tsParameter === undefined) throw new Error(`Native parameter is missing in TypeScript: ${row.declarationName}`)
          const type = checker.getTypeOfSymbolAtLocation(tsParameter, declaration)
          if (!acceptsNativeScalar(checker, type, parameter))
            throw new Error(`Native parameter type mismatch: ${row.declarationName} parameter ${ordinal}`)
          if (parameter.kind !== 'callback') return
          const callbackSignatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call)
          const callback = callbackSignatures[0]
          if (callbackSignatures.length !== 1 || callback === undefined || callback.parameters.length !== parameter.parameters.length)
            throw new Error(`Native callback arity/overload mismatch: ${row.declarationName} parameter ${ordinal}`)
          if (!acceptsNativeScalar(checker, checker.getReturnTypeOfSignature(callback), parameter.result))
            throw new Error(`Native callback result mismatch: ${row.declarationName} parameter ${ordinal}`)
          callbacks.set(
            ordinal,
            parameter.parameters.map((argument, argumentOrdinal) => {
              const callbackParameter = callback.parameters[argumentOrdinal]
              if (
                callbackParameter === undefined ||
                !acceptsNativeScalar(checker, checker.getTypeOfSymbolAtLocation(callbackParameter, declaration), argument)
              )
                throw new Error(
                  `Native callback parameter mismatch: ${row.declarationName} callback ${ordinal} parameter ${argumentOrdinal}`
                )
              if (argument.kind !== 'integer' || !argument.exactlyRepresentableAsNumber) return null
              // The build may use a different C++ target than inspection. Its compiler
              // must confirm the inferred range before that range can narrow code.
              assertions.add(
                `static_assert(std::numeric_limits<${argument.cppType}>::digits == ${argument.bits - (argument.signed ? 1 : 0)} && std::numeric_limits<${argument.cppType}>::is_signed == ${argument.signed}, "Native callback integer type differs from inspected header");`
              )
              return { kind: 'bounded' as const, limit: Math.max(Math.abs(Number(argument.minimum)), Math.abs(Number(argument.maximum))) }
            })
          )
        })
        if (!acceptsNativeScalar(checker, checker.getReturnTypeOfSignature(signature), native.result))
          throw new Error(`Native result type mismatch: ${row.declarationName}`)
        if ([...callbacks.values()].some((parameters) => parameters.some((parameter) => parameter !== null))) {
          if (native.canonicalFunctionType === null)
            throw new Error(`Native callback signature cannot be authenticated against the target: ${row.declarationName}`)
          // Header macros and target configuration can change aliases without
          // changing the inspected builtin's width. Verify the actual binding.
          assertions.add(
            `static_assert(std::is_same_v<decltype(&${native.cppFunction}), ${native.canonicalFunctionType}>, "Native function signature differs from inspected header");`
          )
        }
        callbackParameters.set(id, callbacks)
        signatures.set(id, native)
      }
    }
    ts.forEachChild(node, visit)
  }
  for (const file of files) if (!file.isDeclarationFile) visit(file)
  return { callbackParameters, assertions: [...assertions], signatures }
}
