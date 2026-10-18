type Leaf = string
type Tree = { [key: string]: Leaf | Tree | Branch }
type Branch = (Leaf | Tree | Branch | undefined)[]
type Container = Tree | Branch

const keysOf = (container: Container): string => Object.keys(container).join(',')

const tree: Tree = { a: 'x', b: ['y', { c: 'z' }] }
const branch: Branch = ['p', tree, undefined, 'q']
tree['self'] = branch

console.log(keysOf(tree))
console.log(keysOf(branch))

//! expect: a,b,self
//! expect: 0,1,2,3
