// JSON.stringify of a record held through a view in another carrier writes the
// original allocation: the view retains it, and SerializeJSONObject lists the
// original's own properties, not the view's declared ones. So each original
// carrier a stringified view can hold needs its own typed writer, even where no
// call site stringifies that carrier directly.
interface Wide {
  id: string
  size: number
  tags: string[]
}
interface Narrow {
  id: string
}
const make = (id: string): Wide => ({ id, size: 2, tags: ['t', 'u'] })
const keep = (v: Partial<Wide>): Partial<Wide> => v
const narrow = (v: Narrow): Narrow => v

//! expect: a 2 {"id":"a","size":2,"tags":["t","u"]}
const wide = keep(make('a'))
console.log(wide.id, wide.size, JSON.stringify(wide))

// A narrower view still writes every own property of the original.
//! expect: {"id":"b","size":2,"tags":["t","u"]}
console.log(JSON.stringify(narrow(make('b'))))

// The view is live: a later write to the original is what gets serialized.
//! expect: {"id":"c","size":7,"tags":["t","u"]}
const original = make('c')
const viewed = keep(original)
original.size = 7
console.log(JSON.stringify(viewed))

// A view nested in a record field and in an array element.
//! expect: {"inner":{"id":"d","size":2,"tags":["t","u"]}}
console.log(JSON.stringify({ inner: keep(make('d')) }))
//! expect: [{"id":"e","size":2,"tags":["t","u"]}]
const list: Partial<Wide>[] = [keep(make('e'))]
console.log(JSON.stringify(list))

// A class instance viewed as a record writes the instance's own fields.
class Point {
  x = 1
  y = 2
}
const loose = (p: Partial<{ x: number; y: number }>): Partial<{ x: number; y: number }> => p
//! expect: {"x":1,"y":2}
console.log(JSON.stringify(loose(new Point())))
