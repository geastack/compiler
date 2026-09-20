// An explicitly typed tuple rest still binds one fresh container. Homogeneous
// tuples currently use array-object storage; heterogeneous tuples use positional
// records. Signature normalization and argument packing must use the body's
// container convention in either case, never flatten it into scalar parameters.
function pair(label: string, ...args: [number, number]): number {
  return (label.length > 0 ? args[0] : 0) + args[1]
}

function triple(...args: [string, string, string]): number {
  return args[0].length + args[1].length + args[2].length
}

const probe = pair('x', 3, 4) + triple('a', 'bb', 'ccc')

if (probe !== 3 + 4 + 1 + 2 + 3) throw new Error('rest-tuple argument packing computed the wrong result')
