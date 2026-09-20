import ts from 'typescript'
import { censusedTypeAt } from './derived-expression-type.js'
import { emptyParameterBindingCensus, type ParameterBindingCensus } from './parameter-bindings.js'

/**
 * The order an object LITERAL creates its keys in, which is not the order
 * TypeScript lists them.
 *
 * `{ ...base, ...extra }` runs `base`'s keys first, then `extra`'s, and a key
 * both objects have keeps the position its FIRST insertion gave it. The
 * checker's property table for that type comes back `age,name` while the
 * runtime creates `name,age`: TypeScript's property order is an authority on
 * the TYPE and not on enumeration, and the literal's own syntax is the only
 * thing that states what the program builds.
 *
 * This is not a cosmetic difference. Member order is part of the structural
 * interning key, so a wrong order mints a SECOND C++ struct for a type that
 * already had one -- two shapes with the same members in two orders, and no
 * conversion between them. It also reaches the emitted program directly:
 * `records.ts` writes the member list out as the object's
 * `gea_ownFieldKeys`, which is what `Object.keys` answers with.
 *
 * ⛔ The tempting shortcut is to sort the key canonically. That silently
 * changes `Object.keys` for every program, because the order is genuinely
 * READ rather than merely compared. Order stays in the key and is made
 * correct here instead.
 *
 * Refuses -- leaving the checker's order untouched -- whenever it cannot
 * account for the literal exactly: a key it cannot name, a spread whose
 * operand it cannot walk, or any disagreement between the names the syntax
 * produces and the members the type actually has. A partially-reconstructed
 * order is a third answer, not a better one.
 */
export const creationOrderedProperties = (
  checker: ts.TypeChecker,
  type: ts.Type,
  parameters: ParameterBindingCensus = emptyParameterBindingCensus
): readonly ts.Symbol[] => {
  const properties = type.getProperties()
  if (properties.length < 2) return properties
  const declarations = type.getSymbol()?.declarations
  const literal = declarations?.length === 1 && declarations[0] && ts.isObjectLiteralExpression(declarations[0]) ? declarations[0] : null
  if (!literal) return properties
  const order: string[] = []
  const seen = new Set<string>()
  const add = (name: string): void => {
    if (seen.has(name)) return
    seen.add(name)
    order.push(name)
  }
  // Bounded because a spread's operand can be another literal, and a program
  // is free to nest them; the depth that matters in practice is one or two,
  // and an unbounded walk here would be a second recursion in a file whose
  // termination argument is already about anchors.
  const walk = (node: ts.ObjectLiteralExpression, depth: number): boolean => {
    if (depth > 8) return false
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        // HOLDS: what the spread SOURCE expression evaluates to. A source
        // the checker only resolves to `any` (e.g. an unannotated parameter's
        // call-site evidence) used to fail this walk closed at the very next
        // line (`getSymbol()` on `any` finds nothing, so the spread's keys
        // were never accounted for and the whole reconstruction fell back to
        // the checker's own unordered `properties`) -- asking the shared
        // authority first lets a census answer recover the real order
        // exactly where it already recovers the real TYPE.
        const spread = censusedTypeAt(checker, parameters, property.expression)
        const spreadDeclarations = spread.getSymbol()?.declarations
        const nested =
          spreadDeclarations?.length === 1 && spreadDeclarations[0] && ts.isObjectLiteralExpression(spreadDeclarations[0])
            ? spreadDeclarations[0]
            : null
        // A spread of something that is not a literal contributes its own
        // members in the only order available for it -- the declared one,
        // which for an interface or a class IS its creation order.
        if (nested) {
          if (!walk(nested, depth + 1)) return false
        } else {
          for (const member of spread.getProperties()) add(member.name)
        }
        continue
      }
      const name = property.name
      if (!name) return false
      if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) add(name.text)
      else return false
    }
    return true
  }
  if (!walk(literal, 0)) return properties
  // The reconstruction must be a PERMUTATION of what the type reports. A
  // literal whose syntax names a key the type does not have (or misses one it
  // does) is one this walk did not understand, and reordering on a partial
  // account would produce an order neither authority states.
  const byName = new Map(properties.map((property) => [property.name, property]))
  if (order.length !== properties.length) return properties
  const reordered: ts.Symbol[] = []
  for (const name of order) {
    const property = byName.get(name)
    if (!property) return properties
    reordered.push(property)
  }
  return reordered
}
