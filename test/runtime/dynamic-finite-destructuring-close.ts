//! expect: first:1:first-close
//! expect: empty:empty-close
//! expect: exhausted:1,undefined:open
//! expect: abrupt:abrupt-close:step-failure
//! expect: rest:1,2,3:open
//! emitted-has: gea::runtime::iterator::CompletionGuard
//! emitted-has: gea::runtime::iterator::close

const finite = (label: string, values: number[], fail = false): { source: any; state: () => string } => {
  let closed = 'open'
  let position = 0
  const source: any = {
    [Symbol.iterator]() {
      return {
        next() {
          if (fail) throw 'step-failure'
          if (position >= values.length) return { value: undefined, done: true }
          return { value: values[position++], done: false }
        },
        return() {
          closed = `${label}-close`
          return {}
        }
      }
    }
  }
  return { source, state: () => closed }
}

const first = finite('first', [1, 2])
const [head] = first.source
console.log(`first:${head}:${first.state()}`)

const empty = finite('empty', [1])
const [] = empty.source
console.log(`empty:${empty.state()}`)

const exhausted = finite('exhausted', [1])
const [one, absent] = exhausted.source
console.log(`exhausted:${one},${absent}:${exhausted.state()}`)

const abrupt = finite('abrupt', [], true)
try {
  const [value] = abrupt.source
  console.log(value)
} catch (error) {
  console.log(`abrupt:${abrupt.state()}:${error}`)
}

const rest = finite('rest', [1, 2, 3])
const [firstValue, ...remaining] = rest.source
console.log(`rest:${firstValue},${remaining[0]},${remaining[1]}:${rest.state()}`)
