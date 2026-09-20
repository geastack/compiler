import ts from 'typescript'
import type { DeclarationId, OperationId } from '../../../identity/ids.js'
import { operationId, operationOfResult } from '../../../identity/ids.js'
import type { PrimitiveFamily } from '../../model/coverage.js'
import type { SemanticEdge } from '../../model/edges.js'
import type {
  AllocationOperation,
  BindingOperation,
  ClassLifecycleOperation,
  PropertyDescriptorShape,
  PropertyOperation,
  ReferenceOperation
} from '../../model/operations.js'
import type { CompletionBehavior, EffectBehavior, OperandSource, SemanticCaller, SemanticOperand } from '../../model/operands.js'
import { normalCompletion, pureEffects, throwingCompletion } from '../../model/operands.js'
import type { CensusCandidate } from '../census.js'
import { isParameterProperty } from '../census.js'
import { parameterBindingResultOf } from './bindings.js'
import type { CandidateContribution, FamilyProducer } from '../contribution.js'
import type { IdentityTable } from '../identities.js'
import type { ProducerContext } from '../producer-context.js'
import { parameterSlotTypeOf } from '../parameter-slot.js'
import { mintOperationId, mintResult, operand } from './mint.js'
import { resultOf } from '../../model/operands.js'
import {
  asBlocked,
  resultEdge,
  uniqueSymbolKeyTextOf,
  staticFunctionNameOf,
  staticClassNameOf,
  staticClassLengthOf,
  expectedParameterCountOf,
  ownPrototypePropertyOf
} from './shared.js'
import { citeExpressionResult } from './references.js'
import { physicalInitializerTypeOf } from '../structural-declarations.js'
import { transparentConstClassAliasTarget } from '../../class-alias.js'
import { inheritedAccessorOfAssignment } from '../../inherited-accessor.js'

const isStaticMember = (node: ts.ClassElement): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)

/**
 * Whether `node`'s heritage clause is present, and therefore whether
 * `bind-class-value` is this class's first or second minted operation.
 *
 * Member producers below need to reference the class's own `bind-class-value`
 * id from a *different* census candidate than the one that minted it (the class
 * declaration and its members are separate candidates). Recomputing the
 * identity-ordinal from this same rule -- rather than threading the id through
 * shared state -- keeps the two sides of that reference from drifting apart.
 * This is `context.ordinals`' per-(node,family) mint count, unrelated to the
 * `evaluationOrdinal` data field, which comes from `context.evaluationOrdinals`.
 */
const hasExtendsClause = (classNode: ts.ClassLikeDeclaration): boolean =>
  (classNode.heritageClauses ?? []).some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)

const bindClassValueOperationId = (identities: IdentityTable, classNode: ts.ClassLikeDeclaration): OperationId =>
  operationId(identities.nodeIdOf(classNode), 'class-lifecycle', hasExtendsClause(classNode) ? 1 : 0)

/** The class whose body lexically contains `node`, stopping before an outer class can claim a nested one's member. */
const containingClassOf = (node: ts.Node): ts.ClassLikeDeclaration | null => {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isClassLike(current)) return current
  }
  return null
}

/**
 * The `this.key` access ONE JavaScript class member's own value declaration
 * names -- for both spellings TypeScript's JS class inference accepts.
 *
 * `this.key = value` declares through the assignment. A JSDoc-typed statement
 * `/** @type {T} *\/ this.key;` declares through the access alone: the checker
 * publishes one property symbol either way, the second carrying the type the
 * program STATED rather than one inferred from a store, and its value
 * declaration is the bare access rather than a `BinaryExpression`. Reading
 * only the assignment spelling left the second one's member fully typed at
 * every read while the class layout had no `define-field` event for it --
 * exactly the "typed but no storage event" hole this census exists to close,
 * one spelling further along, and the reason a descriptor-defined field's
 * definition could not tell whether it was CREATING the property or
 * redefining one that already existed.
 *
 * The declaration-only spelling installs no property of its own: the statement
 * is a read. It is admitted only as a statement of its own, never as a larger
 * expression's operand, which would be an ordinary read.
 */
const declaredThisAccessOf = (declaration: ts.Declaration): ts.PropertyAccessExpression | ts.ElementAccessExpression | null => {
  const access = ts.isBinaryExpression(declaration)
    ? declaration.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ? declaration.left
      : null
    : ts.isExpressionStatement(declaration.parent)
      ? (declaration as ts.Node)
      : null
  if (access === null) return null
  if (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) return null
  return access.expression.kind === ts.SyntaxKind.ThisKeyword ? access : null
}

/**
 * A JavaScript class field TypeScript inferred from a `this.key` declaration.
 *
 * JavaScript has no `PropertyDeclaration` node for this idiom. The checker does
 * still publish one property symbol for it, whose declarations are the assignment
 * expressions themselves, and `field-bindings.ts` already uses that same fact to
 * derive the slot's type. Class projection used to read only explicit declaration
 * events, so a field could be fully typed at every access while the C++ struct had
 * no storage for it. The symbol's value declaration identifies the class that owns
 * the slot; later writes in subclasses or methods must not redeclare it there.
 */
const inferredJavaScriptFieldsOf = (
  checker: ts.TypeChecker,
  classNode: ts.ClassDeclaration
): readonly { readonly name: string; readonly declaration: ts.Declaration; readonly access: ts.Expression }[] => {
  const instance = checker.getTypeAtLocation(classNode)
  const fields: { name: string; declaration: ts.Declaration; access: ts.Expression }[] = []
  for (const symbol of checker.getPropertiesOfType(instance)) {
    if (inheritedAccessorOfAssignment(checker, symbol)) continue
    const declaration = symbol.valueDeclaration
    if (!declaration) continue
    const access = declaredThisAccessOf(declaration)
    if (access === null) continue
    if (containingClassOf(declaration) !== classNode) continue
    const name = ts.isPropertyAccessExpression(access)
      ? access.name.text
      : ts.isStringLiteralLike(access.argumentExpression)
        ? access.argumentExpression.text
        : null
    if (name !== null) fields.push({ name, declaration, access })
  }
  return fields
}

export const createClassLifecycleProducer = (context: ProducerContext): FamilyProducer => {
  const voidType = context.table.intern({ kind: 'primitive', primitive: 'void' })

  const buildOperation = (
    id: OperationId,
    caller: SemanticCaller,
    evaluationOrdinal: number,
    event: ClassLifecycleOperation['event'],
    declaration: DeclarationId,
    classDeclaration: DeclarationId,
    descriptor: PropertyDescriptorShape | null,
    placement: ClassLifecycleOperation['placement'],
    operands: readonly SemanticOperand[],
    completion: CompletionBehavior,
    effects: EffectBehavior
  ): ClassLifecycleOperation => ({
    id,
    caller,
    operands,
    results: [mintResult(id, 'completion', voidType)],
    completion,
    effects,
    evaluationOrdinal,
    family: 'class-lifecycle',
    event,
    declaration,
    classDeclaration,
    descriptor,
    placement
  })

  const staticKeyType = context.table.intern({ kind: 'primitive', primitive: 'string' })

  /**
   * A member's key operand.
   *
   * A written name is a constant, exactly as a property access carries one --
   * the key is part of the definition, and leaving it out means every consumer
   * has to recover which member was defined from the declaration node, which is
   * the syntax walk this graph exists to replace. A computed name is cited from
   * whichever family normalized the bracketed expression.
   */
  const keyOperand = (name: ts.PropertyName): { readonly operands: readonly SemanticOperand[] } | { readonly blocked: string } => {
    if (ts.isComputedPropertyName(name)) {
      // A `unique symbol` name declares a member with a compile-time identity
      // -- `class C { [S]: T }` is as much a declared member as `class C { x: T
      // }`, and `keyof C` includes it. Publishing it as a *constant* key is
      // what puts it in the class layout at all: `projection/classes.ts`
      // deliberately skips a `define-field` whose key is not constant, so
      // before this the field was dropped from the struct and every
      // `this[S]` read had no member to find. `properties.ts` resolves the
      // read's key through the same `uniqueSymbolKeyTextOf`, so the two
      // sides name one member.
      const symbolKey = uniqueSymbolKeyTextOf(context, context.types.typeAt(name.expression))
      if (symbolKey !== null) {
        return { operands: [operand('key', 0, { kind: 'constant', text: symbolKey, literal: 'string' }, staticKeyType)] }
      }
      const cited = citeExpressionResult(name.expression, context)
      if (cited.kind === 'unmodelled') return { blocked: cited.reason }
      return { operands: [operand('key', 0, cited.source, context.types.typeAt(name.expression))] }
    }
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
      return { operands: [operand('key', 0, { kind: 'constant', text: name.text, literal: 'string' }, staticKeyType)] }
    }
    // `#x` is not a property key in the language's sense -- it resolves against
    // the class's private scope and `[[DefineOwnProperty]]` never sees it --
    // but it *is* a member of a fixed layout, and the layout is what this
    // operand feeds. `projection/classes.ts` skips any `define-field` whose key
    // is not constant, so publishing nothing here dropped the member's
    // initializer while `representation/object-shape.ts` (which reads the
    // checker's own member list, where a private name appears exactly like any
    // other) had already given the struct a field for it: `#count = 5` emitted
    // a struct member that was never written, and the value was silently the
    // C++ zero rather than the initializer's.
    //
    // The key is the private name's own text, `#` included, which is precisely
    // the spelling the checker reports for the member and therefore the
    // spelling the layout already uses -- so the definition here and a
    // `this.#count` read (`properties.ts`) name one member without either side
    // inventing a mangling. `types.ts` escapes it into a legal C++ member name
    // exactly as it escapes any other non-identifier key. Two classes each
    // declaring `#x` do not collide: each has its own layout.
    if (ts.isPrivateIdentifier(name)) {
      return { operands: [operand('key', 0, { kind: 'constant', text: name.text, literal: 'string' }, staticKeyType)] }
    }
    return { operands: [] }
  }

  /**
   * The function object a class evaluation step creates.
   *
   * `DefineMethod` performs `OrdinaryFunctionCreate` before it defines
   * anything, and `ClassDefinitionEvaluation` creates the constructor function
   * object before binding the class name -- so these really are allocations,
   * and publishing them under the allocation family is what gives each body a
   * calling convention. Without them a method is a body nobody allocated: the
   * ABI projection finds no callable carrier and refuses the whole function.
   *
   * The census routes these nodes to `class-lifecycle` alone, so no other
   * producer mints an allocation at this identity.
   */
  // A class method/accessor is the only shape `contributeMethod` ever passes
  // as `callable` here (the class-constructor-object allocation passes
  // `null`, and reads its own `[[Name]]`/`length` through the unrelated
  // `CallableConstructorObject` carrier this producer does not touch), so a
  // simple type guard is exhaustive rather than a partial one that silently
  // drops a shape it should have named.
  const isNamedCallableMember = (
    declaration: ts.Declaration
  ): declaration is ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration =>
    ts.isMethodDeclaration(declaration) || ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration)

  const allocateFunctionObject = (
    candidate: CensusCandidate,
    node: ts.Declaration,
    allocated: 'function-object' | 'class-constructor-object',
    callable: ts.Declaration | null
  ): AllocationOperation => {
    const id = mintOperationId(context.ordinals, candidate.id, 'allocation')
    const shape = context.types.valueTypeAt(node)
    return {
      id,
      family: 'allocation',
      allocated,
      shape,
      callable: callable ? context.identities.functionIdOf(callable) : null,
      ...(callable
        ? {
            functionSource: callable.getText(),
            generatorFunction: 'asteriskToken' in callable && callable.asteriskToken !== undefined,
            ...(ownPrototypePropertyOf(callable) === null ? {} : { ownPrototypeProperty: ownPrototypePropertyOf(callable) === true }),
            ...(isNamedCallableMember(callable)
              ? { functionName: staticFunctionNameOf(callable), functionLength: expectedParameterCountOf(callable) }
              : {})
          }
        : {}),
      // A class's constructor object states the class it belongs to and its
      // `[[Name]]`, the way a function allocation states `functionName` --
      // `C.name` is read off this, and a memberless class expression has no
      // other event to prove it was evaluated (`preflight/property-access.ts`).
      ...(allocated === 'class-constructor-object' && ts.isClassLike(node)
        ? {
            classDeclaration: context.identities.declarationIdOf(node),
            functionName: staticClassNameOf(node),
            functionLength: staticClassLengthOf(node)
          }
        : {}),
      caller: candidate.caller,
      operands: [],
      results: [mintResult(id, 'value', shape)],
      completion: normalCompletion,
      effects: { ...pureEffects, allocates: true },
      evaluationOrdinal: candidate.evaluationOrdinal
    }
  }

  /** The one constructor declaration that owns a body -- an overload set's implementation, never a bodiless overload. */
  const writtenConstructorOf = (node: ts.ClassLikeDeclaration): ts.ConstructorDeclaration | undefined =>
    node.members.find((member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member) && member.body !== undefined)

  /**
   * The written constructor's callable allocation, shared by the declaration
   * and expression forms of a class: `[[Construct]]` enters the same body
   * either way, and an expression that published no convention for it was
   * refused at ABI projection ("no function-object allocation published a
   * callable carrier") the moment its constructor read `this`.
   */
  const writtenConstructorAllocationOf = (candidate: CensusCandidate, node: ts.ClassLikeDeclaration): AllocationOperation | null => {
    // The written constructor's own body convention: the instance as receiver,
    // the declared parameters, and no result. `[[Construct]]` returns the
    // instance it was given, never the body's completion value, so a body
    // compiled to return one would be returning something the language discards.
    // An overloaded class carries several ConstructorDeclarations, but only
    // the implementation owns an executable body and frame. Selecting the
    // first declaration binds the callable allocation to a bodyless overload
    // (`constructor();`) while every parameter/body operation is owned by the
    // later implementation's FunctionId. The ABI projection then correctly
    // finds no allocation for that real body. A class with no bodyful
    // constructor has no constructor body to allocate here.
    const written = writtenConstructorOf(node)
    if (!written) return null
    {
      const shape = context.table.intern({
        kind: 'signature',
        call: [
          {
            parameters: written.parameters.map((parameter) => {
              const flags = {
                optional: parameter.questionToken !== undefined,
                rest: parameter.dotDotDotToken !== undefined,
                hasInitializer: parameter.initializer !== undefined
              }
              const type = context.types.typeAt(parameter)
              // Widen the census-aware type itself. A defaulted parameter's
              // physical slot always admits `undefined`, including when the
              // census replaced the checker's initializer-derived `{}` with
              // the record its call sites actually pass. Leaving that replaced
              // type unwidened makes the constructor ABI require the record
              // while `contributeDefaultedParameter` correctly reads an
              // optional raw argument, so the body and its callable allocation
              // publish different frames and ABI projection must refuse them.
              return {
                type,
                slot: parameterSlotTypeOf(
                  (members) => context.table.intern({ kind: 'union', members }),
                  context.types.typeOf(context.checker.getUndefinedType()),
                  flags,
                  type
                ),
                ...flags
              }
            }),
            minimumArity: written.parameters.filter((parameter) => !parameter.questionToken && !parameter.initializer).length,
            thisParameter: context.types.instanceTypeAt(node),
            result: voidType
          }
        ],
        construct: []
      })
      const id = mintOperationId(context.ordinals, candidate.id, 'allocation')
      return {
        id,
        family: 'allocation',
        allocated: 'function-object',
        shape,
        callable: context.identities.functionIdOf(written),
        classConstructorBodyOf: context.identities.declarationIdOf(node),
        functionSource: written.getText(),
        generatorFunction: 'asteriskToken' in written && written.asteriskToken !== undefined,
        ...(ownPrototypePropertyOf(written) === null ? {} : { ownPrototypeProperty: ownPrototypePropertyOf(written) === true }),
        caller: candidate.caller,
        operands: [],
        results: [mintResult(id, 'value', shape)],
        completion: normalCompletion,
        effects: { ...pureEffects, allocates: true },
        evaluationOrdinal: candidate.evaluationOrdinal
      }
    }
  }

  const contributeClass = (candidate: CensusCandidate, node: ts.ClassDeclaration): CandidateContribution => {
    const source = candidate.id
    const declaration = context.identities.declarationIdOf(node)
    const operations: (AllocationOperation | BindingOperation | ClassLifecycleOperation)[] = []
    const edges: SemanticEdge[] = []

    const heritageExpression = node.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression
    let heritageOperation: ClassLifecycleOperation | null = null
    if (heritageExpression) {
      const evaluatedHeritage = transparentConstClassAliasTarget(context.checker, heritageExpression) ?? heritageExpression
      let heritageSource: OperandSource = { kind: 'absent' }
      if (!candidate.classLayoutOnly) {
        const cited = citeExpressionResult(evaluatedHeritage, context)
        if (cited.kind === 'unmodelled') {
          return asBlocked(candidate.id, 'class-lifecycle', `class heritage expression ${cited.reason}`, null)
        }
        heritageSource = cited.source
      }
      const id = mintOperationId(context.ordinals, source, 'class-lifecycle')
      // `ClassHeritage : extends LeftHandSideExpression` throws a TypeError when
      // the evaluated value is neither a constructor nor null.
      heritageOperation = buildOperation(
        id,
        candidate.caller,
        context.evaluationOrdinals.next(candidate.caller),
        'evaluate-heritage',
        declaration,
        declaration,
        null,
        null,
        [operand('heritage', 0, heritageSource, context.types.typeAt(evaluatedHeritage))],
        candidate.classLayoutOnly ? normalCompletion : throwingCompletion,
        candidate.classLayoutOnly
          ? pureEffects
          : { readsMutableState: true, writesMutableState: false, allocates: false, callsUserCode: false }
      )
      if (candidate.classLayoutOnly) heritageOperation = { ...heritageOperation, classLayoutOnly: true }
      operations.push(heritageOperation)
      const heritageValueEdge = resultEdge(heritageSource, id, 'heritage', 0)
      if (heritageValueEdge) edges.push(heritageValueEdge)
    }

    // The class binding and its member definitions refer to the evaluated
    // constructor object. The allocation below must precede this event, after
    // heritage resolves, so a static initializer uses that same prototype
    // owner rather than inventing a second constructor evaluation.
    const bindId = mintOperationId(context.ordinals, source, 'class-lifecycle')
    const bindOperation: ClassLifecycleOperation = {
      ...buildOperation(
        bindId,
        candidate.caller,
        candidate.evaluationOrdinal,
        'bind-class-value',
        declaration,
        declaration,
        null,
        null,
        candidate.classLayoutOnly ? [operand('instance-layout', 0, { kind: 'absent' }, context.types.instanceTypeAt(node))] : [],
        normalCompletion,
        candidate.classLayoutOnly
          ? pureEffects
          : {
              readsMutableState: false,
              writesMutableState: true,
              allocates: true,
              callsUserCode: false
            }
      ),
      ...(candidate.classLayoutOnly ? { classLayoutOnly: true } : {})
    }
    operations.push(bindOperation)
    if (heritageOperation) edges.push({ kind: 'evaluation', from: heritageOperation.id, to: bindOperation.id })

    // The constructor function object, and the binding the class name holds.
    // `ClassDefinitionEvaluation` creates the one and initializes the other,
    // and both have to be published: without the allocation `new C()` has no
    // convention to construct through, and without the binding every `new C()`
    // reads a cell nothing in the program ever introduced.
    //
    // The allocation names no callable. `[[Construct]]` and the constructor
    // *body* are two conventions -- one takes the arguments and returns an
    // instance, the other takes the instance and returns nothing -- and giving
    // the body the construct signature would compile it to return a value it
    // never produces.
    const constructorObject = candidate.classLayoutOnly ? null : allocateFunctionObject(candidate, node, 'class-constructor-object', null)
    if (constructorObject) {
      operations.push(constructorObject)
      if (heritageOperation) edges.push({ kind: 'evaluation', from: heritageOperation.id, to: constructorObject.id })
      edges.push({ kind: 'evaluation', from: constructorObject.id, to: bindOperation.id })
    }

    const classValue = constructorObject ? resultOf(constructorObject, 'value') : null
    if (classValue && constructorObject) {
      const nameId = mintOperationId(context.ordinals, source, 'binding')
      const nameBinding: BindingOperation = {
        id: nameId,
        family: 'binding',
        action: 'initialize',
        declaration,
        // A class binding is `const`-like inside its own body and let-like
        // outside; the observable half is the dead zone before evaluation.
        mutable: false,
        temporalDeadZone: true,
        caller: candidate.caller,
        operands: [operand('initializer', 0, { kind: 'result', result: classValue.id }, constructorObject.shape)],
        results: [mintResult(nameId, 'value', constructorObject.shape)],
        completion: normalCompletion,
        effects: { ...pureEffects, writesMutableState: true },
        evaluationOrdinal: candidate.evaluationOrdinal
      }
      operations.push(nameBinding)
      edges.push({ kind: 'value', result: classValue.id, to: nameId, role: 'initializer', ordinal: 0 })
    }

    const written = writtenConstructorOf(node)
    const writtenConstructor = candidate.classLayoutOnly ? null : writtenConstructorAllocationOf(candidate, node)
    if (writtenConstructor) operations.push(writtenConstructor)

    // A parameter property is two declarations written as one:
    // `constructor(readonly name: string)` declares the formal AND an instance
    // member the constructor assigns it into. This is the member half -- the
    // same `define-field` an ordinary field declaration publishes, with no
    // initializer operand, because the value does not come from an initializer
    // at all. It comes from the argument, and the store that writes it is
    // minted from the parameter's OWN candidate (`contributeParameterProperty`
    // below), whose caller is the constructor rather than this class
    // evaluation -- which is exactly where the language runs it.
    //
    // Published here rather than from that candidate because a `define-field`
    // is class evaluation: it runs once, in the class's own caller, and
    // `projection/classes.ts` reads it into the layout every construction and
    // every `this.name` lookup consults.
    for (const parameter of written?.parameters ?? []) {
      if (!isParameterProperty(parameter)) continue
      if (!ts.isIdentifier(parameter.name)) {
        return asBlocked(
          candidate.id,
          'class-lifecycle',
          'a parameter property named by a destructuring pattern declares no single member for the class layout to hold',
          'P1'
        )
      }
      const fieldId = mintOperationId(context.ordinals, source, 'class-lifecycle')
      operations.push(
        buildOperation(
          fieldId,
          candidate.caller,
          context.evaluationOrdinals.next(candidate.caller),
          'define-field',
          context.identities.declarationIdOf(parameter),
          declaration,
          { writable: true, enumerable: true, configurable: true },
          'own',
          [operand('key', 0, { kind: 'constant', text: parameter.name.text, literal: 'string' }, staticKeyType)],
          normalCompletion,
          { readsMutableState: false, writesMutableState: true, allocates: false, callsUserCode: false }
        )
      )
      edges.push({ kind: 'evaluation', from: bindOperation.id, to: fieldId })
    }

    // `this.x = value` in a JavaScript class declares an instance member to
    // TypeScript without creating a PropertyDeclaration in the AST. Publish
    // the same layout event an explicit `x;` field would publish, but no field
    // initializer: the ordinary property store in the constructor remains the
    // one runtime initialization, so this event contributes storage only.
    for (const field of inferredJavaScriptFieldsOf(context.checker, node)) {
      const fieldId = mintOperationId(context.ordinals, source, 'class-lifecycle')
      operations.push(
        buildOperation(
          fieldId,
          candidate.caller,
          context.evaluationOrdinals.next(candidate.caller),
          'define-field',
          context.identities.declarationIdOf(field.declaration),
          declaration,
          { writable: true, enumerable: true, configurable: true },
          'own',
          [
            operand('key', 0, { kind: 'constant', text: field.name, literal: 'string' }, staticKeyType),
            operand('field-storage', 0, { kind: 'absent' }, context.types.typeAt(field.access))
          ],
          normalCompletion,
          { readsMutableState: false, writesMutableState: true, allocates: false, callsUserCode: false }
        )
      )
      edges.push({ kind: 'evaluation', from: bindOperation.id, to: fieldId })
    }

    return { kind: 'operations', operations, edges }
  }

  /**
   * The `super(...)` a constructor runs, when it is a statement of its own body.
   *
   * Only a top-level one is answered. A parameter property's store has to run
   * AFTER the base is initialized -- that is the order the language states, and
   * it is the order in which a base constructor calling an overridden method
   * sees the derived object -- and ordering it needs an operation to order it
   * against. A `super()` nested inside an `if` is a different question: the
   * store is unconditional and the call is not, so the precedence would reach
   * across a branch. That shape is refused by name rather than ordered wrongly.
   */
  const topLevelSuperCallOf = (constructorNode: ts.ConstructorDeclaration): ts.CallExpression | null => {
    for (const statement of constructorNode.body?.statements ?? []) {
      if (!ts.isExpressionStatement(statement)) continue
      const call = statement.expression
      if (ts.isCallExpression(call) && call.expression.kind === ts.SyntaxKind.SuperKeyword) return call
    }
    return null
  }

  /**
   * `constructor(readonly name: string)`: the store, in the constructor.
   *
   * The member itself is declared by the `define-field` `contributeClass`
   * publishes above. What is left is the assignment TypeScript writes at the
   * top of the constructor body -- and it belongs to the constructor's own
   * caller, which is why it is minted from this candidate: `callerOf` walks
   * from the parameter's parent, and that parent is the constructor.
   *
   * The receiver is a `reference`/`this` of this producer's own, exactly the
   * shape `references.ts` mints for a written `this` -- because every stage
   * after normalization asks its questions of a published RESULT: the plan
   * selects a carrier per result, and `preflight/carrier-kind.ts` reads the
   * receiver's carrier off `plan.selected`. Citing the frame's
   * `{kind: 'receiver'}` provenance directly instead was measured and does not
   * work: it has no result, so the receiver's carrier reads as `constant` and
   * the site asks for a `property-access:constant:set:false` recipe no target
   * has.
   *
   * It is minted at the CONSTRUCTOR's node rather than the parameter's. At the
   * parameter's it would take the `reference` ordinal `bindings.ts`'s
   * `parameterValueResultOf` predicts for a DEFAULTED parameter, so
   * `constructor(readonly n = 5)` would have its default guard testing this
   * operation instead of the raw argument -- a silent miscompile resting on
   * which producer happened to run first. Nothing else mints a `reference` at a
   * `ConstructorDeclaration`, and each store cites the result it minted itself.
   *
   * The value is the parameter's BINDING, not its raw slot: a defaulted
   * parameter property stores the default when the caller passed nothing.
   */
  const contributeParameterProperty = (candidate: CensusCandidate, node: ts.ParameterDeclaration): CandidateContribution => {
    const constructorNode = node.parent
    if (!ts.isConstructorDeclaration(constructorNode) || !ts.isClassLike(constructorNode.parent)) {
      return asBlocked(candidate.id, 'class-lifecycle', 'a parameter property outside a class constructor is not modelled', 'P1')
    }
    if (!ts.isIdentifier(node.name)) {
      return asBlocked(
        candidate.id,
        'class-lifecycle',
        'a parameter property named by a destructuring pattern declares no single member to store into',
        'P1'
      )
    }
    const classNode = constructorNode.parent
    // The member half is published by `contributeClass`, and only a class
    // DECLARATION reaches it -- a class expression's own evaluation is minted
    // by the allocation family, which has no candidate for this parameter.
    // Emitting the store without the `define-field` would write into a member
    // the layout does not declare, so the whole parameter property is refused
    // by name instead of half-modelled.
    if (!ts.isClassDeclaration(classNode)) {
      return asBlocked(
        candidate.id,
        'class-lifecycle',
        'a parameter property of a class EXPRESSION publishes no "define-field": only a class declaration mints one, and a ' +
          'store with no member declared is a write into a layout nothing states',
        'P1'
      )
    }
    const superCall = topLevelSuperCallOf(constructorNode)
    if (hasExtendsClause(classNode) && superCall === null) {
      return asBlocked(
        candidate.id,
        'class-lifecycle',
        "a parameter property in a derived class whose `super(...)` is not a statement of the constructor's own body has " +
          'nothing unconditional to order its store after',
        'P1'
      )
    }

    const receiverType = context.types.instanceTypeAt(classNode)
    const valueType = context.types.typeAt(node)
    const bound = parameterBindingResultOf(node, context.identities)

    const receiverId = mintOperationId(context.ordinals, context.identities.nodeIdOf(constructorNode), 'reference')
    const receiverResult = mintResult(receiverId, 'value', receiverType)
    const receiver: ReferenceOperation = {
      id: receiverId,
      family: 'reference',
      form: 'this',
      strict: true,
      unresolvableThrows: false,
      hasNoCell: false,
      caller: candidate.caller,
      // Supplied by the frame the caller established, so it is recorded as
      // provenance rather than as a runtime step -- the same operand
      // `references.ts`'s `buildThisReference` gives a written `this`.
      operands: [operand('receiver', 0, { kind: 'receiver' }, receiverType, { kind: 'provenance' })],
      results: [receiverResult],
      completion: normalCompletion,
      effects: { ...pureEffects, readsMutableState: true },
      evaluationOrdinal: candidate.evaluationOrdinal
    }

    const storeId = mintOperationId(context.ordinals, candidate.id, 'property')
    const store: PropertyOperation = {
      id: storeId,
      family: 'property',
      internalMethod: 'set',
      strict: true,
      keyIsComputed: false,
      // `[[Set]]` consults whatever descriptor the definition installed; it
      // states none of its own, exactly as every other store does.
      descriptor: null,
      caller: candidate.caller,
      operands: [
        operand('receiver', 0, { kind: 'result', result: receiverResult.id }, receiverType),
        operand('key', 0, { kind: 'constant', text: node.name.text, literal: 'string' }, staticKeyType),
        operand('value', 0, { kind: 'result', result: bound }, valueType)
      ],
      results: [mintResult(storeId, 'value', receiverType)],
      completion: normalCompletion,
      effects: { readsMutableState: false, writesMutableState: true, allocates: false, callsUserCode: false },
      evaluationOrdinal: candidate.evaluationOrdinal
    }
    const edges: SemanticEdge[] = [
      { kind: 'value', result: receiverResult.id, to: storeId, role: 'receiver', ordinal: 0 },
      { kind: 'value', result: bound, to: storeId, role: 'value', ordinal: 0 }
    ]
    // After EVERY parameter of this constructor is bound, not just this one.
    // `FunctionDeclarationInstantiation` binds the whole parameter list --
    // running each default initializer -- before the body's first statement,
    // and these stores are body statements. Without this,
    // `constructor(readonly a = f(), readonly b = g())` stored `a` between
    // `f()` and `g()` instead of after both, which `g()` can observe.
    for (const sibling of constructorNode.parameters) {
      if (sibling === node || (ts.isIdentifier(sibling.name) && sibling.name.text === 'this')) continue
      edges.push({ kind: 'evaluation', from: operationId(context.identities.nodeIdOf(sibling), 'binding', 0), to: storeId })
    }
    // And after the base is initialized: a base constructor that calls an
    // overridden method must not see a member this class has already written.
    if (superCall) {
      edges.push({ kind: 'evaluation', from: operationId(context.identities.nodeIdOf(superCall), 'invocation', 0), to: storeId })
    }
    return { kind: 'operations', operations: [receiver, store], edges }
  }

  /** Shared prelude for a class-element candidate: locate it among its siblings. */
  const memberContext = (
    candidate: CensusCandidate,
    node: ts.ClassElement
  ): { readonly classNode: ts.ClassLikeDeclaration; readonly ready: OperationId } | CandidateContribution => {
    const classNode = node.parent
    if (!ts.isClassLike(classNode)) {
      return asBlocked(
        candidate.id,
        'class-lifecycle',
        'class element with no class-like parent is not modelled',
        'P6' satisfies PrimitiveFamily
      )
    }
    if (ts.isClassDeclaration(classNode)) return { classNode, ready: bindClassValueOperationId(context.identities, classNode) }
    const constructor = citeExpressionResult(classNode, context)
    if (constructor.kind === 'unmodelled' || constructor.source.kind !== 'result') {
      return asBlocked(candidate.id, 'class-lifecycle', 'class member definition has no evaluated constructor object', 'P6')
    }
    return { classNode, ready: operationOfResult(constructor.source.result) }
  }

  const contributeMethodOrAccessor = (
    candidate: CensusCandidate,
    node: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration
  ): CandidateContribution => {
    const located = memberContext(candidate, node)
    if ('kind' in located) return located
    const { classNode, ready } = located

    const resolvedKey = keyOperand(node.name)
    if ('blocked' in resolvedKey) {
      return asBlocked(candidate.id, 'class-lifecycle', `computed method/accessor name ${resolvedKey.blocked}`, 'P1')
    }
    const keyOperands: readonly SemanticOperand[] = resolvedKey.operands
    const keySource: OperandSource | null = ts.isComputedPropertyName(node.name) ? (keyOperands[0]?.source ?? null) : null

    const source = candidate.id
    const declaration = context.identities.declarationIdOf(node)
    const classId = context.identities.declarationIdOf(classNode)
    const isPrivate = ts.isPrivateIdentifier(node.name)
    const placement = isStaticMember(node) ? 'static' : 'prototype'
    const event = ts.isMethodDeclaration(node) ? 'define-method' : ts.isGetAccessorDeclaration(node) ? 'define-getter' : 'define-setter'
    // Private methods/accessors become PrivateElement records, not ordinary
    // properties: no [[DefineOwnProperty]] happens, so there is no descriptor.
    // An accessor descriptor has no [[Writable]] slot at all; `false` is the
    // closest the fixed `PropertyDescriptorShape` (data-descriptor shaped) can
    // state, since it cannot distinguish get/set descriptors from data ones.
    const descriptor: PropertyDescriptorShape | null = isPrivate
      ? null
      : { writable: event === 'define-method', enumerable: false, configurable: true }

    const operations: (AllocationOperation | ClassLifecycleOperation)[] = []
    const edges: SemanticEdge[] = []

    // `DefineMethod` creates the function object first; the definition that
    // follows installs it. Two operations, because they are two steps, and
    // because only the first states the convention the body is compiled to.
    // An `abstract` member has no body, so there is no function object to
    // create: what it publishes is the DECLARATION alone -- the key this class
    // states and every concrete subclass must fill. `projection/classes.ts`
    // already models a method whose callable is absent, and the dispatch
    // family reads exactly that to root itself on the abstract class.
    const methodObject = node.body === undefined ? null : allocateFunctionObject(candidate, node, 'function-object', node)
    if (methodObject) operations.push(methodObject)
    const methodValue = methodObject ? resultOf(methodObject, 'value') : null
    const methodStorage = ts.isMethodDeclaration(node) && placement === 'prototype' ? context.types.mutableMethodStorageTypeAt(node) : null
    const methodOperands =
      methodValue && methodObject
        ? [
            ...keyOperands,
            operand('method', 0, { kind: 'result', result: methodValue.id }, methodObject.shape),
            ...(methodStorage === null ? [] : [operand('method-storage', 0, { kind: 'absent' }, methodStorage)])
          ]
        : [...keyOperands, ...(methodStorage === null ? [] : [operand('method-storage', 0, { kind: 'absent' }, methodStorage)])]

    const defineId = mintOperationId(context.ordinals, source, 'class-lifecycle')
    const defineOperation = buildOperation(
      defineId,
      candidate.caller,
      candidate.evaluationOrdinal,
      event,
      declaration,
      classId,
      descriptor,
      placement,
      methodOperands,
      normalCompletion,
      {
        readsMutableState: false,
        writesMutableState: true,
        allocates: true,
        callsUserCode: false
      }
    )
    operations.push(defineOperation)
    if (methodValue) edges.push({ kind: 'value', result: methodValue.id, to: defineId, role: 'method', ordinal: 0 })
    if (keySource) {
      const keyEdge = resultEdge(keySource, defineId, 'key', 0)
      if (keyEdge) edges.push(keyEdge)
    }

    edges.push({ kind: 'evaluation', from: ready, to: defineOperation.id })

    if (isPrivate) {
      const brandId = mintOperationId(context.ordinals, source, 'class-lifecycle')
      const brandOperation = buildOperation(
        brandId,
        candidate.caller,
        candidate.evaluationOrdinal,
        'install-private-brand',
        declaration,
        classId,
        null,
        null,
        [],
        normalCompletion,
        {
          readsMutableState: false,
          writesMutableState: true,
          allocates: false,
          callsUserCode: false
        }
      )
      operations.push(brandOperation)
      edges.push({ kind: 'evaluation', from: defineOperation.id, to: brandOperation.id })
    }

    return { kind: 'operations', operations, edges }
  }

  const contributeField = (candidate: CensusCandidate, node: ts.PropertyDeclaration): CandidateContribution => {
    const located = memberContext(candidate, node)
    if ('kind' in located) return located
    const { classNode, ready } = located

    const resolvedKey = keyOperand(node.name)
    if ('blocked' in resolvedKey) return asBlocked(candidate.id, 'class-lifecycle', `computed field name ${resolvedKey.blocked}`, 'P1')
    const keyOperands: readonly SemanticOperand[] = resolvedKey.operands
    const keySource: OperandSource | null = ts.isComputedPropertyName(node.name) ? (keyOperands[0]?.source ?? null) : null

    const source = candidate.id
    const declaration = context.identities.declarationIdOf(node)
    const classId = context.identities.declarationIdOf(classNode)
    const isPrivate = ts.isPrivateIdentifier(node.name)
    const isStatic = isStaticMember(node)
    // A field is installed via CreateDataPropertyOrThrow: writable, enumerable,
    // and configurable are all true by construction (15.7.10/15.7.14), unlike a
    // method's non-enumerable descriptor. A static field's placement is on the
    // constructor object itself, never the prototype.
    const descriptor: PropertyDescriptorShape | null = isPrivate ? null : { writable: true, enumerable: true, configurable: true }

    const operations: (AllocationOperation | ClassLifecycleOperation)[] = []
    const edges: SemanticEdge[] = []

    // The initializer is a function: `ClassFieldDefinition` creates one and
    // calls it once per construction with the instance as receiver. Allocating
    // it here is what states that convention -- the body's own `this` reads the
    // receiver this signature declares, and the construction site knows what to
    // call. A field with no initializer creates none, which is why the operand
    // is absent rather than a function that returns undefined.
    let initializerObject: AllocationOperation | null = null
    // A field initialized with a GENERIC function literal the program never
    // instantiates -- hono's `redirect = <T extends RedirectStatusCode = 302>(
    // location, status?) => ...` in a program that never calls `c.redirect` --
    // is a body `census.ts` walks not at all ("there is no such function in
    // this program"), the same rule `declaration-lifecycle.ts`'s
    // `namesUninstantiatedGeneric` applies to an import of one. Stating an
    // initializer here anyway minted a thunk over an empty region: its return
    // carried no value, the emitter spelled that as the `never` trap it is
    // for a `return fail()`, and every `new Context(...)` threw before hono's
    // handler ran. The field is recorded exactly as one declared with no
    // initializer -- the only reads that could tell the difference are
    // dynamic ones, and an uninstantiated generic has no value in this
    // program for them to see either. A generic literal the program DOES
    // call (`json: JSONRespond = <T, U>(...) => ...`) has copies, and keeps
    // its initializer: `specialization.ts`'s `implementationOfCallee` is
    // what gives it those copies through the field's declared signature.
    const uninstantiatedGenericInitializer =
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      context.specializations.isGeneric(node.initializer) &&
      context.specializations.specializationsOf(context.identities.genericSubjectOf(node.initializer)).length === 0
    if (node.initializer && !candidate.classLayoutOnly && !uninstantiatedGenericInitializer) {
      // An instance field initializer runs with the new instance as `this`;
      // a static field initializer runs during class evaluation with the
      // constructor object as `this`. These are different physical carriers,
      // so the initializer convention has to state the corresponding side of
      // the class rather than giving both the instance-side type.
      const receiver = isStatic ? context.types.valueTypeAt(classNode) : context.types.instanceTypeAt(classNode)
      // What the thunk RETURNS is what the initializer evaluates to, and for a
      // field annotated with an overload set and initialized with a function
      // literal those are two different types -- the annotation has the
      // overloads, the literal has the one convention it physically allocates.
      // Asked at the initializer in exactly that case (`structural-parts.ts`'s
      // `memberOf` asks the same question of the same helper, so the field's
      // layout and its initializer's return cannot disagree), and at the
      // declaration for every other field, whose annotation is its storage and
      // is what the rest of the program already agreed on.
      // STATED: the field's own written annotation, so `physicalInitializerTypeOf`
      // can tell an authored overload set apart from the initializer's one real
      // convention -- not a question a census answers, since the census's job
      // is inferring an ABSENT annotation, and this only fires when one exists.
      const physical = physicalInitializerTypeOf(context.checker, node, context.checker.getTypeAtLocation(node))
      const result = context.types.typeAt(physical === null ? node : node.initializer)
      const shape = context.table.intern({
        kind: 'signature',
        call: [{ parameters: [], minimumArity: 0, thisParameter: receiver, result }],
        construct: []
      })
      const id = mintOperationId(context.ordinals, source, 'allocation')
      initializerObject = {
        id,
        family: 'allocation',
        allocated: 'function-object',
        shape,
        callable: context.identities.functionIdOf(node),
        caller: candidate.caller,
        operands: [],
        results: [mintResult(id, 'value', shape)],
        completion: normalCompletion,
        effects: { ...pureEffects, allocates: true },
        evaluationOrdinal: candidate.evaluationOrdinal
      }
      operations.push(initializerObject)
    }
    const initializerValue = initializerObject ? resultOf(initializerObject, 'value') : null
    // The field's declared storage type is needed even when it has no
    // initializer (`static cacheHexString: boolean`). It is carried as an
    // absent operand because class definition does not evaluate another value
    // for it; the shape is metadata consumed by the class projection.
    const storageOperand = operand('field-storage', 0, { kind: 'absent' }, context.types.typeAt(node))
    const fieldOperands = initializerValue
      ? [
          ...keyOperands,
          storageOperand,
          operand('initializer', 0, { kind: 'result', result: initializerValue.id }, initializerObject?.shape ?? voidType)
        ]
      : [...keyOperands, storageOperand]

    const defineId = mintOperationId(context.ordinals, source, 'class-lifecycle')
    // Instance fields run their initializer at construction, after `super()`
    // returns in a derived class -- this event records that the field exists
    // and where it is installed. The initializer's own operations are attributed
    // to the `field-initializer` region census already creates for this
    // declaration, ordered against `super()` by whatever family models the
    // constructor's invocation graph; this producer has no channel to that
    // family's operation ids (see report on the `this`-not-bound-before-`super`
    // requirement, which needs a binding event this event vocabulary lacks).
    const defineOperation: ClassLifecycleOperation = {
      ...buildOperation(
        defineId,
        candidate.caller,
        context.evaluationOrdinals.next(candidate.caller),
        'define-field',
        declaration,
        classId,
        descriptor,
        isStatic ? 'static' : 'own',
        fieldOperands,
        normalCompletion,
        { readsMutableState: false, writesMutableState: true, allocates: false, callsUserCode: false }
      ),
      ...(ts.getJSDocTags(node).some((tag) => tag.tagName.text === 'geaSubclassMemberOverlay')
        ? { syntheticSubclassMemberOverlay: true }
        : {})
    }
    operations.push(defineOperation)
    if (initializerValue) edges.push({ kind: 'value', result: initializerValue.id, to: defineId, role: 'initializer', ordinal: 0 })
    if (keySource) {
      const keyEdge = resultEdge(keySource, defineId, 'key', 0)
      if (keyEdge) edges.push(keyEdge)
    }

    edges.push({ kind: 'evaluation', from: ready, to: defineOperation.id })

    if (isPrivate) {
      const brandId = mintOperationId(context.ordinals, source, 'class-lifecycle')
      const brandOperation = buildOperation(
        brandId,
        candidate.caller,
        candidate.evaluationOrdinal,
        'install-private-brand',
        declaration,
        classId,
        null,
        null,
        [],
        normalCompletion,
        {
          readsMutableState: false,
          writesMutableState: true,
          allocates: false,
          callsUserCode: false
        }
      )
      operations.push(brandOperation)
      edges.push({ kind: 'evaluation', from: defineOperation.id, to: brandOperation.id })
    }

    return { kind: 'operations', operations, edges }
  }

  const contributeStaticBlock = (candidate: CensusCandidate, node: ts.ClassStaticBlockDeclaration): CandidateContribution => {
    const located = memberContext(candidate, node)
    if ('kind' in located) return located
    const { classNode, ready } = located

    const source = candidate.id
    const declaration = context.identities.declarationIdOf(node)
    const classId = context.identities.declarationIdOf(classNode)
    const id = mintOperationId(context.ordinals, source, 'class-lifecycle')
    const operation = buildOperation(
      id,
      candidate.caller,
      context.evaluationOrdinals.next(candidate.caller),
      'run-static-block',
      declaration,
      classId,
      null,
      null,
      [],
      // The block body can throw and can read/write arbitrary state; its own
      // statements are separately normalized under the `static-block` region
      // census already creates, so this operation is the block's entry point.
      throwingCompletion,
      { readsMutableState: true, writesMutableState: true, allocates: false, callsUserCode: true }
    )
    const edges: SemanticEdge[] = []
    edges.push({ kind: 'evaluation', from: ready, to: operation.id })
    return { kind: 'operations', operations: [operation], edges }
  }

  /**
   * A class expression's `evaluate-heritage` event -- the one lifecycle step
   * an expression shares with a declaration. Its constructor object is the
   * allocation family's (`allocations.ts`), and it binds no name, so neither
   * `bind-class-value` nor a name binding is minted here; `census.ts`'s
   * `familiesOf` routes only an expression WITH an `extends` clause this way.
   */
  const contributeClassExpressionHeritage = (candidate: CensusCandidate, node: ts.ClassExpression): CandidateContribution => {
    const heritageExpression = node.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression
    const writtenConstructor = writtenConstructorAllocationOf(candidate, node)
    if (!heritageExpression) return { kind: 'operations', operations: writtenConstructor ? [writtenConstructor] : [], edges: [] }
    const declaration = context.identities.declarationIdOf(node)
    const evaluatedHeritage = transparentConstClassAliasTarget(context.checker, heritageExpression) ?? heritageExpression
    const cited = citeExpressionResult(evaluatedHeritage, context)
    if (cited.kind === 'unmodelled') {
      return asBlocked(candidate.id, 'class-lifecycle', `class heritage expression ${cited.reason}`, null)
    }
    const id = mintOperationId(context.ordinals, candidate.id, 'class-lifecycle')
    const operation = buildOperation(
      id,
      candidate.caller,
      context.evaluationOrdinals.next(candidate.caller),
      'evaluate-heritage',
      declaration,
      declaration,
      null,
      null,
      [operand('heritage', 0, cited.source, context.types.typeAt(evaluatedHeritage))],
      throwingCompletion,
      { readsMutableState: true, writesMutableState: false, allocates: false, callsUserCode: false }
    )
    const edge = resultEdge(cited.source, id, 'heritage', 0)
    const constructor = citeExpressionResult(node, context)
    if (constructor.kind === 'unmodelled' || constructor.source.kind !== 'result') {
      return asBlocked(candidate.id, 'class-lifecycle', 'class heritage has no evaluated constructor object', 'P6')
    }
    return {
      kind: 'operations',
      operations: writtenConstructor ? [writtenConstructor, operation] : [operation],
      edges: [...(edge ? [edge] : []), { kind: 'evaluation', from: id, to: operationOfResult(constructor.source.result) }]
    }
  }

  const contribute = (candidate: CensusCandidate): CandidateContribution => {
    const { node } = candidate
    if (ts.isClassDeclaration(node)) return contributeClass(candidate, node)
    if (ts.isClassExpression(node)) return contributeClassExpressionHeritage(candidate, node)
    if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      return contributeMethodOrAccessor(candidate, node)
    }
    if (ts.isPropertyDeclaration(node)) return contributeField(candidate, node)
    if (ts.isClassStaticBlockDeclaration(node)) return contributeStaticBlock(candidate, node)
    if (ts.isParameter(node)) return contributeParameterProperty(candidate, node)
    // A written constructor has no lifecycle event of its own: unlike a method
    // or accessor, it is never installed onto a prototype, and unlike a field
    // it is never run as a per-instance initializer step -- `[[Construct]]`
    // calls it directly as the class's own body. Its allocation (the callable
    // convention `functionIdOf(written)` gives the body) and its binding into
    // the class's own name are both already published by `contributeClass`
    // above, from the *class declaration's* candidate, because both need
    // `written` before this per-member candidate for the constructor node
    // itself is even visited. Its parameters are ordinary `binding`-family
    // candidates (bodied since `bindings.ts`'s `hasArgumentFrame` recognizes
    // `ConstructorDeclaration`) and its statements are their own families
    // under its own `FunctionId` as caller -- neither runs through this
    // family at all. So this candidate genuinely has nothing left to
    // introduce, the same "nothing at this coordinate" answer a
    // pattern-nested `BindingElement` gives in `bindings.ts`.
    if (ts.isConstructorDeclaration(node)) return { kind: 'operations', operations: [], edges: [] }
    return asBlocked(candidate.id, 'class-lifecycle', 'census produced a class-lifecycle candidate of an unmodelled node kind', null)
  }

  return { family: 'class-lifecycle', contribute }
}
