import ts from 'typescript'

/**
 * The language's own iteration interfaces (ECMA-262 27.1.1, and TypeScript's
 * `IterableIterator`/`AsyncIterableIterator` joins of them), by declaration
 * identity.
 *
 * They describe a protocol any object may implement -- the methods a value
 * answers to -- with no internal slot and no allocation of their own. So a
 * type that names one states how a value may be USED, never what the value
 * physically is: the carrier always belongs to the object implementing it.
 *
 * Resolved at `anchor` rather than matched by name, so a program's own
 * declaration spelled `Iterable` is not the language's.
 */
const languageIterationInterfaces = ['Iterable', 'AsyncIterable', 'Iterator', 'AsyncIterator', 'IterableIterator', 'AsyncIterableIterator']

export const isLanguageIterationInterface = (checker: ts.TypeChecker, anchor: ts.Node, symbol: ts.Symbol): boolean =>
  languageIterationInterfaces.some((name) => checker.resolveName(name, anchor, ts.SymbolFlags.Interface, false) === symbol)
