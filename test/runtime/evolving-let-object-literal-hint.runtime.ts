// AN EVOLVING `let` THAT STARTS `undefined` AND IS GIVEN OBJECT LITERALS.
//
// A database client's `normalizeHintField` declares `let finalHint =
// undefined`, then stores a string, an empty `{}` it fills by key, or a
// `{} as Document` copied key by key, and returns it as `Hint | undefined`.
// A string hint comes back as itself, an object is copied, and no hint stays
// `undefined`. (The array-of-names branch compiles; an array reaching a
// `string | Document` parameter is a separate carrier question.)

interface Doc {
  [key: string]: any
}

type Hint = string | Doc

function normalizeHintField(hint?: Hint): Hint | undefined {
  let finalHint = undefined

  if (typeof hint === 'string') {
    finalHint = hint
  } else if (Array.isArray(hint)) {
    finalHint = {}

    hint.forEach((param) => {
      finalHint[param] = 1
    })
  } else if (hint != null && typeof hint === 'object') {
    finalHint = {} as Doc
    for (const key in hint) {
      finalHint[key] = hint[key]
    }
  }

  return finalHint
}

const show = (hint: Hint | undefined): string => (hint === undefined ? 'undefined' : typeof hint === 'string' ? hint : JSON.stringify(hint))

//! expect: string=_id_
console.log(`string=${show(normalizeHintField('_id_'))}`)
//! expect: object={"x":-1,"y":1}
console.log(`object=${show(normalizeHintField({ x: -1, y: 1 }))}`)
//! expect: none=undefined
console.log(`none=${show(normalizeHintField())}`)
