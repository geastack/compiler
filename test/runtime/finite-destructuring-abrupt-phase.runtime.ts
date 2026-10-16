// IteratorStepValue failures complete the record; defaults/assignment still close.
function dynamicCase(mode: string) {
  let closes = 0
  const original = new Error('original')
  const source: any = {
    [Symbol.iterator]() {
      return {
        next() {
          if (mode === 'next') throw original
          if (mode === 'primitive') return 1
          return {
            get done() {
              if (mode === 'done') throw original
              return false
            },
            get value() {
              if (mode === 'value') throw original
              return undefined
            }
          }
        },
        return() {
          closes++
          if (mode === 'default-return') throw new Error('close')
          return {}
        }
      }
    }
  }
  function fail(): number {
    throw original
  }
  try {
    if (mode === 'default' || mode === 'default-return') {
      const [value = fail()] = source
      console.log(value)
    } else if (mode === 'assignment') {
      const target = {
        set value(value: number) {
          throw original
        }
      }
      ;[target.value] = source
    } else {
      const [value] = source
      console.log(value)
    }
  } catch (error) {
    console.log(mode, closes, mode === 'primitive' ? error instanceof TypeError : error === original)
  }
}
for (const mode of ['next', 'done', 'value', 'primitive', 'default', 'default-return', 'assignment']) dynamicCase(mode)
//! expect: next 0 true
//! expect: done 0 true
//! expect: value 0 true
//! expect: primitive 0 true
//! expect: default 1 true
//! expect: default-return 1 true
//! expect: assignment 1 true
