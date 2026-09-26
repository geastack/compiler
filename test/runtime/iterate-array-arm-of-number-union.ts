//! expect: a0,b1
//! expect: 2
// three's `NodeBuilder.vars` is `Object<string,Array<NodeVar>|number>`: each
// stage's variables beside a per-type counter, and `getVars` walks
// `this.vars[ stage ]` with `for ... of`. The array is the only arm with an
// iterator; a number has none, so a walk over it is GetIterator's TypeError,
// which this backend raises the way it raises an absent source's: it stops.
class NodeVar {
  constructor(readonly name: string) {}
}

const vars: { [stage: string]: NodeVar[] | number } = {}
vars['vertex'] = [new NodeVar('a0'), new NodeVar('b1')]
vars['vertexCount'] = 2

function getVars(stage: string): string {
  const snippets: string[] = []
  const list = vars[stage]
  if (list !== undefined) {
    // @ts-expect-error A number has no iterator; three's JSDoc does not say which arm this is.
    for (const variable of list) snippets.push(variable.name)
  }
  return snippets.join(',')
}

console.log(getVars('vertex'))
console.log(vars['vertexCount'])
export {}
