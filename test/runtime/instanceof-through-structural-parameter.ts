//! expect: res:h
//! expect: init:404
//! expect: h2:a,b
//! expect: h1:c,d
// FORMERLY PINNED AS A REFUSAL (the class-to-interface slicing defect,
// reproduced whole); since the node-compat campaign the program certifies and
// prints what node prints, so the four answers the last paragraph names are
// pinned instead. The history below is kept because it names the two
// refusals that must NOT come back.
//
// `@hono/node-server` response.ts declares `constructor(body, init?:
// ResponseInit)` and tests `init instanceof GlobalResponse` (four refusals at
// response.ts:50/57/57/58); headers.ts declares `newHeadersFromIncoming(incoming:
// Pick<IncomingMessage | Http2ServerRequest, 'rawHeaders'> & { headers?: ... })`
// and tests `incoming instanceof Http2ServerRequest` (headers.ts:91, plus the
// manifest rows at :87 and :120). Both parameters are STRUCTURAL and both
// receive class instances, so the class identity has to survive the boundary
// for the test to have an answer.
//
// It does not. `structuralRecordViewPlan` (conversion/record-view.ts, recipe
// `view:structural-record` in targets/cpp/conversions.ts) rebuilds a class
// instance field by field into a fresh record, so what reaches the parameter is
// a COPY with no prototype -- and `classInstanceTestOf` (projection/
// instance-test.ts) answers a `record`/`native-record-ref` left operand with a
// proven `false`, while the narrowed binding still demands a
// `record -> class-ref` conversion that cannot exist. Those are the two
// refusals below, and they are the same defect seen from two sides.
//
// There is no half-fix. Proving the test false and pruning the branch would be
// a silent miscompile; installing the downcast would have to invent an identity
// the copy never had; and response.ts:57 reads `init.#init`, a PRIVATE field no
// structural copy can carry. The repair is a whole-program policy that derives
// a structural type the program `instanceof`-tests into a carrier that keeps
// the class -- a `tagged-union` of the record with the class-refs the tests
// name, for which the arm machinery (arm injection/projection,
// `instanceof:tagged-union:constructor-family`, `finiteRecordUnionGetText`)
// already exists, and which `derive.ts` cannot ask for today because it is a
// pure function of the static type and consults no such census.
//
// The `expect:` lines this fixture used to carry are the answers a fixed
// compiler must print: res:h / init:404 / h2:a,b / h1:c,d.
class ResponseLite {
  status = 200
  statusText = ''
  marker = ''
}
interface InitLite {
  status?: number
  statusText?: string
}
const initOf = (init?: InitLite): string => (init instanceof ResponseLite ? `res:${init.marker}` : `init:${init?.status ?? 0}`)

class Http2RequestLite {
  rawHeaders: string[] = []
  constructor(raw: string[]) {
    this.rawHeaders = raw
  }
}
class IncomingLite {
  rawHeaders: string[] = []
  headers: Record<string, string> = {}
  constructor(raw: string[]) {
    this.rawHeaders = raw
  }
}
type HeadersSource = Pick<IncomingLite | Http2RequestLite, 'rawHeaders'> & { headers?: Record<string, string> }
const readHeaders = (incoming: HeadersSource): string =>
  incoming instanceof Http2RequestLite ? `h2:${incoming.rawHeaders.join(',')}` : `h1:${incoming.rawHeaders.join(',')}`

const response = new ResponseLite()
response.marker = 'h'
console.log(initOf(response))
console.log(initOf({ status: 404 }))
console.log(readHeaders(new Http2RequestLite(['a', 'b'])))
console.log(readHeaders(new IncomingLite(['c', 'd'])))
