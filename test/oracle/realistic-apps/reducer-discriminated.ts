//! oracle: node
interface State {
  count: number
  history: number[]
}
type Action = { type: 'inc'; by: number } | { type: 'dec'; by: number } | { type: 'reset' } | { type: 'set'; value: number }
function reduce(state: State, action: Action): State {
  if (action.type === 'inc') return { count: state.count + action.by, history: [...state.history, state.count] }
  if (action.type === 'dec') return { count: state.count - action.by, history: [...state.history, state.count] }
  if (action.type === 'reset') return { count: 0, history: [...state.history, state.count] }
  return { count: action.value, history: [...state.history, state.count] }
}
export function main(): string {
  let state: State = { count: 0, history: [] }
  const actions: Action[] = [{ type: 'inc', by: 5 }, { type: 'inc', by: 3 }, { type: 'set', value: 100 }, { type: 'reset' }]
  for (const a of actions) state = reduce(state, a)
  return 'count=' + state.count + ' history=' + state.history.join(',')
}
console.log(main())
