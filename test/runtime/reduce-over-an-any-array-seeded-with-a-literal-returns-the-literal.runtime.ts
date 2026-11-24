// `Array.isArray` narrows a `Document` (`{ [key: string]: any }`) to an
// `any[]`, so `reduce` resolves the `T`-typed overload with `T = any`: the
// callback takes and answers `any`, and the `{}` seed crosses into that same
// `any` accumulator. The answer is the seed object the callback filled.

export {}
type Doc = { [key: string]: any }

function projectionOf(options: { projection?: Doc }): Doc {
  const command: Doc = {}
  if (options.projection) {
    let projection = options.projection
    if (projection && Array.isArray(projection)) {
      projection = projection.length
        ? projection.reduce((result, field) => {
            result[field] = 1
            return result
          }, {})
        : { _id: 1 }
    }
    command.projection = projection
  }
  return command
}

const fields: any = ['name', 'age']
console.log(JSON.stringify(projectionOf({ projection: fields })))
const none: any = []
console.log(JSON.stringify(projectionOf({ projection: none })))
console.log(JSON.stringify(projectionOf({ projection: { kept: 1 } })))
//! expect: {"projection":{"name":1,"age":1}}
//! expect: {"projection":{"_id":1}}
//! expect: {"projection":{"kept":1}}
