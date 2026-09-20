// tsc: `parseErrorAtPosition(start, length, message, ...args)` forwards its
// rest parameter as `createDetachedDiagnostic(..., ...args)`. Each spread
// argument is a staged member write on the callee's rest parameter whose
// SOURCE is the inner `args`; the global-host census used to leave that
// identifier to the spread element's expansion instead of seeding it, and
// on tsc a selection through the callee's storage found no graph node
// (`global-host mutation graph was not closed for Identifier args`). This
// shape certified before the fix too -- it pins the forwarding path, it did
// not reproduce the missing node.
type Piece = string | number | undefined
function render(text: string, ...args: Piece[]): string {
  return text.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)]))
}
function renderAt(position: number, text: string, ...args: Piece[]): string {
  return `${position}:${render(text, ...args)}`
}
function report(text: string, ...args: Piece[]): string {
  return renderAt(args.length, text, ...args)
}
console.log(report('{0} and {1}', 'a', 7), report('none'), report('{1}', undefined, 'x'))
//! expect: 2:a and 7 0:none 2:x
