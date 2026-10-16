// Typed custom cursor: preserve the same phase distinction without a dynamic source.
type Step = { done: boolean; value: number | undefined }
type Cursor = { next(): Step; return(): Step }
type Source = { [Symbol.iterator](): Cursor }
function dynamicCase(mode: string) {
  let closes = 0
  const original = new Error('original')
  const source: Source = {
    [Symbol.iterator]() {
      return {
        next() {
          if (mode === 'next') throw original
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
          return { done: true, value: undefined }
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
        set value(value: number | undefined) {
          throw original
        }
      }
      ;[target.value] = source
    } else {
      const [value] = source
      console.log(value)
    }
  } catch (error) {
    console.log(mode, closes, error === original)
  }
}
for (const mode of ['next', 'done', 'value', 'default', 'default-return', 'assignment']) dynamicCase(mode)
//! expect: next 0 true
//! expect: done 0 true
//! expect: value 0 true
//! expect: default 1 true
//! expect: default-return 1 true
//! expect: assignment 1 true
