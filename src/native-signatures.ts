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

function inspectType(node: ClangNode, ast: ClangNode): NativeSignatureType {
  node = unwrap(node)
  const cppType = node.type?.qualType ?? '<unknown>'
  if (node.kind === 'PointerType' || node.kind === 'LValueReferenceType' || node.kind === 'RValueReferenceType') {
    const children = typeChildren(node)
    if (children.length !== 1) throw new Error('Clang native indirection has ambiguous type nodes')
    const pointee = unwrap(children[0]!)
    // A callable object pointer and a pointer to a function pointer are data
    // indirections, not callable values that a TypeScript function can bind to.
    if (node.kind === 'PointerType' && pointee.kind !== 'FunctionProtoType') return { kind: 'unsupported', cppType }
    const type = inspectType(pointee, ast)
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
      result: inspectType(children[0]!, ast),
      parameters: children.slice(1).map((child) => inspectType(child, ast))
    }
  }
  if (node.kind === 'TemplateSpecializationType' && node.templateName === 'std::function') {
    const arguments_ = (node.inner ?? []).filter((child) => child.kind === 'TemplateArgument')
    if (arguments_.length !== 1) throw new Error('Clang std::function has ambiguous template arguments')
    const children = typeChildren(arguments_[0]!)
    if (children.length !== 1) throw new Error('Clang std::function callback signature is absent')
    const signature = inspectType(children[0]!, ast)
    if (signature.kind !== 'callback') throw new Error('Clang std::function template argument is not a function')
    return { ...signature, cppType }
  }
  return { kind: 'unsupported', cppType }
}

function canonicalType(node: ClangNode): string | null {
  node = unwrap(node)
  if (node.kind === 'BuiltinType') return node.type?.qualType ?? null
  if (node.kind === 'FunctionProtoType') {
    if (node.variadic || (node.cc !== undefined && node.cc !== 'cdecl')) return null
    if (node.exceptionSpec !== undefined && node.exceptionSpec !== 'noexcept') return null
    const children = typeChildren(node).map(canonicalType)
    if (!children.length || children.some((child) => child === null)) return null
    return `${children[0]}(${children.slice(1).join(', ')})${node.exceptionSpec === 'noexcept' ? ' noexcept' : ''}`
  }
  if (node.kind === 'TemplateSpecializationType' && node.templateName === 'std::function') {
    const arguments_ = (node.inner ?? []).filter((child) => child.kind === 'TemplateArgument')
    if (arguments_.length !== 1) return null
    const children = typeChildren(arguments_[0]!)
    const argument = children.length === 1 ? canonicalType(children[0]!) : null
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
    const child = children.length === 1 ? canonicalType(children[0]!) : null
    return child === null ? null : `std::${indirection}<${child}>`
  }
  if (node.kind === 'QualType') {
    const children = typeChildren(node)
    let child = children.length === 1 ? canonicalType(children[0]!) : null
    if (child === null) return null
    for (const qualifier of node.qualifiers?.split(' ') ?? []) {
      if (qualifier !== 'const' && qualifier !== 'volatile') return null
      child = `std::add_${qualifier}_t<${child}>`
    }
    return child
  }
  return null
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
  const signature = inspectType(types[0]!, ast)
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
    canonicalFunctionType: canonicalType(types[0]!),
    result: signature.result,
    parameters: signature.parameters,
    evidence: {
      compiler,
      arguments: args,
      headers: [...input.headers],
      probeSha256: createHash('sha256').update(probe).digest('hex'),
      astSha256: createHash('sha256').update(inspected.stdout).digest('hex')
    }
  }
}
