//! oracle: node
interface Action {
  type: string
  payload: number
}
type Next = (action: Action) => Action
type Middleware = (next: Next) => Next
function logger(tag: string, log: string[]): Middleware {
  return (next: Next) => (action: Action) => {
    log.push(tag + ':' + action.type + ':' + action.payload)
    return next(action)
  }
}
function doubler(): Middleware {
  return (next: Next) => (action: Action) => next({ type: action.type, payload: action.payload * 2 })
}
function compose(middlewares: Middleware[], terminal: Next): Next {
  let dispatch: Next = terminal
  for (let i = middlewares.length - 1; i >= 0; i--) dispatch = middlewares[i](dispatch)
  return dispatch
}
export function main(): string {
  const log: string[] = []
  const final: Next = (a) => ({ type: a.type, payload: a.payload + 1 })
  const dispatch = compose([logger('pre', log), doubler(), logger('post', log)], final)
  const result = dispatch({ type: 'add', payload: 3 })
  return 'log=' + log.join('|') + ' final=' + result.payload
}
console.log(main())
