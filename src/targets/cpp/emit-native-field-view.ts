import type { GetOperation, SetOperation, IrOperand } from '../../ir/model.js'
import type { NativeFieldViewRead } from '../../ir/native-field-view-facts.js'
import { representationKey, type Representation } from '../../representation/model.js'
import { createCppEmitBlockedError, operandText, type EmitContext } from './emit-context.js'
import { recipeText } from './emit-narrowing.js'
import { nativeFieldPolicyType, staticKeyOrderText } from './records.js'
import { tracksKeyOrder } from './key-order-tracking.js'
import { cppTypeOf, cppStringLiteral, cppRecordFieldKeyIsSymbol, fieldPropertyKeyText } from './types.js'
import { propertyKeyText } from './emit-dynamic-properties.js'

const tokenOf = (type: string): string => `gea::detail::payloadTypeTagFor<${type}>()`
const routeTokenOf = (value: Representation): string =>
  `gea_type == ${tokenOf(cppTypeOf(value))} && gea_policy == ${tokenOf(nativeFieldPolicyType(value))}`

/** A static symbol member reaches the IR as its `sym(decl|...)` key text, never as a string property. */
const viewKeyText = (key: string): string =>
  cppRecordFieldKeyIsSymbol(key) ? fieldPropertyKeyText(key) : `gea::PropertyKey::string(${cppStringLiteral(key)})`

const renderedLeaf = (ctx: EmitContext, id: string, text: string): string => {
  const node = ctx.conversions.nodeById(id)
  const rendered = node === null ? null : recipeText(ctx, node, text)
  if (rendered === null)
    throw createCppEmitBlockedError(`conversion:${id}`, 'a native field-view receipt has no exact certified conversion renderer')
  return rendered
}

/** Carrier wrappers select a native allocation; the route itself is never inferred from its copied fields. */
export const withFieldReceiver = (
  value: Representation,
  text: string,
  emit: (carrier: Representation) => string,
  dynamic?: (carrier: Representation, text: string) => string
): string => {
  if (value.kind === 'borrowed-ref') return withFieldReceiver(value.referent, text, emit, dynamic)
  if (value.kind === 'optional')
    return (
      `if (!${text}.has_value()) gea::host::throwRuntimeError("TypeError", "Cannot access a nullish native view"); ` +
      withFieldReceiver(value.payload, `(*${text})`, emit, dynamic)
    )
  // A `dynamic` arm is a `gea::Value` already; its own [[Get]] is the read.
  if (value.kind === 'dynamic' && dynamic !== undefined) return dynamic(value, text)
  if (value.kind === 'tagged-union')
    return (
      value.arms
        // `text` is a generic lambda's `const auto&` parameter, so its member
        // templates are dependent names.
        .map(
          (arm, index) =>
            `if (${text}.template is<${index}>()) { ${withFieldReceiver(arm.value, `${text}.template get<${index}>()`, emit, dynamic)} }`
        )
        .join(' ') + ' gea::host::throwRuntimeError("TypeError", "No native field-view receiver arm");'
    )
  if (
    (value.kind === 'record' || value.kind === 'record-with-index' || value.kind === 'class-ref' || value.kind === 'native-record-ref') &&
    value.ownership === 'shared-refcount'
  )
    return `{ const auto& gea_field_receiver = ${text}; ${emit(value)} }`
  return 'gea::host::throwRuntimeError("TypeError", "Cannot access a non-object native view receiver");'
}

/** Bind deferred operands once before either the live route or an ordinary allocation is observed. */
export const nativeFieldViewOperandContext = (ctx: EmitContext, operation: GetOperation | SetOperation): EmitContext => {
  const valueNames = new Map(ctx.valueNames).set(operation.receiver.value, 'gea_field_receiver')
  const deferredTexts = new Map(ctx.deferredTexts)
  const pendingPacks = new Map(ctx.pendingPacks)
  deferredTexts.delete(operation.receiver.value)
  pendingPacks.delete(operation.receiver.value)
  if ((operation.kind === 'get' ? operation.nativeFieldViewRead : operation.nativeFieldViewWrite)?.keyDomain) {
    valueNames.set(operation.key.value, 'gea_field_key_input')
    deferredTexts.delete(operation.key.value)
    pendingPacks.delete(operation.key.value)
  }
  if (operation.kind === 'set') {
    valueNames.set(operation.value.value, 'gea_field_value')
    deferredTexts.delete(operation.value.value)
    pendingPacks.delete(operation.value.value)
  }
  return { ...ctx, valueNames, deferredTexts, pendingPacks }
}

export const nativeFieldViewReadForText = (
  ctx: EmitContext,
  receiver: IrOperand,
  target: Representation,
  receipt: NativeFieldViewRead,
  ordinaryReadOf: (
    carrier: Representation,
    key: string
  ) => { readonly source: Representation; readonly text: string; readonly accessor?: true } | null,
  keyOperand?: IrOperand
): string => {
  const result = cppTypeOf(target)
  const arms = receipt.sources.map(({ source, conversion }) => {
    const from = cppTypeOf(source)
    const converted = renderedLeaf(ctx, conversion, `(*static_cast<const ${from}*>(gea_native))`)
    return `if (${routeTokenOf(source)}) { static_cast<std::optional<${result}>*>(gea_out)->emplace(${converted}); return true; }`
  })
  const accepts = receipt.sources.map(({ source }) => `(${routeTokenOf(source)})`).join(' || ') || 'false'
  const adapter =
    '[&](void* gea_out, const void* gea_type, const void* gea_policy, const void* gea_native) -> bool { ' +
    `${arms.join(' ')} return false; }`
  const accepted = `+[](const void* gea_type, const void* gea_policy) -> bool { return ${accepts}; }`
  const dynamicRead =
    (key: string) =>
    (carrier: Representation, text: string): string => {
      const route = receipt.sources.find((entry) => representationKey(entry.source) === representationKey(carrier))
      return route === undefined
        ? 'gea::host::throwRuntimeError("TypeError", "Cannot access a non-object native view receiver");'
        : `return ${renderedLeaf(ctx, route.conversion, `${text}.getProperty(${viewKeyText(key)})`)};`
    }
  const forKey = (key: string): string =>
    withFieldReceiver(
      receiver.representation,
      'gea_field_input',
      (carrier) => {
        const actual = ordinaryReadOf(carrier, key)
        const ordinary = actual && receipt.sources.find((entry) => representationKey(entry.source) === representationKey(actual.source))
        // A getter is the plain allocation's whole answer: there is no own
        // field for the native route to find, and a live view still answers
        // first through `readLiveField`.
        const getterAnswer = ordinary && actual?.accessor === true ? `return ${renderedLeaf(ctx, ordinary.conversion, actual.text)};` : null
        const plain =
          ordinary && actual && actual.source.kind === 'optional'
            ? `return ${renderedLeaf(ctx, ordinary.conversion, actual.text)};`
            : 'gea::host::throwRuntimeError("TypeError", "a native view receiver has no admitted plain allocation");'
        const property = `${viewKeyText(key)}`
        const native =
          `std::optional<${result}> gea_plain_answer; auto gea_plain_adapter = ${adapter}; ` +
          `struct PlainRead { std::optional<${result}>* answer; decltype(gea_plain_adapter)* adapter; }; ` +
          'PlainRead gea_plain_context{&gea_plain_answer, &gea_plain_adapter}; ' +
          'gea::NativeFieldRead gea_plain_read(gea_plain_answer, ' +
          '+[](void* slot, const void* type, const void* policy, const void* value) -> bool { ' +
          'auto& context = *static_cast<PlainRead*>(slot); return (*context.adapter)(context.answer, type, policy, value); }, ' +
          `${accepted}); gea_plain_read.slot = &gea_plain_context; ` +
          `if (gea_field_receiver->gea_readOwnFieldNative(${property}, gea_plain_read) && gea_plain_answer) ` +
          'return std::move(*gea_plain_answer); ' +
          (receipt.originalAbsent === true
            ? `if (!gea_field_receiver->gea_matchesOwnField(${property}) && ` +
              `gea::nativeObjectDataReadNative(gea_field_receiver, ${property}, gea_plain_read) && gea_plain_answer) ` +
              'return std::move(*gea_plain_answer); '
            : '') +
          'bool gea_plain_present = false; ' +
          `if (!gea_field_receiver->gea_ownFieldPresent(${property}, gea_plain_present) || gea_plain_present) ` +
          'gea::host::throwRuntimeError("TypeError", "a native allocation read has no certified carrier route"); '
        return (
          `return gea::record::readLiveField<${result}>(gea_field_receiver, ${property}, ` +
          `${adapter}, ${accepted}, [&]() -> ${result} { ${getterAnswer ?? `${native}${plain}`} });`
        )
      },
      dynamicRead(key)
    )
  // The receiver is the statement-lambda's ARGUMENT, not a local bound inside
  // it: a withheld receiver can be `(*presentOrThrow(<element read>))`, a
  // reference into a temporary `Optional`. A local `const auto&` outlives that
  // temporary by the length of the body and reads a freed view; an argument's
  // temporaries live until the call returns.
  if (receipt.keyDomain === undefined)
    return `([&](const auto& gea_field_input) -> ${result} { ${forKey(receipt.key)} })(${operandText(ctx, receiver)})`
  if (keyOperand === undefined) throw new Error('a computed native field-view receipt has no key operand')
  const bound = {
    ...ctx,
    valueNames: new Map(ctx.valueNames).set(keyOperand.value, 'gea_field_key_input'),
    deferredTexts: new Map(ctx.deferredTexts),
    pendingPacks: new Map(ctx.pendingPacks)
  }
  bound.deferredTexts.delete(keyOperand.value)
  bound.pendingPacks.delete(keyOperand.value)
  const selected = receipt.keyDomain.map((key) => `if (gea_field_key == ${viewKeyText(key)}) { ${forKey(key)} }`).join(' ')
  // Any other runtime key: a live view forwards it to its original allocation's
  // expando table or Document entry; a plain allocation misses every slot and
  // reads its own expando table. Either answer goes through the same adapter.
  const otherKey =
    receipt.openKeys === true
      ? withFieldReceiver(
          receiver.representation,
          'gea_field_input',
          () =>
            `return gea::record::readLiveField<${result}>(gea_field_receiver, gea_field_key, ${adapter}, ${accepted}, [&]() -> ${result} { ` +
            `std::optional<${result}> gea_plain_answer; auto gea_plain_adapter = ${adapter}; ` +
            `struct PlainRead { std::optional<${result}>* answer; decltype(gea_plain_adapter)* adapter; }; ` +
            'PlainRead gea_plain_context{&gea_plain_answer, &gea_plain_adapter}; ' +
            'gea::NativeFieldRead gea_plain_read(gea_plain_answer, ' +
            '+[](void* slot, const void* type, const void* policy, const void* value) -> bool { ' +
            'auto& context = *static_cast<PlainRead*>(slot); return (*context.adapter)(context.answer, type, policy, value); }, ' +
            `${accepted}); gea_plain_read.slot = &gea_plain_context; ` +
            'if (!gea_field_receiver->gea_matchesOwnField(gea_field_key) && ' +
            'gea::nativeObjectDataReadNative(gea_field_receiver, gea_field_key, gea_plain_read) && gea_plain_answer) ' +
            'return std::move(*gea_plain_answer); ' +
            'gea::host::throwRuntimeError("TypeError", "a native allocation read has no certified carrier route"); });',
          (carrier, text) => {
            const route = receipt.sources.find((entry) => representationKey(entry.source) === representationKey(carrier))
            return route === undefined
              ? 'gea::host::throwRuntimeError("TypeError", "Cannot access a non-object native view receiver");'
              : `return ${renderedLeaf(ctx, route.conversion, `${text}.getProperty(gea_field_key)`)};`
          }
        )
      : 'gea::host::throwRuntimeError("TypeError", "No admitted native field-view key");'
  return (
    `([&](const auto& gea_field_input) -> ${result} { ` +
    `const auto& gea_field_key_input = ${operandText(ctx, keyOperand)}; ` +
    `const gea::PropertyKey gea_field_key = ${propertyKeyText(bound, keyOperand, 'a computed native field-view read')}; ` +
    `${selected} ${otherKey} })(${operandText(ctx, receiver)})`
  )
}

export const nativeFieldViewReadText = (
  ctx: EmitContext,
  operation: GetOperation,
  ordinaryReadOf: (
    carrier: Representation,
    key: string
  ) => { readonly source: Representation; readonly text: string; readonly accessor?: true } | null
): string | null =>
  operation.nativeFieldViewRead === undefined
    ? null
    : nativeFieldViewReadForText(
        ctx,
        operation.receiver,
        operation.result.representation,
        operation.nativeFieldViewRead,
        ordinaryReadOf,
        operation.key
      )

export const nativeFieldViewWriteText = (ctx: EmitContext, operation: SetOperation): string | null => {
  const receipt = operation.nativeFieldViewWrite
  if (!receipt) return null
  const arms = receipt.targets.flatMap(({ target, conversion }) => {
    if (target === null || conversion === null) return []
    const result = cppTypeOf(target)
    const converted = renderedLeaf(ctx, conversion, 'gea_field_value')
    return [`if (${routeTokenOf(target)}) { static_cast<std::optional<${result}>*>(gea_out)->emplace(${converted}); return true; }`]
  })
  const adapter = '[&](const void* gea_type, const void* gea_policy, void* gea_out) -> bool { ' + `${arms.join(' ')} return false; }`
  const forKey = (key: string): string =>
    withFieldReceiver(operation.receiver.representation, 'gea_field_input', () => {
      const plain =
        `auto gea_plain_adapter = ${adapter}; auto gea_plain_write = gea::NativeFieldWrite::exact(gea_field_value); ` +
        'gea_plain_write.exactOnly = false; gea_plain_write.slot = &gea_plain_adapter; ' +
        'gea_plain_write.readFn = +[](const void* slot, const void* type, const void* policy, void* answer) -> bool { ' +
        'return (*static_cast<const decltype(gea_plain_adapter)*>(slot))(type, policy, answer); }; ' +
        `return gea_field_receiver->gea_writeOwnFieldNative(${viewKeyText(key)}, ` +
        'gea_plain_write, gea::nativeIsExtensible(gea_field_receiver));'
      return (
        `return gea::record::writeLiveField(gea_field_receiver, ${viewKeyText(key)}, ` +
        `gea_field_value, ${adapter}, [&]() -> bool { ${plain} });`
      )
    })
  // A fresh record's out-of-layout-order store states the order its literal
  // created its keys in (`ir/facts.ts`'s `outOfOrderFreshStores`), exactly as
  // the plain field store does: the literal's own stores carry no note, so a
  // store routed through the view protocol that dropped this statement left
  // the record enumerating its keys in layout order.
  const createdKeys = ctx.outOfOrderFreshStores.get(operation)
  const pendedOrder =
    createdKeys !== undefined && tracksKeyOrder(ctx, operation.receiver.representation)
      ? `${staticKeyOrderText('gea_field_input', createdKeys)} `
      : ''
  const bound = nativeFieldViewOperandContext(ctx, operation)
  const computedKey =
    receipt.keyDomain === undefined
      ? ''
      : `const auto& gea_field_key_input = ${operandText(ctx, operation.key)}; ` +
        `const gea::PropertyKey gea_field_key = ${propertyKeyText(bound, operation.key, 'a computed native field-view write')}; `
  const selected =
    receipt.keyDomain === undefined
      ? forKey(receipt.key)
      : receipt.keyDomain.map((key) => `if (gea_field_key == ${viewKeyText(key)}) { ${forKey(key)} }`).join(' ') +
        ' gea::host::throwRuntimeError("TypeError", "No admitted native field-view key");'
  return (
    `([&](const auto& gea_field_input) -> bool { ` +
    computedKey +
    `const ${cppTypeOf(operation.value.representation)} gea_field_value = ${operandText(ctx, operation.value)}; ` +
    pendedOrder +
    `${selected} })(${operandText(ctx, operation.receiver)})`
  )
}

/**
 * One fixed-key read of an entry the caller already holds as `receiver`: a
 * live view answers through its certified routes, any other allocation with
 * `plain`, its own slot read. Used where the language performs the Get
 * internally (24.1.1.1's `entry[0]`/`entry[1]`) and no Get operation exists.
 */
export const nativeHeldFieldViewReadText = (
  ctx: EmitContext,
  receipt: NativeFieldViewRead,
  target: Representation,
  receiver: string,
  plain: string
): string => {
  const result = cppTypeOf(target)
  const arms = receipt.sources.map(({ source, conversion }) => {
    const converted = renderedLeaf(ctx, conversion, `(*static_cast<const ${cppTypeOf(source)}*>(gea_native))`)
    return `if (${routeTokenOf(source)}) { static_cast<std::optional<${result}>*>(gea_out)->emplace(${converted}); return true; }`
  })
  const accepts = receipt.sources.map(({ source }) => `(${routeTokenOf(source)})`).join(' || ') || 'false'
  return (
    `gea::record::readLiveField<${result}>(${receiver}, ${viewKeyText(receipt.key)}, ` +
    `[&](void* gea_out, const void* gea_type, const void* gea_policy, const void* gea_native) -> bool { ${arms.join(' ')} return false; }, ` +
    `+[](const void* gea_type, const void* gea_policy) -> bool { return ${accepts}; }, [&]() -> ${result} { return ${plain}; })`
  )
}
