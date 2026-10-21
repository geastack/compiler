// A field observed only through `Object.values`, `Object.entries` or an
// `Object.assign` source is still read: those host calls name no key and do
// not lower to an own-key enumeration, so tree shaking took the field's
// initializer for unread and the walk read the struct's default instead.
//! expect: values x,2
//! expect: entries x=x,y=2
//! expect: assigned x,2

class Point {
  x = 'x'
  y = 2
}
console.log('values ' + Object.values(new Point()).join(','))
console.log(
  'entries ' +
    Object.entries(new Point())
      .map(([k, v]) => k + '=' + String(v))
      .join(',')
)
const target: Record<string, unknown> = {}
Object.assign(target, new Point())
console.log('assigned ' + Object.values(target).join(','))
