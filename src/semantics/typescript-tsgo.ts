import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type TypeScript from 'typescript'

/**
 * EXPERIMENT (`GEA_TS_BACKEND=tsgo`): TypeScript's own parser and program
 * graph, with typescript-go's checker behind them.
 *
 * `createProgram` still builds the program with TypeScript -- module
 * resolution, the source transforms and every file's final text stay exactly
 * as they are -- and then opens the same texts in typescript-go (loaded
 * in-process through `tscapi.dll`). The program's `getTypeChecker` answers
 * from typescript-go: its types, symbols and signatures are facades over
 * typescript-go handles, and every node it names is mapped back to
 * TypeScript's node at the same file, kind and span, so the rest of the
 * compiler keeps walking the AST it always has.
 *
 * Configuration: `GEA_TSGO_DLL` (the bridge), `GEA_TSGO_KOFFI` (the FFI
 * module), `GEA_TSGO_FLAGS` (typescript-go's flag bit table).
 */
type Ts = typeof TypeScript
interface Handle {
  readonly n?: number
  readonly t?: number
  readonly s?: number
  readonly g?: number
  readonly o?: number
  readonly c?: string
}
interface KoffiLibrary {
  func(signature: string): (...args: unknown[]) => unknown
}
interface Koffi {
  load(path: string): KoffiLibrary
  decode(pointer: unknown, type: string, length: number): string
}
interface OpenedFile {
  readonly name: string
  readonly declaration: boolean
  readonly node: number
}
type FlagTable = Record<string, Record<string, number>>

const isHandle = (value: unknown): value is Handle =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && ('n' in value || 't' in value || 's' in value || 'g' in value || 'o' in value)

const pascal = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1)

const normalizedPath = (file: string): string => file.replace(/\\/g, '/').toLowerCase()

export const tsgoTypeScript = (real: Ts): Ts => {
  const require = createRequire(import.meta.url)
  const koffi = require(process.env['GEA_TSGO_KOFFI'] ?? 'koffi') as Koffi
  const library = koffi.load(process.env['GEA_TSGO_DLL'] ?? 'tscapi.dll')
  const nativeCall = library.func('void* tsc_call(const char*)')
  const nativeFree = library.func('void tsc_free(void*)')
  const stats = { calls: 0 }
  const rpc = <T>(request: Record<string, unknown>): T => {
    stats.calls++
    const pointer = nativeCall(JSON.stringify(request))
    const text = koffi.decode(pointer, 'char', -1)
    nativeFree(pointer)
    const value = JSON.parse(text) as T
    if (typeof value === "object" && value !== null && "error" in value) throw new Error(`tsgo ${String(request["method"] ?? request["field"] ?? request["op"])}: ${String((value as { error: unknown }).error)}`)
    return value
  }

  // ---- flags: typescript-go bit -> TypeScript value, by name ----
  const flagTable = JSON.parse(readFileSync(process.env['GEA_TSGO_FLAGS'] ?? 'corsa-flags.json', 'utf8')) as FlagTable
  const flagMaps = new Map<string, { toStrada: Map<number, number>; toCorsa: Map<number, number> }>()
  for (const [enumName, bits] of Object.entries(flagTable)) {
    const stradaEnum = (real as unknown as Record<string, Record<string, number>>)[enumName]
    const toStrada = new Map<number, number>()
    const toCorsa = new Map<number, number>()
    if (stradaEnum)
      for (const [name, bit] of Object.entries(bits)) {
        const value = stradaEnum[name]
        if (typeof value !== 'number') continue
        toStrada.set(bit, value)
        // Only single-bit TypeScript values reverse cleanly.
        if (value > 0 && (value & (value - 1)) === 0) toCorsa.set(Math.log2(value), 2 ** bit)
      }
    flagMaps.set(enumName, { toStrada, toCorsa })
  }
  const translate = (enumName: string, value: number, direction: 'toStrada' | 'toCorsa'): number => {
    const map = flagMaps.get(enumName)?.[direction]
    if (!map) return value
    let out = 0
    for (let bit = 0; bit < 53 && value >= 2 ** bit; bit++) {
      if (Math.floor(value / 2 ** bit) % 2 === 0) continue
      const mapped = map.get(bit)
      if (mapped !== undefined) out += mapped
    }
    return out
  }
  const stradaFlags = (enumName: string, value: number): number => translate(enumName, value, 'toStrada')
  const corsaFlags = (enumName: string, value: number): number => translate(enumName, value, 'toCorsa')

  // ---- kinds ----
  const corsaKindNames = rpc<string[]>({ op: 'kinds' })
  const stradaKindOf = corsaKindNames.map((name) => (real.SyntaxKind as unknown as Record<string, number>)[name] ?? -1)

  // ---- per-program session state ----
  let files: OpenedFile[] = []
  let stradaFiles: (TypeScript.SourceFile | undefined)[] = []
  let fileOfStrada = new WeakMap<TypeScript.SourceFile, number>()
  let mapped: boolean[] = []
  let nodeOfId = new Map<number, TypeScript.Node>()
  let idOfNode = new WeakMap<TypeScript.Node, number>()
  let typeOfId = new Map<number, TsgoType>()
  let symbolOfId = new Map<number, TsgoSymbol>()
  let signatureOfId = new Map<number, TsgoSignature>()
  let objectOfId = new Map<number, unknown>()
  let generation = 0

  const mapFile = (index: number): void => {
    if (mapped[index]) return
    mapped[index] = true
    const source = stradaFiles[index]
    if (!source) return
    const byKey = new Map<string, TypeScript.Node[]>()
    const add = (node: TypeScript.Node): void => {
      const key = `${node.kind}:${node.pos}:${node.end}`
      const list = byKey.get(key)
      if (list) list.push(node)
      else byKey.set(key, [node])
    }
    const visit = (node: TypeScript.Node): void => {
      add(node)
      real.forEachChild(node, visit, (list) => {
        for (const child of list) visit(child)
      })
    }
    add(source)
    real.forEachChild(source, visit, (list) => {
      for (const child of list) visit(child)
    })
    const flat = rpc<number[]>({ op: 'fileNodes', file: index })
    for (let at = 0; at < flat.length; at += 4) {
      const id = flat[at]!
      const kind = stradaKindOf[flat[at + 1]!] ?? -1
      const list = byKey.get(`${kind}:${flat[at + 2]}:${flat[at + 3]}`)
      const node = list?.shift()
      if (!node) continue
      nodeOfId.set(id, node)
      idOfNode.set(node, id)
    }
  }
  const nodeFromId = (id: number): TypeScript.Node | undefined => {
    const known = nodeOfId.get(id)
    if (known) return known
    const info = rpc<{ f: number }>({ op: 'node', id })
    if (info.f >= 0) mapFile(info.f)
    return nodeOfId.get(id)
  }
  const idFromNode = (node: TypeScript.Node): number | undefined => {
    const known = idOfNode.get(node)
    if (known !== undefined) return known
    const source = node.getSourceFile?.()
    const index = source ? fileOfStrada.get(source) : undefined
    if (index === undefined) return undefined
    mapFile(index)
    return idOfNode.get(node)
  }

  // ---- value conversion ----
  const toWire = (value: unknown): unknown => {
    if (value === undefined || value === null) return null
    if (value instanceof TsgoType) return { t: value.id }
    if (value instanceof TsgoSymbol) return { s: value.id }
    if (value instanceof TsgoSignature) return { g: value.id }
    if (value instanceof TsgoObject) return { o: value.id }
    if (Array.isArray(value)) return value.map(toWire)
    if (typeof value === 'object' && 'kind' in value && 'pos' in value) {
      const id = idFromNode(value as TypeScript.Node)
      if (id === undefined) {
        unmappedArgument = true
        noteUnmapped(value as TypeScript.Node)
      }
      return id === undefined ? null : { n: id }
    }
    return value
  }
  // A node with no typescript-go twin (synthesized, or a shape the two parsers
  // span differently): the question has no answer, as TypeScript gives none for
  // a node outside its program.
  let unmappedArgument = false
  const unmappedKinds = new Map<string, number>()
  const noteUnmapped = (node: TypeScript.Node): void => {
    if (!process.env['GEA_TSGO_DEBUG']) return
    const label = real.SyntaxKind[node.kind] ?? String(node.kind)
    const count = (unmappedKinds.get(label) ?? 0) + 1
    unmappedKinds.set(label, count)
    if (count <= 3) {
      const source = node.getSourceFile?.()
      const where = source ? `${source.fileName.split('/').pop()}:${node.pos}-${node.end}` : 'detached'
      console.error(`[tsgo] unmapped ${label} at ${where}${node.flags & real.NodeFlags.Synthesized ? ' (synthesized)' : ''}`)
    }
  }
  const fromWire = (value: unknown): unknown => {
    if (value === null) return undefined
    if (Array.isArray(value)) return value.map(fromWire)
    if (isHandle(value)) {
      if (value.n !== undefined) return nodeFromId(value.n)
      if (value.t !== undefined) return typeFromId(value.t)
      if (value.s !== undefined) return symbolFromId(value.s)
      if (value.g !== undefined) return signatureFromId(value.g)
      if (value.o !== undefined) return objectFromId(value.o, value.c ?? '')
    }
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) out[key] = fromWire(item)
      return out
    }
    return value
  }
  const callOn = (recv: unknown, method: string, args: readonly unknown[] = []): unknown => {
    unmappedArgument = false
    const wire = args.map(toWire)
    if (unmappedArgument) return method.startsWith('GetTypeAt') || method === 'GetTypeOfSymbolAtLocation' ? checker.getAnyType() : undefined
    return fromWire(rpc<unknown>({ op: 'call', recv, method, args: wire }))
  }
  const fieldOf = (recv: unknown, field: string): unknown => fromWire(rpc<unknown>({ op: 'get', recv, field }))

  // ---- facades ----
  class TsgoObject {
    constructor(
      readonly id: number,
      readonly className: string
    ) {}
  }
  const objectFromId = (id: number, className: string): unknown => {
    const known = objectOfId.get(id)
    if (known) return known
    const target = new TsgoObject(id, className)
    const facade = new Proxy(target, {
      get: (object, key) => {
        if (typeof key === 'symbol' || key in object) return Reflect.get(object, key)
        // Strada field names onto typescript-go accessors.
        const name = className === 'IndexInfo' && key === 'type' ? 'ValueType' : pascal(key)
        return callOn({ o: id }, name)
      }
    })
    objectOfId.set(id, facade)
    return facade
  }

  class TsgoType {
    private readonly cache = new Map<string, unknown>()
    constructor(readonly id: number) {}
    private once<T>(key: string, compute: () => T): T {
      if (this.cache.has(key)) return this.cache.get(key) as T
      const value = compute()
      this.cache.set(key, value)
      return value
    }
    private get handle(): Handle {
      return { t: this.id }
    }
    get flags(): number {
      return this.once('flags', () => stradaFlags('TypeFlags', callOn(this.handle, 'Flags') as number))
    }
    get objectFlags(): number {
      return this.once('objectFlags', () => stradaFlags('ObjectFlags', callOn(this.handle, 'ObjectFlags') as number))
    }
    get symbol(): TsgoSymbol | undefined {
      return this.once('symbol', () => callOn(this.handle, 'Symbol') as TsgoSymbol | undefined)
    }
    get aliasSymbol(): TsgoSymbol | undefined {
      return this.once('aliasSymbol', () => {
        const alias = callOn(this.handle, 'Alias') as { symbol?: TsgoSymbol } | undefined
        return alias?.symbol
      })
    }
    get aliasTypeArguments(): readonly TsgoType[] | undefined {
      return this.once('aliasTypeArguments', () => {
        const alias = callOn(this.handle, 'Alias') as { typeArguments?: readonly TsgoType[] } | undefined
        return alias?.typeArguments
      })
    }
    get types(): readonly TsgoType[] {
      return this.once('types', () => (callOn(this.handle, 'GeatscTypes') as readonly TsgoType[] | undefined) ?? [])
    }
    get value(): unknown {
      return this.once('value', () => callOn(this.handle, 'GeatscLiteralValue'))
    }
    get target(): TsgoType | undefined {
      return this.once('target', () => callOn(this.handle, 'GeatscTarget') as TsgoType | undefined)
    }
    get intrinsicName(): string | undefined {
      return this.once('intrinsicName', () => (callOn(this.handle, 'GeatscIntrinsicName') as string) || undefined)
    }
    // TypeScript's own type-data fields, read directly by parts of the compiler.
    private field<T>(name: string): T {
      return this.once(`field:${name}`, () => callOn(this.handle, 'GeatscField', [name]) as T)
    }
    get objectType(): TsgoType | undefined {
      return this.field('objectType')
    }
    get indexType(): TsgoType | undefined {
      return this.field('indexType')
    }
    get checkType(): TsgoType | undefined {
      return this.field('checkType')
    }
    get extendsType(): TsgoType | undefined {
      return this.field('extendsType')
    }
    get typeParameter(): TsgoType | undefined {
      return this.field('typeParameter')
    }
    get constraintType(): TsgoType | undefined {
      return this.field('constraintType')
    }
    get templateType(): TsgoType | undefined {
      return this.field('templateType')
    }
    get nameType(): TsgoType | undefined {
      return this.field('nameType')
    }
    get modifiersType(): TsgoType | undefined {
      return this.field('modifiersType')
    }
    get baseType(): TsgoType | undefined {
      return this.field('baseType')
    }
    get substitute(): TsgoType | undefined {
      return this.field('substitute')
    }
    get type(): TsgoType | undefined {
      return this.field('type')
    }
    get texts(): readonly string[] | undefined {
      return this.field('texts')
    }
    get fixedLength(): number | undefined {
      return this.field('fixedLength')
    }
    get minLength(): number | undefined {
      return this.field('minLength')
    }
    get hasRestElement(): boolean | undefined {
      return this.field('hasRestElement')
    }
    get readonly(): boolean | undefined {
      return this.field('readonly')
    }
    get elementFlags(): readonly number[] | undefined {
      return this.once('elementFlags', () =>
        (this.field<readonly number[] | undefined>('elementFlags') ?? undefined)?.map((flag) => stradaFlags('ElementFlags', flag))
      )
    }
    get freshType(): TsgoType | undefined {
      return this.field('freshType')
    }
    get regularType(): TsgoType | undefined {
      return this.field('regularType')
    }
    get typeArguments(): readonly TsgoType[] | undefined {
      if ((this.objectFlags & real.ObjectFlags.Reference) === 0) return undefined
      return checker.getTypeArguments(this as never) as unknown as readonly TsgoType[]
    }
    getFlags(): number {
      return this.flags
    }
    getSymbol(): TsgoSymbol | undefined {
      return this.symbol
    }
    getProperties(): readonly TsgoSymbol[] {
      return checker.getPropertiesOfType(this as never) as unknown as readonly TsgoSymbol[]
    }
    getProperty(name: string): TsgoSymbol | undefined {
      return checker.getPropertyOfType(this as never, name) as unknown as TsgoSymbol | undefined
    }
    getApparentProperties(): readonly TsgoSymbol[] {
      return checker.getPropertiesOfType(checker.getApparentType(this as never)) as unknown as readonly TsgoSymbol[]
    }
    getCallSignatures(): readonly TsgoSignature[] {
      return checker.getSignaturesOfType(this as never, real.SignatureKind.Call) as unknown as readonly TsgoSignature[]
    }
    getConstructSignatures(): readonly TsgoSignature[] {
      return checker.getSignaturesOfType(this as never, real.SignatureKind.Construct) as unknown as readonly TsgoSignature[]
    }
    getStringIndexType(): TsgoType | undefined {
      return checker.getIndexTypeOfType(this as never, real.IndexKind.String) as unknown as TsgoType | undefined
    }
    getNumberIndexType(): TsgoType | undefined {
      return checker.getIndexTypeOfType(this as never, real.IndexKind.Number) as unknown as TsgoType | undefined
    }
    getBaseTypes(): readonly TsgoType[] | undefined {
      return checker.getBaseTypes(this as never) as unknown as readonly TsgoType[]
    }
    getNonNullableType(): TsgoType {
      return checker.getNonNullableType(this as never) as unknown as TsgoType
    }
    getConstraint(): TsgoType | undefined {
      return checker.getBaseConstraintOfType(this as never) as unknown as TsgoType | undefined
    }
    getDefault(): TsgoType | undefined {
      return callOn('checker', 'GetDefaultFromTypeParameter', [this]) as TsgoType | undefined
    }
    isUnion(): boolean {
      return (this.flags & real.TypeFlags.Union) !== 0
    }
    isIntersection(): boolean {
      return (this.flags & real.TypeFlags.Intersection) !== 0
    }
    isUnionOrIntersection(): boolean {
      return (this.flags & real.TypeFlags.UnionOrIntersection) !== 0
    }
    isLiteral(): boolean {
      return (this.flags & (real.TypeFlags.StringLiteral | real.TypeFlags.NumberLiteral | real.TypeFlags.BigIntLiteral)) !== 0
    }
    isStringLiteral(): boolean {
      return (this.flags & real.TypeFlags.StringLiteral) !== 0
    }
    isNumberLiteral(): boolean {
      return (this.flags & real.TypeFlags.NumberLiteral) !== 0
    }
    isTypeParameter(): boolean {
      return (this.flags & real.TypeFlags.TypeParameter) !== 0
    }
    isClassOrInterface(): boolean {
      return (this.objectFlags & real.ObjectFlags.ClassOrInterface) !== 0
    }
    isClass(): boolean {
      return (this.objectFlags & real.ObjectFlags.Class) !== 0
    }
    isIndexType(): boolean {
      return (this.flags & real.TypeFlags.Index) !== 0
    }
  }
  const typeFromId = (id: number): TsgoType => {
    let type = typeOfId.get(id)
    if (!type) typeOfId.set(id, (type = new TsgoType(id)))
    return type
  }

  class TsgoSymbol {
    private readonly cache = new Map<string, unknown>()
    constructor(readonly id: number) {}
    private once<T>(key: string, compute: () => T): T {
      if (this.cache.has(key)) return this.cache.get(key) as T
      const value = compute()
      this.cache.set(key, value)
      return value
    }
    private get handle(): Handle {
      return { s: this.id }
    }
    get flags(): number {
      return this.once('flags', () => stradaFlags('SymbolFlags', fieldOf(this.handle, 'Flags') as number))
    }
    get escapedName(): TypeScript.__String {
      return this.name as TypeScript.__String
    }
    get name(): string {
      return this.once('name', () => fieldOf(this.handle, 'Name') as string)
    }
    get declarations(): TypeScript.Declaration[] | undefined {
      return this.once('declarations', () => {
        const declarations = ((fieldOf(this.handle, 'Declarations') as unknown[] | undefined) ?? []).filter(
          (declaration) => declaration !== undefined
        ) as TypeScript.Declaration[]
        return declarations.length > 0 ? declarations : undefined
      })
    }
    get valueDeclaration(): TypeScript.Declaration | undefined {
      return this.once('valueDeclaration', () => fieldOf(this.handle, 'ValueDeclaration') as TypeScript.Declaration | undefined)
    }
    get parent(): TsgoSymbol | undefined {
      return this.once('parent', () => fieldOf(this.handle, 'Parent') as TsgoSymbol | undefined)
    }
    get exportSymbol(): TsgoSymbol | undefined {
      return this.once('exportSymbol', () => fieldOf(this.handle, 'ExportSymbol') as TsgoSymbol | undefined)
    }
    get members(): Map<TypeScript.__String, TsgoSymbol> | undefined {
      return this.once('members', () => tableOf(fieldOf(this.handle, 'Members')))
    }
    get exports(): Map<TypeScript.__String, TsgoSymbol> | undefined {
      return this.once('exports', () => tableOf(fieldOf(this.handle, 'Exports')))
    }
    getName(): string {
      return this.name
    }
    getEscapedName(): TypeScript.__String {
      return this.escapedName
    }
    getFlags(): number {
      return this.flags
    }
    getDeclarations(): TypeScript.Declaration[] | undefined {
      return this.declarations
    }
  }
  const tableOf = (value: unknown): Map<TypeScript.__String, TsgoSymbol> | undefined => {
    if (value === undefined || value === null || typeof value !== 'object') return undefined
    return new Map(Object.entries(value as Record<string, TsgoSymbol>).map(([name, symbol]) => [name as TypeScript.__String, symbol]))
  }
  const symbolFromId = (id: number): TsgoSymbol => {
    let symbol = symbolOfId.get(id)
    if (!symbol) symbolOfId.set(id, (symbol = new TsgoSymbol(id)))
    return symbol
  }

  class TsgoSignature {
    private readonly cache = new Map<string, unknown>()
    constructor(readonly id: number) {}
    private once<T>(key: string, compute: () => T): T {
      if (this.cache.has(key)) return this.cache.get(key) as T
      const value = compute()
      this.cache.set(key, value)
      return value
    }
    private get handle(): Handle {
      return { g: this.id }
    }
    get declaration(): TypeScript.SignatureDeclaration | undefined {
      return this.once('declaration', () => callOn(this.handle, 'Declaration') as TypeScript.SignatureDeclaration | undefined)
    }
    get parameters(): readonly TsgoSymbol[] {
      return this.once('parameters', () => (callOn(this.handle, 'Parameters') as readonly TsgoSymbol[] | undefined) ?? [])
    }
    get typeParameters(): readonly TsgoType[] | undefined {
      return this.once('typeParameters', () => {
        const parameters = callOn(this.handle, 'TypeParameters') as readonly TsgoType[] | undefined
        return parameters && parameters.length > 0 ? parameters : undefined
      })
    }
    get thisParameter(): TsgoSymbol | undefined {
      return this.once('thisParameter', () => callOn(this.handle, 'ThisParameter') as TsgoSymbol | undefined)
    }
    get minArgumentCount(): number {
      return this.once('minArgumentCount', () => callOn(this.handle, 'MinArgumentCount') as number)
    }
    get flags(): number {
      return this.once('flags', () => stradaFlags('SignatureFlags', callOn(this.handle, 'Flags') as number))
    }
    getDeclaration(): TypeScript.SignatureDeclaration | undefined {
      return this.declaration
    }
    getParameters(): readonly TsgoSymbol[] {
      return this.parameters
    }
    getTypeParameters(): readonly TsgoType[] | undefined {
      return this.typeParameters
    }
    getReturnType(): TsgoType {
      return checker.getReturnTypeOfSignature(this as never) as unknown as TsgoType
    }
  }
  const signatureFromId = (id: number): TsgoSignature => {
    let signature = signatureOfId.get(id)
    if (!signature) signatureOfId.set(id, (signature = new TsgoSignature(id)))
    return signature
  }

  // ---- checker ----
  // Methods whose arguments carry TypeScript enum values typescript-go numbers differently.
  const argumentAdapters: Record<string, (args: unknown[]) => unknown[]> = {
    resolveName: ([name, location, meaning, excludeGlobals]) => [name, location, corsaFlags('SymbolFlags', meaning as number), excludeGlobals],
    getSymbolsInScope: ([location, meaning]) => [location, corsaFlags('SymbolFlags', meaning as number)],
    getNullableType: ([type, flags]) => [type, corsaFlags('TypeFlags', flags as number)],
    typeToString: ([type]) => [type],
    getIndexTypeOfType: ([type, kind]) => [type, kind === real.IndexKind.Number ? checker.getNumberType() : checker.getStringType()],
    getIndexInfoOfType: ([type, kind]) => [type, kind === real.IndexKind.Number ? checker.getNumberType() : checker.getStringType()],
    getNumberLiteralType: ([value]) => [value],
    getBigIntLiteralType: ([value]) => {
      const literal = value as { negative: boolean; base10Value: string }
      return [literal.negative, literal.base10Value]
    }
  }
  // TypeScript names typescript-go spells differently.
  const methodNames: Record<string, string> = {
    getIndexInfoOfType: 'GetIndexInfoOfType',
    getTypeOfSymbol: 'GetTypeOfSymbol'
  }
  // ---- GEA_TSGO_COMPARE: the same question asked of TypeScript's own checker ----
  let comparisonProgram: TypeScript.Program | null = null
  let comparisonReal: Record<string, unknown> | null = null
  const comparisonMismatches = new Map<string, number>()
  const comparisonChecker = (): Record<string, unknown> | null => {
    if (!comparisonReal && comparisonProgram) comparisonReal = comparisonProgram.getTypeChecker() as unknown as Record<string, unknown>
    return comparisonReal
  }
  const declarationLabel = (node: TypeScript.Node | undefined): string => {
    if (!node) return '-'
    const source = node.getSourceFile?.()
    return `${source ? source.fileName.split('/').pop() : '?'}:${node.pos}`
  }
  const summarize = (value: unknown, world: 'ts' | 'tsgo'): string => {
    if (value === undefined || value === null) return 'none'
    if (Array.isArray(value)) return `[${value.map((item) => summarize(item, world)).join(', ')}]`
    if (typeof value !== 'object') return String(value)
    if (value instanceof TsgoType) return `type(${checker.typeToString(value as never)})`
    if (value instanceof TsgoSymbol) return `symbol(${value.name}@${(value.declarations ?? []).map(declarationLabel).join('|')})`
    if (value instanceof TsgoSignature) return `signature(${declarationLabel(value.declaration)})`
    const record = value as Record<string, unknown>
    if ('kind' in record && 'pos' in record) return `${real.SyntaxKind[record['kind'] as number]}@${declarationLabel(value as TypeScript.Node)}`
    if ('escapedName' in record && 'flags' in record) {
      const symbol = value as TypeScript.Symbol
      return `symbol(${symbol.name}@${(symbol.declarations ?? []).map(declarationLabel).join('|')})`
    }
    if ('parameters' in record && 'declaration' in record) return `signature(${declarationLabel((value as TypeScript.Signature).declaration)})`
    if ('flags' in record && 'checker' in record) {
      const reference = comparisonChecker() as unknown as TypeScript.TypeChecker
      return `type(${reference.typeToString(value as TypeScript.Type)})`
    }
    return 'object'
  }
  const checkerMethod = (key: string): ((...args: unknown[]) => unknown) => {
    const method = methodNames[key] ?? pascal(key)
    const adapt = argumentAdapters[key]
    // typescript-go dereferences a type reference's target unconditionally.
    if (key === 'getTypeArguments')
      return (type: unknown): unknown =>
        type instanceof TsgoType && type.objectFlags & real.ObjectFlags.Reference ? callOn('checker', method, [type]) : []
    if (process.env['GEA_TSGO_COMPARE'])
      return (...args: unknown[]): unknown => {
        const result = callOn('checker', method, adapt ? adapt(args) : args)
        const reference = comparisonChecker()
        const nodeOnly = args.every((arg) => arg === undefined || typeof arg !== 'object' || (arg !== null && 'kind' in arg && 'pos' in arg))
        const real = reference?.[key]
        if (!nodeOnly || typeof real !== 'function') return result
        let expected: unknown
        try {
          expected = (real as (...a: unknown[]) => unknown).apply(reference, args)
        } catch {
          return result
        }
        const mine = summarize(result, 'tsgo')
        const theirs = summarize(expected, 'ts')
        if (mine !== theirs) {
          const key2 = `${key}: ${theirs} -> ${mine}`
          const count = (comparisonMismatches.get(key2) ?? 0) + 1
          comparisonMismatches.set(key2, count)
          if (count === 1) console.error(`[tsgo-compare] ${key}(${args.map((arg) => summarize(arg, 'ts')).join(', ')}): ts ${theirs} | tsgo ${mine}`)
        }
        return result
      }
    if (process.env['GEA_TSGO_TRACE'])
      return (...args: unknown[]): unknown => {
        const result = callOn('checker', method, adapt ? adapt(args) : args)
        if (result instanceof TsgoType && result.flags & real.TypeFlags.Any) {
          const describe = (value: unknown): string =>
            value instanceof TsgoType
              ? `type(${checker.typeToString(value as never)})`
              : value instanceof TsgoSymbol
                ? `symbol(${value.name})`
                : typeof value === 'object' && value !== null && 'kind' in value
                  ? `${real.SyntaxKind[(value as TypeScript.Node).kind]}(${(value as TypeScript.Node).getText?.().slice(0, 40)})`
                  : JSON.stringify(value)
          console.error(`[tsgo-trace] ${key}(${args.map(describe).join(', ')}) -> any (${result.intrinsicName ?? ''})`)
        }
        return result
      }
    return (...args: unknown[]): unknown => callOn('checker', method, adapt ? adapt(args) : args)
  }
  // Every method a real checker has, as an own property: the compiler copies
  // and wraps the checker (`{ ...checker }`), which a bare Proxy would survive
  // with no methods at all.
  const checkerTarget: Record<string, unknown> = {}
  const realChecker = real.createProgram([], { noLib: true }).getTypeChecker() as unknown as Record<string, unknown>
  for (const key of Object.keys(realChecker)) if (typeof realChecker[key] === 'function') checkerTarget[key] = checkerMethod(key)
  const checker = new Proxy(checkerTarget, {
    get: (target, key) => {
      if (typeof key === 'symbol') return undefined
      if (!(key in target)) target[key] = checkerMethod(key)
      return target[key]
    }
  }) as unknown as TypeScript.TypeChecker

  const optionsJson = (options: TypeScript.CompilerOptions): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    const enumName = (table: Record<number, string>, value: unknown): string | undefined =>
      typeof value === 'number' ? table[value]?.toLowerCase() : undefined
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined || key === 'configFilePath' || key === 'pathsBasePath' || key === 'configFile') continue
      if (key === 'target') out[key] = enumName(real.ScriptTarget as unknown as Record<number, string>, value)
      else if (key === 'module') out[key] = enumName(real.ModuleKind as unknown as Record<number, string>, value)
      else if (key === 'moduleResolution') {
        const name = enumName(real.ModuleResolutionKind as unknown as Record<number, string>, value)
        out[key] = name === 'node10' || name === 'nodejs' || name === 'classic' ? 'bundler' : name
      } else if (key === 'jsx') out[key] = enumName(real.JsxEmit as unknown as Record<number, string>, value)
      else if (key === 'newLine') continue
      else if (key === 'lib') continue
      else if (typeof value === 'boolean' || typeof value === 'string' || Array.isArray(value) || typeof value === 'number') out[key] = value
      else if (typeof value === 'object') out[key] = value
    }
    // Every file the TypeScript program holds is a root below, libraries included.
    out['noLib'] = true
    out['types'] = []
    out['skipLibCheck'] = true
    out['noEmit'] = true
    if (out['module'] === undefined) out['module'] = 'esnext'
    if (out['moduleResolution'] === undefined) out['moduleResolution'] = out['module'] === 'nodenext' ? 'nodenext' : 'bundler'
    return out
  }

  const open = (program: TypeScript.Program): void => {
    generation++
    comparisonProgram = program
    comparisonReal = null
    const sources = program.getSourceFiles()
    const cwd = program.getCurrentDirectory()
    const absolute = (fileName: string): string => resolve(cwd, fileName).replace(/\\/g, '/')
    const contents: Record<string, string> = {}
    for (const source of sources) contents[absolute(source.fileName)] = source.text
    const opened = rpc<{ files: OpenedFile[]; configErrors: string[] }>({
      op: 'open',
      cwd,
      roots: sources.map((source) => absolute(source.fileName)),
      files: contents,
      options: optionsJson(program.getCompilerOptions())
    })
    if (process.env['GEA_TSGO_DEBUG'] && opened.configErrors.length > 0) console.error('[tsgo] config:', opened.configErrors.join('\n'))
    files = opened.files
    const byName = new Map(sources.map((source) => [normalizedPath(absolute(source.fileName)), source]))
    stradaFiles = files.map((file) => byName.get(normalizedPath(file.name)))
    fileOfStrada = new WeakMap()
    stradaFiles.forEach((source, index) => {
      if (source) fileOfStrada.set(source, index)
    })
    mapped = files.map(() => false)
    nodeOfId = new Map()
    idOfNode = new WeakMap()
    typeOfId = new Map()
    symbolOfId = new Map()
    signatureOfId = new Map()
    objectOfId = new Map()
    if (process.env['GEA_TSGO_DEBUG']) {
      const missing = files.filter((_file, index) => !stradaFiles[index]).map((file) => file.name)
      console.error(`[tsgo] opened ${files.length} files (${missing.length} without a TypeScript twin: ${missing.slice(0, 3).join(', ')}), generation ${generation}`)
      const corsaNames = new Set(files.map((file) => normalizedPath(file.name)))
      const lonely = sources.filter((source) => !corsaNames.has(normalizedPath(absolute(source.fileName)))).map((source) => source.fileName)
      if (lonely.length > 0) console.error(`[tsgo] ${lonely.length} TypeScript files typescript-go did not load: ${lonely.slice(0, 3).join(', ')}`)
    }
  }

  const diagnosticsOf = (program: TypeScript.Program, file?: TypeScript.SourceFile): TypeScript.Diagnostic[] => {
    const wanted = file ? [file] : program.getSourceFiles()
    const out: TypeScript.Diagnostic[] = []
    for (const source of wanted) {
      const index = fileOfStrada.get(source)
      if (index === undefined) continue
      const handle = { n: files[index]!.node }
      const raw = rpc<unknown[]>({ op: 'call', recv: 'program', method: 'GetSemanticDiagnostics', args: [null, handle] })
      for (const entry of raw ?? []) {
        if (!isHandle(entry)) continue
        const recv = { o: entry.o }
        out.push({
          category: real.DiagnosticCategory.Error,
          code: rpc<number>({ op: 'call', recv, method: 'Code', args: [] }),
          file: source,
          start: rpc<number>({ op: 'call', recv, method: 'Pos', args: [] }),
          length: rpc<number>({ op: 'call', recv, method: 'Len', args: [] }),
          messageText: rpc<string>({ op: 'call', recv, method: 'String', args: [] })
        })
      }
    }
    return out
  }

  const createProgram = ((...args: Parameters<Ts['createProgram']>) => {
    const program = (real.createProgram as (...a: unknown[]) => TypeScript.Program)(...args)
    let current = -1
    const ensure = (): void => {
      if (current === generation && current !== -1) return
      open(program)
      current = generation
    }
    return new Proxy(program, {
      get: (target, key, receiver) => {
        if (key === 'getTypeChecker')
          return () => {
            ensure()
            return checker
          }
        if (key === 'getSemanticDiagnostics')
          return (file?: TypeScript.SourceFile) => {
            ensure()
            return process.env['GEA_TSGO_DIAGNOSTICS'] === '1' ? diagnosticsOf(target, file) : []
          }
        if (key === 'getGlobalDiagnostics' || key === 'getDeclarationDiagnostics') return () => []
        return Reflect.get(target, key, receiver)
      }
    })
  }) as Ts['createProgram']

  process.on('exit', () => {
    if (process.env['GEA_TSGO_COMPARE'])
      for (const [label, count] of [...comparisonMismatches].sort((a, b) => b[1] - a[1]).slice(0, 25))
        console.error(`[tsgo-compare-summary] ${count}x ${label.slice(0, 260)}`)
    if (process.env['GEA_TSGO_DEBUG']) console.error(`[tsgo] ${stats.calls} bridge calls; unmapped ${JSON.stringify(Object.fromEntries(unmappedKinds))}`)
  })

  return new Proxy(real, {
    get: (target, key, receiver) => (key === 'createProgram' ? createProgram : Reflect.get(target, key, receiver))
  })
}
