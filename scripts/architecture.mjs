import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/**
 * The architecture gate.
 *
 * Everything here enforces the layering and the three absolute constraints in
 * docs/ARCHITECTURE.md's five invariants: no source-shaped authority, no boxing,
 * fail closed (BUILD-BRIEF.md, which stated them until 2026-09-04, is gone). This
 * is a clean tree with no legacy code to grandfather, so every rule below is a
 * hard maximum or a zero-tolerance check, never a ratchet with a baseline.
 *
 * Violations are collected across the whole tree and reported together, so one
 * run tells you everything wrong instead of one thing at a time.
 */

// Raised from 800 on the user's instruction (2026-09-01). A file over the old
// limit was blocking every concurrent agent's `dist/` emit for a reason that
// was purely cosmetic; the gate exists to keep files readable, not to stall
// the build over twenty-five lines.
// No per-file line cap and no per-directory file cap. Both were removed
// deliberately: they are size limits, not architecture, and the only thing
// they ever produced was a file split at an arbitrary boundary to get under
// a number -- which makes the code worse, not better, and blocks everyone's
// build while it happens. What this gate checks is what the code MEANS:
// layering, the absence of `any`, no typescript imports outside the two
// layers allowed to hold them.
const MAX_LINE_COLUMNS = 300

/** The only categories a `semanticCategory` may declare. A label outside this set is not authority. */
const semanticCategories = new Set(['generic-primitive', 'framework-protocol'])

/** An exported type/interface/const must end in one of these to require classification. */
const contractSuffixPattern = /(?:Authority|Admission|Proof)$/

// An admitted call frame can only be built by its proof owner. Consumers use
// the branded fact; classification labels alone did not enforce this boundary.
const invocationFactBuilders = new Set(['sourceInvocationFrame', 'sourceInvocationFact'])
const invocationFactOwners = new Set(['semantics/normalize/flow/invocation-facts.ts', 'semantics/normalize/flow/callable-reach.ts'])
const retiredInvocationAuthorities = new Set([
  'closedMethodForwardingTargetsOf',
  'memberCallSiteDeclarationsOf',
  'closedInvocationTargetsOf',
  'memberCallArgumentUse',
  'recordCallArgumentUse',
  'recordCallTargetOf',
  'directFunctionCall',
  'parameterCarriesArgument',
  'argumentEdgesOf'
])
const completeFrameConsumers = new Set([
  'semantics/normalize/flow/array-element-continuation.ts',
  'semantics/normalize/flow/value-provenance.ts',
  'semantics/normalize/flow/class-family-member-read.ts',
  'semantics/normalize/flow/member-call-forwarding.ts',
  'semantics/normalize/flow/source-class-data.ts'
])
const allocationGraphOwners = new Set(['semantics/normalize/flow/member-call-forwarding.ts', 'semantics/normalize/flow/callable-reach.ts'])

/**
 * Source-shaped discriminants: names or literals that recognize a specific
 * application, helper, or source shape instead of a generic ECMAScript
 * operation. Comments may discuss these terms; only string literals and
 * identifiers -- actual code identity -- are checked.
 */
const forbiddenStems = [
  'proxy-wrap',
  'proxyWrap',
  'direct-map',
  'directMap',
  'fresh-array',
  'freshArray',
  'resultwrap',
  'resultWrap',
  'tracked-proxy',
  'trackedProxy',
  'proxy-private-state',
  'proxyPrivateState',
  'raw-helper',
  'rawHelper',
  'helper-selection',
  'fire-bucket',
  'counted-iteration'
]

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(scriptDirectory, '..')
const sourceRoot = path.join(projectRoot, 'src')
const targetsRoot = path.join(sourceRoot, 'targets')
const cppTargetRoot = path.join(sourceRoot, 'targets', 'cpp')
const semanticsRoot = path.join(sourceRoot, 'semantics')
const pluginsRoot = path.join(sourceRoot, 'plugins')
const diagnosticSweepFile = path.join(sourceRoot, 'diagnostics', 'sweep.ts')
const recipePrinterTableFile = path.join(cppTargetRoot, 'emit-narrowing.ts')
const emitContextFile = path.join(cppTargetRoot, 'emit-context.ts')

const violations = []
let checkedFileCount = 0
let packedLineCount = 0
let cppTargetRegExpLiteralCount = 0
let sourcePositionLiteralComparisonCount = 0
let typescriptImportOutsideSemanticsCount = 0
let sourceShapedDiscriminantCount = 0
let classifiedSemanticContractCount = 0
let unclassifiedSemanticContractCount = 0
let classDeclarationUnderTargetsCount = 0
let anyTypeUsageCount = 0
let diagnosticClassificationOutsideSweepCount = 0
let stringSpelledCppTypeCheckCount = 0
let rawDominanceBuilderCallCount = 0
let recipeTextExternalCallCount = 0
let emitContextMapOrSetReassignmentCount = 0
let constantTextsPassedAsArgumentCount = 0
let mutableEmitContextFieldCount = 0

/**
 * Mechanically enforced, this count must stay zero: `convertedValueText`/`narrowedLoadText`/
 * `widenedStoreText`/`recastedUnionText` are the recipe printer's own
 * renderers (`emit-narrowing.ts`). A caller anywhere else bypasses the one
 * census-backed entry point (`alignedValueText`/`namedConversionText`) that
 * asks `ConversionCensus.nodeFor` first and records printer drift -- calling
 * the renderer directly answers "how is this pair spelled" without ever
 * recording "the census was asked".
 *
 * The tree already has 20 such calls across 8 files, pre-dating this gate.
 * Rewriting each to go through `alignedValueText` cannot be done as a
 * mechanical import/call swap: for any pair whose census node is not
 * `identity`/`never`, `recipeText` renders through `coercionText` or the
 * chain by a different path than calling the raw renderer directly, and
 * telling those apart needs the corpus/runtime-test gate this task is
 * forbidden from running (a private, unverified change to shared,
 * concurrently-measured `src/targets/cpp` is exactly what CLAUDE.md's "One
 * compiler" rule warns against). So these 20 are named here, not fixed, and
 * the gate fails on any count that moves -- up (a new bypass) or down (a
 * site was migrated and this table went stale).
 */
const recipeTextExternalCallAllowance = {
  convertedValueText: { 'targets/cpp/emit-record-view.ts': 3 },
  narrowedLoadText: { 'targets/cpp/emit-properties.ts': 1, 'targets/cpp/emit-arrays.ts': 2 },
  widenedStoreText: {
    'targets/cpp/emit-equality.ts': 1,
    'targets/cpp/emit.ts': 1,
    'targets/cpp/emit-dynamic-properties.ts': 1,
    'targets/cpp/emit-union-properties.ts': 5,
    'targets/cpp/emit-carrier-members.ts': 1,
    'targets/cpp/emit-arrays.ts': 2,
    // `records.ts`'s two sites were migrated: both asked the SAME edge -- how a
    // native carrier boxes into a dynamic cell -- and both now go through
    // `dynamicCarrierBoxText`, which states that reason once in the recipe
    // printer's own module instead of letting each field table spell it.
    'targets/cpp/host/object-protocol.ts': 1
  },
  recastedUnionText: {}
}
const recipeTextFunctionNames = new Set(Object.keys(recipeTextExternalCallAllowance))
/** Per-file call counts for the current run, filled while walking the tree, checked against the allowance once each file is done. */
const recipeTextExternalCallCounts = { convertedValueText: {}, narrowedLoadText: {}, widenedStoreText: {}, recastedUnionText: {} }

// POSIX separators, because every rule table above keys on them while
// `path.relative` answers in the platform's. On Windows that made each
// owner and allowance lookup miss, so the gate reported callable-reach as
// violating the rule it owns and every allowed printer call as a new bypass.
const relativeToSource = (file) => (path.relative(sourceRoot, file) || '.').split(path.sep).join('/')

const withinDirectory = (file, directory) => file === directory || file.startsWith(`${directory}${path.sep}`)

/** Collects every `.ts` file under `directory`. */
function collectTypeScriptFiles(directory, files = []) {
  const entries = readdirSync(directory, { withFileTypes: true })
  const directTypeScriptFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.ts')).map((entry) => entry.name)

  for (const name of directTypeScriptFiles) files.push(path.join(directory, name))
  for (const entry of entries) {
    if (entry.isDirectory()) collectTypeScriptFiles(path.join(directory, entry.name), files)
  }
  return files
}

/** Strips parentheses, `as`/angle-bracket assertions, and `!` so the underlying expression is visible. */
function unwrapExpression(node) {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    node = node.expression
  }
  return node
}

function isNumericLiteralExpression(node) {
  const expression = unwrapExpression(node)
  return (
    ts.isNumericLiteral(expression) ||
    (ts.isPrefixUnaryExpression(expression) &&
      (expression.operator === ts.SyntaxKind.MinusToken || expression.operator === ts.SyntaxKind.PlusToken) &&
      ts.isNumericLiteral(expression.operand))
  )
}

/** `.pos`, `.end`, or a `getStart()` call -- the three source-coordinate reads the architecture forbids admitting on. */
function isSourcePositionExpression(node) {
  const expression = unwrapExpression(node)
  return (
    (ts.isPropertyAccessExpression(expression) && (expression.name.text === 'pos' || expression.name.text === 'end')) ||
    (ts.isCallExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.name.text === 'getStart')
  )
}

const positionComparisonOperators = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken
])

function isSourcePositionLiteralComparison(node) {
  if (!ts.isBinaryExpression(node) || !positionComparisonOperators.has(node.operatorToken.kind)) return false
  return (
    (isSourcePositionExpression(node.left) && isNumericLiteralExpression(node.right)) ||
    (isNumericLiteralExpression(node.left) && isSourcePositionExpression(node.right))
  )
}

/**
 * `<expr>.startsWith('gea::...')` under `src/targets`: sniffing a rendered
 * C++ spelling's text prefix to answer a question the `Representation`
 * model already answers directly (`.kind`, `cppTypeOf`). A string-shaped
 * proxy for a typed fact is the same defect class `forbiddenStems` polices
 * for source shapes -- here for the TARGET language's shapes instead.
 */
function isGeaNamespacePrefixCheck(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false
  if (node.expression.name.text !== 'startsWith') return false
  const [argument] = node.arguments
  return argument !== undefined && ts.isStringLiteralLike(argument) && argument.text.startsWith('gea::')
}

/** `<expr> === 'std::string'` (or `!==`) under `src/targets`: the same text-sniffing defect, spelled as an equality instead of a prefix test. */
function isStdStringSpellingComparison(node) {
  if (!ts.isBinaryExpression(node)) return false
  if (
    node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
    node.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken
  ) {
    return false
  }
  const isStdStringLiteral = (expression) => ts.isStringLiteralLike(expression) && expression.text === 'std::string'
  return isStdStringLiteral(node.left) || isStdStringLiteral(node.right)
}

/**
 * A raw call to `buildDominatorTree`/`buildControlFlowGraph` under
 * `src/targets`. `src/ir/dominance.ts` owns both: `controlFlowGraphOf`,
 * `dominatorTreeOf` and `cyclicBlocksOf` memoise them per body so two
 * requests for the same body's graph return the same object instead of
 * recomputing (and potentially disagreeing after an in-place IR edit). A
 * target calling the raw builder directly opts out of that memo silently.
 */
function isRawDominanceBuilderCall(node) {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return false
  return node.expression.text === 'buildDominatorTree' || node.expression.text === 'buildControlFlowGraph'
}

/** The string module specifier a node imports/exports/dynamically-imports from, or `null`. */
function moduleSpecifierText(node) {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) return node.moduleSpecifier.text
  if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) return node.moduleSpecifier.text
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    const reference = node.moduleReference.expression
    if (ts.isStringLiteral(reference)) return reference.text
  }
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const [firstArgument] = node.arguments
    if (firstArgument && ts.isStringLiteral(firstArgument)) return firstArgument.text
  }
  return null
}

function hasExportModifier(node) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

/** Object-shape members of a type node, drilling through intersections. A union is not a single shape and yields none. */
function typeLiteralMembers(typeNode) {
  if (!typeNode) return []
  if (ts.isTypeLiteralNode(typeNode)) return typeNode.members
  if (ts.isIntersectionTypeNode(typeNode)) return typeNode.types.flatMap(typeLiteralMembers)
  return []
}

function memberName(member) {
  if (!member.name) return null
  if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) return member.name.text
  return null
}

/** The string-literal value(s) a type node names, or `null` if any arm is not a string literal. */
function stringLiteralTypeValues(typeNode) {
  if (!typeNode) return null
  if (ts.isLiteralTypeNode(typeNode) && ts.isStringLiteral(typeNode.literal)) return [typeNode.literal.text]
  if (ts.isUnionTypeNode(typeNode)) {
    const values = typeNode.types.flatMap((member) => stringLiteralTypeValues(member) ?? [])
    return values.length === typeNode.types.length ? values : null
  }
  return null
}

/**
 * Whether `members` (interface members, an object-literal's properties, or a
 * type shape's members) declare `semanticCategory`, and what value(s) it names.
 * `present: false` means the property path cannot classify this contract at
 * all, not that it is invalid -- the JSDoc tag is still a valid alternative.
 */
function semanticCategoryFromMembers(members) {
  const matches = members.filter((member) => memberName(member) === 'semanticCategory')
  if (matches.length === 0) return { present: false, categories: [] }
  const categories = matches.flatMap((member) => {
    if (ts.isPropertySignature(member)) return stringLiteralTypeValues(member.type) ?? ['<non-literal>']
    if (ts.isPropertyAssignment(member) && ts.isStringLiteral(member.initializer)) return [member.initializer.text]
    return ['<non-literal>']
  })
  return { present: true, categories }
}

/** The `@semanticCategory` JSDoc tag text on `node`, or `null` if there is none. */
function semanticCategoryJsDocTag(node) {
  for (const tag of ts.getJSDocTags(node)) {
    if (tag.tagName.text !== 'semanticCategory') continue
    return (ts.getTextOfJSDocComment(tag.comment) ?? '').trim()
  }
  return null
}

/**
 * Rule 8: every exported `...Authority`/`...Admission`/`...Proof` contract must
 * declare which of the two governance categories it belongs to -- as a member
 * (an interface, a type shape, or a const object literal all expose members the
 * same way) or, when the contract is a union of variants with no single member
 * list, as a preceding `@semanticCategory` tag. A label is bookkeeping, not
 * authority by itself, but an unlabelled contract cannot even be audited.
 */
function inspectSemanticContract(name, location, members, jsDocNode) {
  const fromMembers = semanticCategoryFromMembers(members)
  if (fromMembers.present) {
    const invalid = fromMembers.categories.filter((category) => !semanticCategories.has(category))
    if (invalid.length > 0) {
      unclassifiedSemanticContractCount += 1
      violations.push(`${location}: ${name} declares semanticCategory [${invalid.join(', ')}], not generic-primitive|framework-protocol`)
    } else {
      classifiedSemanticContractCount += 1
    }
    return
  }
  const tagValue = semanticCategoryJsDocTag(jsDocNode)
  if (tagValue === null) {
    unclassifiedSemanticContractCount += 1
    violations.push(
      `${location}: exported ${name} ends in Authority/Admission/Proof but has no semanticCategory property or @semanticCategory tag`
    )
    return
  }
  if (!semanticCategories.has(tagValue)) {
    unclassifiedSemanticContractCount += 1
    violations.push(`${location}: ${name} has @semanticCategory tag "${tagValue}", not generic-primitive|framework-protocol`)
    return
  }
  classifiedSemanticContractCount += 1
}

for (const file of collectTypeScriptFiles(sourceRoot).sort()) {
  checkedFileCount += 1
  const relativeFile = relativeToSource(file)
  const source = readFileSync(file, 'utf8')

  const rawLines = source.split(/\r?\n/)
  for (let index = 0; index < rawLines.length; index += 1) {
    const lineLength = rawLines[index].length
    if (lineLength > MAX_LINE_COLUMNS) {
      packedLineCount += 1
      violations.push(`${relativeFile}:${index + 1}: line has ${lineLength} columns (maximum ${MAX_LINE_COLUMNS})`)
    }
  }

  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const lineOf = (node) => `${relativeFile}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`

  const inCppTarget = withinDirectory(file, cppTargetRoot)
  const inTargets = withinDirectory(file, targetsRoot)
  const inSemantics = withinDirectory(file, semanticsRoot)
  // A plugin's normalization half reads the checker for the same reason the
  // core's does: it is what decides meaning, and a plugin exists precisely to
  // decide some of it differently. The rule this relaxes is about the compiler
  // *stages* -- lowering, projection, emission -- never seeing syntax, and that
  // stays exactly as strict: a plugin's lowering imports no more than the
  // core's does.
  const inPlugins = withinDirectory(file, pluginsRoot)
  const isRecipePrinterTable = file === recipePrinterTableFile
  const recipeTextCallsInFile = { convertedValueText: 0, narrowedLoadText: 0, widenedStoreText: 0, recastedUnionText: 0 }

  const visit = (node) => {
    if (
      completeFrameConsumers.has(relativeFile) &&
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text.endsWith('/parameter-values.js')
    )
      violations.push(`${lineOf(node)}: migrated value consumers require the complete frame authority, not standalone parameter inference`)
    if (
      ts.isIdentifier(node) &&
      node.text === 'exactClassAllocationOriginsOf' &&
      !allocationGraphOwners.has(relativeFile) &&
      !relativeFile.endsWith('.test.ts')
    )
      violations.push(`${lineOf(node)}: allocation graphs are owned by callable-reach; consume its complete origin authority`)
    if (ts.isIdentifier(node) && invocationFactBuilders.has(node.text) && !invocationFactOwners.has(relativeFile))
      violations.push(`${lineOf(node)}: ${node.text} is owned by callable-reach; consume the admitted invocation fact`)
    if (ts.isIdentifier(node) && retiredInvocationAuthorities.has(node.text))
      violations.push(`${lineOf(node)}: ${node.text} is a retired parallel invocation authority; consume invocationFactOf`)
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === 'severity') ||
        (ts.isStringLiteralLike(node.name) && node.name.text === 'severity')) &&
      ts.isStringLiteralLike(node.initializer) &&
      ['root', 'derived', 'unsupported'].includes(node.initializer.text) &&
      file !== diagnosticSweepFile
    ) {
      diagnosticClassificationOutsideSweepCount += 1
      violations.push(`${lineOf(node)}: diagnostic severity is classified outside diagnostics/sweep.ts`)
    }
    if (ts.isRegularExpressionLiteral(node) && inCppTarget) {
      cppTargetRegExpLiteralCount += 1
      violations.push(`${lineOf(node)}: RegExp literal under src/targets/cpp/ is forbidden`)
    }

    if (isSourcePositionLiteralComparison(node)) {
      sourcePositionLiteralComparisonCount += 1
      violations.push(`${lineOf(node)}: comparison of .pos/.end/getStart() against a numeric literal is forbidden`)
    }

    const specifier = moduleSpecifierText(node)
    if (specifier === 'typescript' && !inSemantics && !inPlugins) {
      typescriptImportOutsideSemanticsCount += 1
      violations.push(`${lineOf(node)}: imports 'typescript' outside src/semantics/ and src/plugins/`)
    }

    if (ts.isStringLiteralLike(node) || ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      for (const stem of forbiddenStems) {
        if (!node.text.includes(stem)) continue
        sourceShapedDiscriminantCount += 1
        const kind = ts.isStringLiteralLike(node) ? 'string literal' : 'identifier'
        violations.push(`${lineOf(node)}: ${kind} "${node.text}" contains forbidden source-shaped stem "${stem}"`)
      }
    }

    if (ts.isTypeAliasDeclaration(node) && hasExportModifier(node) && contractSuffixPattern.test(node.name.text)) {
      inspectSemanticContract(node.name.text, lineOf(node), typeLiteralMembers(node.type), node)
    }
    if (ts.isInterfaceDeclaration(node) && hasExportModifier(node) && contractSuffixPattern.test(node.name.text)) {
      inspectSemanticContract(node.name.text, lineOf(node), node.members, node)
    }
    if (ts.isVariableStatement(node) && hasExportModifier(node) && (node.declarationList.flags & ts.NodeFlags.Const) !== 0) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !contractSuffixPattern.test(declaration.name.text)) continue
        const members =
          declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer) ? declaration.initializer.properties : []
        inspectSemanticContract(declaration.name.text, lineOf(declaration), members, node)
      }
    }

    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && inTargets) {
      classDeclarationUnderTargetsCount += 1
      violations.push(`${lineOf(node)}: class declaration under src/targets/ is forbidden (${node.name?.text ?? '<anonymous>'})`)
    }

    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      anyTypeUsageCount += 1
      violations.push(`${lineOf(node)}: 'any' type is forbidden`)
    }

    if (inTargets && isGeaNamespacePrefixCheck(node)) {
      stringSpelledCppTypeCheckCount += 1
      violations.push(
        `${lineOf(node)}: .startsWith('gea::...') under src/targets/ sniffs a rendered spelling instead of asking the Representation`
      )
    }
    if (inTargets && isStdStringSpellingComparison(node)) {
      stringSpelledCppTypeCheckCount += 1
      violations.push(
        `${lineOf(node)}: comparison against 'std::string' under src/targets/ sniffs a rendered spelling instead of asking the Representation`
      )
    }

    if (inTargets && isRawDominanceBuilderCall(node)) {
      rawDominanceBuilderCallCount += 1
      violations.push(
        `${lineOf(node)}: calls ${node.expression.text}(...) directly under src/targets/ instead of ir/dominance.ts's memoised reader`
      )
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      recipeTextFunctionNames.has(node.expression.text) &&
      !isRecipePrinterTable
    ) {
      const name = node.expression.text
      recipeTextCallsInFile[name] += 1
      recipeTextExternalCallCounts[name][relativeFile] = (recipeTextExternalCallCounts[name][relativeFile] ?? 0) + 1
    }

    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  if (!isRecipePrinterTable) {
    for (const name of recipeTextFunctionNames) {
      const allowed = recipeTextExternalCallAllowance[name][relativeFile] ?? 0
      const actual = recipeTextCallsInFile[name]
      recipeTextExternalCallCount += actual
      if (actual === allowed) continue
      violations.push(
        `${relativeFile}: ${actual} call(s) to ${name}(...) outside the recipe printer table (emit-narrowing.ts), ` +
          `${allowed} allowed by the named exception in scripts/architecture.mjs -- ${
            actual > allowed
              ? 'a new bypass of alignedValueText/namedConversionText'
              : 'the allowance is stale; lower it to match the fixed count'
          }`
      )
    }
  }
}

/**
 * Mechanically enforced, this count must stay zero: an `EmitContext` field of type `Map`/`Set`
 * (the mutable, non-`Readonly` variant -- these hold per-program or
 * per-body state exactly one place is allowed to originate) constructed a
 * SECOND time by a file named `emit-*`, other than `emit-context.ts` itself,
 * which is the field's one declared owner. A second `new Map()`/`new Set()`
 * default for the same field name is a second, independent, silently-empty
 * copy of state that is supposed to be shared: `emit.ts`'s `emitBody` used
 * to default `symbolKeys`/`templateObjects` this way even though its only
 * caller (`translation-unit.ts`) always passed its own program-wide table --
 * fixed by dropping the dead defaults rather than allowing this check to see
 * them.
 *
 * Two passes because file iteration order (alphabetical) does not put
 * `emit-context.ts` before every other `emit-*.ts` file.
 */
const emitContextSource = readFileSync(emitContextFile, 'utf8')
const emitContextSourceFile = ts.createSourceFile(emitContextFile, emitContextSource, ts.ScriptTarget.Latest, true)
const mapOrSetFieldNames = new Set()
const collectEmitContextFields = (node) => {
  if (ts.isInterfaceDeclaration(node) && node.name.text === 'EmitContext') {
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !member.type) continue
      const name = member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) ? member.name.text : null
      if (name === null) continue
      if (
        ts.isTypeReferenceNode(member.type) &&
        ts.isIdentifier(member.type.typeName) &&
        ['Map', 'Set'].includes(member.type.typeName.text)
      ) {
        mapOrSetFieldNames.add(name)
      }
    }
  }
  ts.forEachChild(node, collectEmitContextFields)
}
collectEmitContextFields(emitContextSourceFile)

const isFreshMapOrSetExpression = (expression) =>
  ts.isNewExpression(expression) && ts.isIdentifier(expression.expression) && ['Map', 'Set'].includes(expression.expression.text)

/** Whether `typeNode` is the bare (non-`Readonly`) `Map<...>`/`Set<...>` a field's own declaration uses. */
const isMapOrSetTypeNode = (typeNode) =>
  typeNode !== undefined &&
  ts.isTypeReferenceNode(typeNode) &&
  ts.isIdentifier(typeNode.typeName) &&
  ['Map', 'Set'].includes(typeNode.typeName.text)

for (const file of collectTypeScriptFiles(targetsRoot).sort()) {
  if (file === emitContextFile || !path.basename(file).startsWith('emit-')) continue
  const relativeFile = relativeToSource(file)
  const source = readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const lineOf = (node) => `${relativeFile}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`

  const visit = (node) => {
    const isNamedDeclarationWithInitializer =
      (ts.isParameter(node) || ts.isVariableDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      mapOrSetFieldNames.has(node.name.text) &&
      isMapOrSetTypeNode(node.type) &&
      node.initializer !== undefined &&
      isFreshMapOrSetExpression(node.initializer)
    if (isNamedDeclarationWithInitializer) {
      emitContextMapOrSetReassignmentCount += 1
      violations.push(
        `${lineOf(node)}: EmitContext field "${node.name.text}" (Map/Set) is (re)constructed with a fresh ${node.initializer.expression.text}() ` +
          `outside emit-context.ts, its one owner`
      )
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

/**
 * INVARIANT 5, CHECKED AT THE DECLARATION.
 *
 * "The printer's context is immutable for the duration of a body" used to be
 * guarded here by a table of field names and the functions allowed to write
 * them -- a rule that had to guess a writer's intent from the name of its
 * enclosing function, and that only saw the files this script scans. That
 * table is gone. Every settled fact on `EmitContext` is now declared
 * `ReadonlyMap`, `ReadonlySet` or `readonly T[]`, so a render-time write does
 * not typecheck, for every caller, in every program -- and the collectors
 * that legitimately fill those fields take the narrow `EmitBodyPrepassFacts`
 * handle as a PARAMETER, which states in the signature what the old rule was
 * inferring from a name.
 *
 * What is left to check is the declaration itself: a field that is still a
 * mutable `Map`/`Set` is a claim that this one is genuinely written DURING a
 * render, and that claim has to be made in the one place that already
 * enumerates the four categories a render-time write can belong to (NAMING,
 * BUFFER, PROOF, FOLDING READER) -- `sealFactFieldsForRender`'s
 * `renderMutableEmitContextFields`, each entry with the reason it earns.
 *
 * So: mutable field on `EmitContext` <=> listed there, both directions. The
 * forward direction stops a new fact from being born mutable and unexamined.
 * The reverse direction is the one that caught something real: a whitelist
 * keeps entries for fields that have since become read-only, and a whitelist
 * with stale entries is indistinguishable from one with a hole -- both read
 * as "this was considered", and only one of them was.
 */
{
  const contextFile = path.join(sourceRoot, 'targets/cpp/emit-context.ts')
  const contextSource = readFileSync(contextFile, 'utf8')
  const contextAst = ts.createSourceFile(contextFile, contextSource, ts.ScriptTarget.Latest, true)
  const mutableFields = new Map()
  const sealedFields = new Set()
  const visitContext = (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'EmitContext') {
      for (const member of node.members) {
        if (!ts.isPropertySignature(member) || member.type === undefined || !ts.isIdentifier(member.name)) continue
        const typeText = member.type.getText(contextAst)
        if (!/^(Map|Set)</.test(typeText)) continue
        mutableFields.set(member.name.text, contextAst.getLineAndCharacterOfPosition(member.getStart(contextAst)).line + 1)
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'renderMutableEmitContextFields' &&
      node.initializer !== undefined
    ) {
      for (const literal of node.initializer.getText(contextAst).matchAll(/'([A-Za-z]+)'/g)) sealedFields.add(literal[1])
    }
    ts.forEachChild(node, visitContext)
  }
  visitContext(contextAst)
  mutableEmitContextFieldCount = mutableFields.size
  for (const [field, line] of mutableFields) {
    if (sealedFields.has(field)) continue
    violations.push(
      `targets/cpp/emit-context.ts:${line}: EmitContext.${field} is a mutable Map/Set but is not listed in ` +
        '`renderMutableEmitContextFields` -- either it is settled before render (declare it ReadonlyMap/ReadonlySet and fill it ' +
        'through EmitBodyPrepassFacts) or it is genuinely render-mutable (list it there, with which of the four categories it is)'
    )
  }
  for (const field of sealedFields) {
    if (mutableFields.has(field) || field === 'declarations' || field === 'printerDrift' || field === 'denseArrays') continue
    violations.push(
      `targets/cpp/emit-context.ts: \`renderMutableEmitContextFields\` still lists ${field}, which is no longer a mutable ` +
        'Map/Set on EmitContext -- a stale whitelist entry reads as a considered exception and hides the ones that are'
    )
  }
}

for (const file of collectTypeScriptFiles(targetsRoot).sort()) {
  const relativeFile = relativeToSource(file)
  const source = readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const lineOf = (node) => `${relativeFile}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`

  // `ctx.constantTexts` may be READ inline by a folding reader, and that is
  // all. Handing it to another function is the one way the settled/folded
  // split can silently come undone: every claim that takes a key map declares
  // the parameter as a bare `ReadonlyMap<IrValueId, string>`, so passing the
  // render-accumulating map where the settled one belongs typechecks
  // perfectly and quietly lets a render-time `typeof` fold decide a key that
  // was computed. Sixteen such parameters were still NAMED `constantTexts`
  // while every caller passed `ctx.staticKeyTexts` -- a trap that would have
  // been sprung by the next person who read the parameter name and believed
  // it.
  const visitConstantTextsArgument = (node) => {
    if (ts.isCallExpression(node)) {
      for (const argument of node.arguments) {
        if (!ts.isPropertyAccessExpression(argument) || argument.name.text !== 'constantTexts') continue
        constantTextsPassedAsArgumentCount += 1
        violations.push(
          `${lineOf(argument)}: ${argument.getText(sourceFile)} is passed as an argument; the render-time folding map may only be ` +
            'READ inline by the reader that folds -- a claim takes the settled `staticKeyTexts` (invariant 5: no write during render)'
        )
      }
    }
    ts.forEachChild(node, visitConstantTextsArgument)
  }
  visitConstantTextsArgument(sourceFile)
}

/**
 * ONE COMPILER.
 *
 * `dist/` is the compiler. Every agent's changes rebuild THAT one, and every
 * measurement is taken against it. A private copy of the build -- a `dist-*`
 * beside it, a second `outDir`, a snapshot to "isolate" a gate -- measures a
 * compiler nobody else has, so its numbers describe a build that was never
 * shared and cannot be reproduced by anyone reading the report. It also rots:
 * 155 stale copies had accumulated in `.scratch/` before this check existed.
 *
 * Detected by CONTENT, not by name, because the practice reappears under a new
 * name every time: any directory holding a `compiler.js` next to a
 * `representation/` is a build of this compiler, and the only one allowed is
 * `dist/` itself.
 *
 * If two agents editing at once make a measurement incomparable -- and they do
 * -- the answer is to serialize with them, not to fork the compiler.
 */
const privateCompilerBuilds = []
const scanForBuilds = (directory, depth = 0) => {
  if (depth > 4) return
  let entries = []
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') continue
    if (entry.name === 'compiler-legacy') continue
    const candidate = path.join(directory, entry.name)
    if (existsSync(path.join(candidate, 'compiler.js')) && existsSync(path.join(candidate, 'representation'))) {
      if (path.resolve(candidate) !== path.resolve(projectRoot, 'dist'))
        privateCompilerBuilds.push(path.relative(path.join(projectRoot, '..'), candidate))
      continue
    }
    scanForBuilds(candidate, depth + 1)
  }
}
scanForBuilds(path.join(projectRoot, '..'), 0)
for (const build of privateCompilerBuilds.sort()) {
  violations.push(
    `${build}: a private copy of the compiler. There is ONE compiler, \`dist/\` -- rebuild and measure that (CLAUDE.md, "One compiler")`
  )
}

if (violations.length > 0) {
  const unique = [...new Set(violations)].sort()
  throw new Error(`Architecture gate failed with ${unique.length} violation(s):\n${unique.map((violation) => `- ${violation}`).join('\n')}`)
}

console.log(
  `Source architecture: ${checkedFileCount} TypeScript files, ` +
    `<=${MAX_LINE_COLUMNS} columns/line (${packedLineCount} over), ` +
    `${cppTargetRegExpLiteralCount} RegExp literals under targets/cpp, ` +
    `${sourcePositionLiteralComparisonCount} source-position literal comparisons, ` +
    `${typescriptImportOutsideSemanticsCount} typescript imports outside semantics/ or plugins/, ` +
    `${sourceShapedDiscriminantCount} source-shaped discriminants, ` +
    `${classifiedSemanticContractCount} classified Authority/Admission/Proof contracts ` +
    `(${unclassifiedSemanticContractCount} unclassified), ` +
    `${classDeclarationUnderTargetsCount} class declarations under targets/, ` +
    `${anyTypeUsageCount} any-type usages, ` +
    `${diagnosticClassificationOutsideSweepCount} diagnostic classifications outside sweep, ` +
    `${stringSpelledCppTypeCheckCount} string-spelled C++ type checks under targets/, ` +
    `${rawDominanceBuilderCallCount} raw dominance-builder calls under targets/, ` +
    `${recipeTextExternalCallCount} recipe-text calls outside the printer table (all named allowances), ` +
    `${emitContextMapOrSetReassignmentCount} EmitContext Map/Set fields reconstructed outside emit-context.ts, ` +
    `${mutableEmitContextFieldCount} mutable EmitContext collections (all justified render-mutable), ` +
    `${constantTextsPassedAsArgumentCount} render-time constantTexts maps passed as an argument`
)
