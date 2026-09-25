//! dynamic-fallback
//! expect: 2 x head 2 y function
// `Array.isArray` narrows every unannotated binding to `any[]`; the read keeps
// the binding's own array arm, so the spread, the length and the element call
// all run on that arm -- fastify's parseHeadOnSendHandlers is this shape.
'use strict'
function headRouteOnSendHandler () { return 'head' }
function parseHeadOnSendHandlers (onSendHandlers) {
  if (onSendHandlers == null) return headRouteOnSendHandler
  return Array.isArray(onSendHandlers)
    ? [...onSendHandlers, headRouteOnSendHandler]
    : [onSendHandlers, headRouteOnSendHandler]
}
const a = parseHeadOnSendHandlers([() => 'x'])
const b = parseHeadOnSendHandlers(() => 'y')
const c = parseHeadOnSendHandlers(null)
const size = (x) => (Array.isArray(x) ? x.length : 1)
console.log(size(a), Array.isArray(a) && a[0](), Array.isArray(a) && a[1](), size(b), Array.isArray(b) && b[0](), typeof c)
