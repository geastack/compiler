interface Machine<TState, TResult> {
  onEnter: (n: number, outer: TState | undefined) => TState
  onExit: (n: number, state: TState) => TResult
}
type State = <TState, TResult>(
  machine: Machine<TState, TResult>,
  stackIndex: number,
  stateStack: State[],
  nodeStack: number[],
  userStack: TState[],
  result: TResult | undefined
) => number
namespace State {
  export function enter<TState, TResult>(
    machine: Machine<TState, TResult>,
    stackIndex: number,
    stateStack: State[],
    nodeStack: number[],
    userStack: TState[],
    _result: TResult | undefined
  ): number {
    const node = nodeStack[stackIndex]!
    userStack[stackIndex] = machine.onEnter(node, stackIndex > 0 ? userStack[stackIndex - 1] : undefined)
    stateStack[stackIndex] = exit
    return stackIndex
  }
  export function exit<TState, TResult>(
    machine: Machine<TState, TResult>,
    stackIndex: number,
    stateStack: State[],
    nodeStack: number[],
    userStack: TState[],
    _result: TResult | undefined
  ): number {
    stateStack[stackIndex] = done
    return stackIndex
  }
  export function done<TState, TResult>(
    _machine: Machine<TState, TResult>,
    stackIndex: number,
    _stateStack: State[],
    _nodeStack: number[],
    _userStack: TState[],
    _result: TResult | undefined
  ): number {
    return stackIndex
  }
}
function run<TState, TResult>(machine: Machine<TState, TResult>, node: number): TResult {
  const stateStack: State[] = [State.enter]
  const nodeStack: number[] = [node]
  const userStack: TState[] = []
  let stackIndex = 0
  let steps = 0
  while (stateStack[stackIndex] !== State.done) {
    stackIndex = stateStack[stackIndex]!(machine, stackIndex, stateStack, nodeStack, userStack, undefined)
    steps++
  }
  return machine.onExit(steps, userStack[0]!)
}
console.log(run<number, string>({ onEnter: (n, outer) => n + (outer ?? 0), onExit: (steps, state) => `${steps}:${state}` }, 5))
//! expect: 2:5
