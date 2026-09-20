//! expect: break-close
//! expect: return-close
//! expect: throw-close
//! expect: normal-open
//! expect: inner-close,outer-close
// The guard the EMITTER writes is `CompletionGuard`; `CloseGuard` is a
// separate, still-live runtime class exercised directly by
// `test/runtime/dynamic-iterator-runtime.cpp`, and nothing emitted has
// named it since the two were split. Pinning the wrong one meant this
// program asserted a shape the compiler had stopped producing.
//! emitted-has: gea::runtime::iterator::CompletionGuard

let breakLog = ''
const breakSource: any = {
  [Symbol.iterator]() {
    return {
      next() {
        return { value: 1, done: false }
      },
      return() {
        breakLog = 'break-close'
        return {}
      }
    }
  }
}

for (const value of breakSource) {
  if (value === 1) break
}
console.log(breakLog)

let returnLog = ''
const returnSource: any = {
  [Symbol.iterator]() {
    return {
      next() {
        return { value: 1, done: false }
      },
      return() {
        returnLog = 'return-close'
        return {}
      }
    }
  }
}
const returnFromBody = () => {
  for (const value of returnSource) {
    if (value === 1) return
  }
}
returnFromBody()
console.log(returnLog)

let exhaustionLog = ''
const exhaustedSource: any = {
  [Symbol.iterator]() {
    return {
      next() {
        return { value: undefined, done: true }
      },
      return() {
        exhaustionLog = 'closed'
        return {}
      }
    }
  }
}
for (const value of exhaustedSource) {
  console.log(value)
}
console.log(exhaustionLog === '' ? 'normal-open' : exhaustionLog)

let nestedLog = ''
const outerSource: any = {
  [Symbol.iterator]() {
    return {
      next() {
        return { value: 1, done: false }
      },
      return() {
        nestedLog += 'outer-close'
        return {}
      }
    }
  }
}
const innerSource: any = {
  [Symbol.iterator]() {
    return {
      next() {
        return { value: 1, done: false }
      },
      return() {
        nestedLog += 'inner-close,'
        return {}
      }
    }
  }
}
outer: for (const outer of outerSource) {
  for (const inner of innerSource) {
    if (outer === inner) break outer
  }
}
console.log(nestedLog)

let throwLog = ''
const throwSource: any = {
  [Symbol.iterator]() {
    return {
      next() {
        return { value: 1, done: false }
      },
      return() {
        throwLog = 'throw-close'
        return {}
      }
    }
  }
}

try {
  for (const value of throwSource) {
    if (value === 1) throw 'body failure'
  }
} catch {
  console.log(throwLog)
}
