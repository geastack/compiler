const handlerIndexes: string[] = []
const parameterIndexes: string[] = []

const rewritten = '@0/#2'.replace(
  /#(\d+)|@(\d+)|\.\*\$/g,
  (_match: string, handlerIndex: string | undefined, parameterIndex: string | undefined) => {
    if (handlerIndex !== undefined) {
      handlerIndexes.push(handlerIndex)
      return '$()'
    }
    if (parameterIndex !== undefined) {
      parameterIndexes.push(parameterIndex)
      return ''
    }
    return 'unreachable'
  }
)

console.log(rewritten)
console.log(handlerIndexes.join(','))
console.log(parameterIndexes.join(','))

//! expect: /$()
//! expect: 2
//! expect: 0
