import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

export interface NativeFunctionInspection {
  cppFunction: string
  headers: readonly string[]
  includeDirectories?: readonly string[]
  compiler?: string
  compilerArguments?: readonly string[]
  workingDirectory?: string
  expectedParameterCount?: number
  expectedCallbacks?: readonly { parameter: number; arguments: number }[]
}

export type NativeSignatureType =
  | {
      kind: 'integer'
      cppType: string
      bits: number
      signed: boolean
      minimum: string
      maximum: string
      exactlyRepresentableAsNumber: boolean
    }
  | { kind: 'floating' | 'boolean' | 'void' | 'unsupported'; cppType: string }
  | { kind: 'callback'; cppType: string; result: NativeSignatureType; parameters: readonly NativeSignatureType[] }

export interface InspectedNativeSignature {
  cppFunction: string
  canonicalFunctionType: string | null
  result: NativeSignatureType
  parameters: readonly NativeSignatureType[]
  evidence: {
    compiler: string
    arguments: readonly string[]
    headers: readonly string[]
    probeSha256: string
    astSha256: string
  }
}

interface ClangNode {
  kind?: string
  name?: string
  templateName?: string
  variadic?: boolean
  exceptionSpec?: string
  cc?: string
  qualifiers?: string
  value?: string
  type?: { qualType?: string }
  inner?: ClangNode[]
}

const integerTypes = [
  'char',
  'signed char',
  'unsigned char',
  'short',
  'unsigned short',
  'int',
  'unsigned int',
  'long',
  'unsigned long',
  'long long',
  'unsigned long long',
  'wchar_t',
  'char16_t',
  'char32_t'
] as const

const wrappers = new Set([
  'DecltypeType',
  'ElaboratedType',
  'TypedefType',
  'ParenType',
  'AttributedType',
  'AdjustedType',
  'DecayedType',
  'SubstTemplateTypeParmType',
  'AutoType'
])

/**
 * Which class-template specializations in the signature ARE `std::function`,
 * as Clang itself decided it.
 *
 * Neither spelling Clang dumps is an identity: a `templateName` is written as
 * the source wrote it (Clang 21 qualifies it, Clang 18 does not), a RecordType's
 * `qualType` is a printing policy that hides inline namespaces, and the
 * filtered dump omits the declaration the RecordType's `decl` id names. So each
 * candidate is located by its structural PATH from the probed function type,
 * and a second probe asks Clang whether the canonical type at that path is a
 * specialization of the one `std::function` template -- a partial
 * specialization match, which is decided on declarations, not on text.
 */
type StdFunctionIdentity = ReadonlyMap<ClangNode, boolean>

// Path steps, mirrored by `GeaAt` in the identity probe: an indirection to its
// pointee, a std::function to its signature, a cv-qualified type to its
// unqualified type, or a function to its result (0) or one of its parameters
// (1 + index).
const indirectionStep = -1
const stdFunctionStep = -2
const qualifierStep = -3

// Only a class-template specialization has a canonical record to identify; an
// alias template's specialization is its aliased type, not a record.
const isClassSpecialization = (node: ClangNode): boolean =>
  node.kind === 'TemplateSpecializationType' && (node.inner ?? []).some((child) => child.kind === 'RecordType')

function stdFunctionCandidates(node: ClangNode, path: readonly number[], out: Map<ClangNode, readonly number[]>): void {
  node = unwrap(node)
  if (node.kind === 'PointerType' || node.kind === 'LValueReferenceType' || node.kind === 'RValueReferenceType') {
    const children = typeChildren(node)
    if (children.length === 1) stdFunctionCandidates(children[0]!, [...path, indirectionStep], out)
    return
  }
  if (node.kind === 'QualType') {
    const children = typeChildren(node)
    if (children.length === 1) stdFunctionCandidates(children[0]!, [...path, qualifierStep], out)
    return
  }
  if (node.kind === 'FunctionProtoType') {
    if (node.variadic) return
    for (const [index, child] of typeChildren(node).entries()) stdFunctionCandidates(child, [...path, index], out)
    return
  }
  if (!isClassSpecialization(node)) return
  out.set(node, path)
  const arguments_ = (node.inner ?? []).filter((child) => child.kind === 'TemplateArgument')
  const children = arguments_.length === 1 ? typeChildren(arguments_[0]!) : []
  if (children.length === 1) stdFunctionCandidates(children[0]!, [...path, stdFunctionStep], out)
}

// A path that does not match the type it walks names no specialization of
// `GeaAt` and fails to compile, rather than answering for some other node.
const identityProbeTemplates = `template <class T, int... P> struct GeaAt;
template <class T> struct GeaAt<T> { using type = T; };
template <class T, int... P> struct GeaAt<T *, ${indirectionStep}, P...> : GeaAt<T, P...> {};
template <class T, int... P> struct GeaAt<T &, ${indirectionStep}, P...> : GeaAt<T, P...> {};
template <class T, int... P> struct GeaAt<T &&, ${indirectionStep}, P...> : GeaAt<T, P...> {};
template <class T, int... P> struct GeaAt<T, ${qualifierStep}, P...> : GeaAt<std::remove_cv_t<T>, P...> {};
template <class T, int... P> struct GeaAt<T, ${stdFunctionStep}, P...> { using type = void; };
template <class S, int... P> struct GeaAt<std::function<S>, ${stdFunctionStep}, P...> : GeaAt<S, P...> {};
template <class R, class... A, int N, int... P> struct GeaAt<R(A...), N, P...>
    : GeaAt<std::tuple_element_t<static_cast<std::size_t>(N), std::tuple<R, A...>>, P...> {};
template <class R, class... A, int N, int... P> struct GeaAt<R(A...) noexcept, N, P...>
    : GeaAt<std::tuple_element_t<static_cast<std::size_t>(N), std::tuple<R, A...>>, P...> {};
template <class T> struct GeaIsStdFunction { enum { value = 0 }; };
template <class S> struct GeaIsStdFunction<std::function<S>> { enum { value = 1 }; };
`

function isStdFunction(node: ClangNode, identity: StdFunctionIdentity): boolean {
  if (!isClassSpecialization(node)) return false
  const verdict = identity.get(node)
  if (verdict === undefined) throw new Error('Clang native template specialization has no authenticated identity')
  return verdict
}

function typeChildren(node: ClangNode): ClangNode[] {
  return (node.inner ?? []).filter((child) => child.kind?.endsWith('Type'))
}

function unwrap(node: ClangNode): ClangNode {
  while (node.kind && wrappers.has(node.kind)) {
    const children = typeChildren(node)
    if (children.length !== 1) throw new Error(`Clang native type has ambiguous ${node.kind} children`)
    node = children[0]!
  }
  return node
}

function constant(node: ClangNode, name: string): number | null {
  if (node.kind === 'EnumConstantDecl' && node.name === name) {
    const findExpression = (candidate: ClangNode): ClangNode | null => {
      if (candidate.kind === 'ConstantExpr') return candidate
      for (const child of candidate.inner ?? []) {
        const found = findExpression(child)
        if (found) return found
      }
      return null
    }
    const expression = findExpression(node)
    const value = expression?.value === 'true' ? 1 : expression?.value === 'false' ? 0 : Number(expression?.value)
    if (!Number.isInteger(value)) throw new Error(`Clang did not evaluate native width probe ${name}`)
    return value
  }
  for (const child of node.inner ?? []) {
    const value = constant(child, name)
    if (value !== null) return value
  }
  return null
}

function inspectType(node: ClangNode, ast: ClangNode, identity: StdFunctionIdentity): NativeSignatureType {
  node = unwrap(node)
  const cppType = node.type?.qualType ?? '<unknown>'
  if (node.kind === 'PointerType' || node.kind === 'LValueReferenceType' || node.kind === 'RValueReferenceType') {
    const children = typeChildren(node)
    if (children.length !== 1) throw new Error('Clang native indirection has ambiguous type nodes')
    const pointee = unwrap(children[0]!)
    // A callable object pointer and a pointer to a function pointer are data
    // indirections, not callable values that a TypeScript function can bind to.
    if (node.kind === 'PointerType' && pointee.kind !== 'FunctionProtoType') return { kind: 'unsupported', cppType }
    const type = inspectType(pointee, ast, identity)
    return type.kind === 'callback' ? { ...type, cppType } : { kind: 'unsupported', cppType }
  }
  if (node.kind === 'BuiltinType') {
    if (cppType === 'void' || cppType === 'bool') return { kind: cppType === 'void' ? 'void' : 'boolean', cppType }
    if (['float', 'double', 'long double', '_Float16', '__float128'].includes(cppType)) return { kind: 'floating', cppType }
    const index = integerTypes.findIndex((type) => type === cppType)
    if (index >= 0) {
      const bits = constant(ast, `Width${index}`)
      const signed = constant(ast, `Signed${index}`)
      if (bits === null || bits < 1 || bits > 128 || (signed !== 0 && signed !== 1)) {
        throw new Error(`Clang did not authenticate integer bounds for ${cppType}`)
      }
      const magnitude = 1n << BigInt(bits - signed)
      return {
        kind: 'integer',
        cppType,
        bits,
        signed: signed === 1,
        minimum: signed ? String(-magnitude) : '0',
        maximum: String(magnitude - 1n),
        exactlyRepresentableAsNumber: magnitude <= 1n << 53n
      }
    }
  }
  if (node.kind === 'FunctionProtoType') {
    if (node.variadic) throw new Error('Clang native variadic signature is not an authenticated fixed binding')
    const children = typeChildren(node)
    if (!children.length) throw new Error('Clang native callback has no return type')
    return {
      kind: 'callback',
      cppType,
      result: inspectType(children[0]!, ast, identity),
      parameters: children.slice(1).map((child) => inspectType(child, ast, identity))
    }
  }
  if (isStdFunction(node, identity)) {
    const arguments_ = (node.inner ?? []).filter((child) => child.kind === 'TemplateArgument')
    if (arguments_.length !== 1) throw new Error('Clang std::function has ambiguous template arguments')
    const children = typeChildren(arguments_[0]!)
    if (children.length !== 1) throw new Error('Clang std::function callback signature is absent')
    const signature = inspectType(children[0]!, ast, identity)
    if (signature.kind !== 'callback') throw new Error('Clang std::function template argument is not a function')
    return { ...signature, cppType }
  }
  return { kind: 'unsupported', cppType }
}

function canonicalType(node: ClangNode, identity: StdFunctionIdentity): string | null {
  node = unwrap(node)
  if (node.kind === 'BuiltinType') return node.type?.qualType ?? null
  if (node.kind === 'FunctionProtoType') {
    if (node.variadic || (node.cc !== undefined && node.cc !== 'cdecl')) return null
    if (node.exceptionSpec !== undefined && node.exceptionSpec !== 'noexcept') return null
    const children = typeChildren(node).map((child) => canonicalType(child, identity))
    if (!children.length || children.some((child) => child === null)) return null
    return `${children[0]}(${children.slice(1).join(', ')})${node.exceptionSpec === 'noexcept' ? ' noexcept' : ''}`
  }
  if (isStdFunction(node, identity)) {
    const arguments_ = (node.inner ?? []).filter((child) => child.kind === 'TemplateArgument')
    if (arguments_.length !== 1) return null
    const children = typeChildren(arguments_[0]!)
    const argument = children.length === 1 ? canonicalType(children[0]!, identity) : null
    return argument === null ? null : `std::function<${argument}>`
  }
  const indirections: Readonly<Record<string, string>> = {
    PointerType: 'add_pointer_t',
    LValueReferenceType: 'add_lvalue_reference_t',
    RValueReferenceType: 'add_rvalue_reference_t'
  }
  const indirection = indirections[node.kind ?? '']
  if (indirection !== undefined) {
    const children = typeChildren(node)
    const child = children.length === 1 ? canonicalType(children[0]!, identity) : null
    return child === null ? null : `std::${indirection}<${child}>`
  }
  if (node.kind === 'QualType') {
    const children = typeChildren(node)
    let child = children.length === 1 ? canonicalType(children[0]!, identity) : null
    if (child === null) return null
    for (const qualifier of node.qualifiers?.split(' ') ?? []) {
      if (qualifier !== 'const' && qualifier !== 'volatile') return null
      child = `std::add_${qualifier}_t<${child}>`
    }
    return child
  }
  return null
}

/** The second probe: Clang's own verdict on every candidate specialization, by path. */
function stdFunctionIdentityOf(
  input: NativeFunctionInspection,
  args: readonly string[],
  compiler: string,
  signature: ClangNode
): { readonly verdicts: StdFunctionIdentity; readonly probe: string; readonly ast: string } {
  const candidates = new Map<ClangNode, readonly number[]>()
  stdFunctionCandidates(signature, [], candidates)
  if (candidates.size === 0) return { verdicts: new Map(), probe: '', ast: '' }
  const marks = [...candidates.values()].map(
    (path, index) => `Identity${index} = GeaIsStdFunction<typename GeaAt<Function${path.map((step) => `, ${step}`).join('')}>::type>::value`
  )
  const identityProbe = `${input.headers.map((header) => `#include "${header}"`).join('\n')}
#include <cstddef>
#include <functional>
#include <tuple>
#include <type_traits>
namespace GeaNativeSignatureProbe {
using Function = decltype(&${input.cppFunction});
${identityProbeTemplates}enum Identities { ${marks.join(',\n')} };
}
`
  const inspected = spawnSync(compiler, args, {
    input: identityProbe,
    encoding: 'utf8',
    ...(input.workingDirectory ? { cwd: input.workingDirectory } : {}),
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024
  })
  if (inspected.error || inspected.status !== 0) {
    throw new Error(
      `Clang native template identity inspection failed for ${input.cppFunction}: ${inspected.error?.message ?? inspected.stderr}`
    )
  }
  let ast: ClangNode
  try {
    ast = JSON.parse(inspected.stdout) as ClangNode
  } catch {
    throw new Error('Clang native template identity inspection did not return one authenticated AST namespace')
  }
  const verdicts = new Map<ClangNode, boolean>()
  for (const [index, node] of [...candidates.keys()].entries()) {
    const value = constant(ast, `Identity${index}`)
    if (value !== 0 && value !== 1) throw new Error('Clang did not authenticate a native template identity')
    verdicts.set(node, value === 1)
  }
  return { verdicts, probe: identityProbe, ast: inspected.stdout }
}

/** Native facts come from Clang's resolved type graph; callers authenticate their declaration-to-host binding separately. */
export function inspectNativeFunctionSignature(input: NativeFunctionInspection): InspectedNativeSignature {
  if (!/^(?:::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/.test(input.cppFunction))
    throw new Error('Native function must be a qualified C++ identifier')
  if (!input.headers.length || input.headers.some((header) => /[\r\n"\\]/.test(header)))
    throw new Error('Native inspection needs valid header include spellings')
  const widths = integerTypes.flatMap((type, index) => [
    `Width${index} = sizeof(${type}) * __CHAR_BIT__`,
    `Signed${index} = static_cast<${type}>(-1) < static_cast<${type}>(0)`
  ])
  const probe = `${input.headers.map((header) => `#include "${header}"`).join('\n')}
namespace GeaNativeSignatureProbe {
using Function = decltype(&${input.cppFunction});
enum Bounds { ${widths.join(',\n')} };
}
`
  const compiler = input.compiler ?? 'clang++'
  const args = [
    '-std=c++17',
    ...(input.compilerArguments ?? []),
    ...(input.includeDirectories ?? []).flatMap((directory) => ['-I', directory]),
    '-x',
    'c++',
    '-fsyntax-only',
    '-Xclang',
    '-ast-dump=json',
    '-Xclang',
    '-ast-dump-filter=GeaNativeSignatureProbe',
    '-'
  ]
  const inspected = spawnSync(compiler, args, {
    input: probe,
    encoding: 'utf8',
    ...(input.workingDirectory ? { cwd: input.workingDirectory } : {}),
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024
  })
  if (inspected.error || inspected.status !== 0) {
    throw new Error(`Clang native signature inspection failed for ${input.cppFunction}: ${inspected.error?.message ?? inspected.stderr}`)
  }
  let ast: ClangNode
  try {
    ast = JSON.parse(inspected.stdout) as ClangNode
  } catch {
    throw new Error('Clang native signature inspection did not return one authenticated AST namespace')
  }
  if (ast.kind !== 'NamespaceDecl' || ast.name !== 'GeaNativeSignatureProbe')
    throw new Error('Clang native signature probe namespace is absent')
  const aliases = (ast.inner ?? []).filter((node) => node.kind === 'TypeAliasDecl' && node.name === 'Function')
  if (aliases.length !== 1) throw new Error('Clang native function signature is absent or ambiguous')
  const types = typeChildren(aliases[0]!)
  if (types.length !== 1) throw new Error('Clang native function alias has ambiguous type nodes')
  const identity = stdFunctionIdentityOf(input, args, compiler, types[0]!)
  const signature = inspectType(types[0]!, ast, identity.verdicts)
  if (signature.kind !== 'callback') throw new Error('Clang native binding is not a function')
  if (input.expectedParameterCount !== undefined && signature.parameters.length !== input.expectedParameterCount) {
    throw new Error('Native function parameter count does not match its declared binding')
  }
  for (const expected of input.expectedCallbacks ?? []) {
    const callback = signature.parameters[expected.parameter]
    if (callback?.kind !== 'callback' || callback.parameters.length !== expected.arguments) {
      throw new Error('Native callback parameter count does not match its declared binding')
    }
  }
  return {
    cppFunction: input.cppFunction,
    canonicalFunctionType: canonicalType(types[0]!, identity.verdicts),
    result: signature.result,
    parameters: signature.parameters,
    evidence: {
      compiler,
      arguments: args,
      headers: [...input.headers],
      probeSha256: createHash('sha256').update(probe).update(identity.probe).digest('hex'),
      astSha256: createHash('sha256').update(inspected.stdout).update(identity.ast).digest('hex')
    }
  }
}
