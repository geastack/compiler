import type { Representation } from '../../representation/model.js'
import {
  constructorDispatchFamilyPlan,
  constructorIdentityFamilyPlan,
  type ConstructorIdentityFamilyPlan
} from '../../conversion/constructor-identity-family.js'
import type { ConversionSite } from './emit-narrowing.js'
import { cppConstructThunkName } from './emit-context.js'
import { cppClassName, cppTypeOf } from './types.js'

/** The materializer id `conversions.ts` installs `x.constructor` into a constructor family under, and `recipeText` renders. */
export const CONSTRUCTOR_IDENTITY_FAMILY = 'gea::constructorIdentityFamily'

/** The materializer id a constructor carried by its convention alone is projected into a class family under (`constructorDispatchFamilyPlan`). */
export const CONSTRUCTOR_DISPATCH_FAMILY = 'gea::constructorDispatchFamily'

/**
 * `conversion/constructor-identity-family.ts`'s plan, rendered: the class
 * evaluation, recognized by its declaration tag, with that member's construct
 * thunk installed. An evaluation of any other class -- which the plan proved
 * no instance can have -- is refused by name rather than constructed wrong.
 */
export const constructorIdentityFamilyText = (
  ctx: ConversionSite,
  source: Representation,
  target: Representation,
  text: string
): string | null => {
  const plan = constructorIdentityFamilyPlan(ctx.layouts, source, target)
  if (plan === null) return null
  return familyByDeclarationTokenText(
    plan,
    `gea::Ref<gea::NativeClassMethodState> gea_class = ${text};`,
    'a constructor read off an instance is not a class its constructor family names'
  )
}

/**
 * `conversion/constructor-identity-family.ts`'s `constructorDispatchFamilyPlan`,
 * rendered: the same member selection, asked of the class evaluation a
 * convention-only constructor carries as its environment. A host constructor's
 * evaluation has no declaration token and refuses like any non-member.
 */
export const constructorDispatchFamilyText = (
  ctx: ConversionSite,
  source: Representation,
  target: Representation,
  text: string
): string | null => {
  const plan = constructorDispatchFamilyPlan(ctx.layouts, source, target)
  if (plan === null) return null
  return familyByDeclarationTokenText(
    plan,
    `const auto& gea_from = ${text}; gea::Ref<gea::NativeClassMethodState> gea_class = gea_from.environment == nullptr ? ` +
      `gea::Ref<gea::NativeClassMethodState>() : gea::nativeClassMethodStateFromEnvironment(gea_from.environment);`,
    "a constructor stored where a class family is read is not one of that family's classes"
  )
}

const familyByDeclarationTokenText = (plan: ConstructorIdentityFamilyPlan, stateStatement: string, refusal: string): string => {
  const targetType = cppTypeOf(plan.target)
  const arms = plan.members.map(({ declaration, upcast, family, arm }) => {
    const familyType = cppTypeOf(family)
    const thunk = upcast
      ? `&gea::detail::ConstructorUpcast<${familyType}, &${cppConstructThunkName(declaration)}>::construct`
      : `&${cppConstructThunkName(declaration)}`
    const value = `${familyType}(${thunk}, gea::nativeClassMethodEnvironment(gea_class))`
    return (
      `if (gea_class->declaration == &gea::nativeClassMethodDeclaration<${cppClassName(declaration)}>) ` +
      `return ${arm === null ? value : `${targetType}::ofArm<${arm}>(${value})`};`
    )
  })
  return (
    `([&]() -> ${targetType} { ${stateStatement} ` +
    `if (gea_class) { ${arms.join(' ')} } ` +
    `gea::detail::refusePayloadMismatch(${JSON.stringify(refusal)}); }())`
  )
}
