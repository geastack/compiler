//! oracle: node
interface Node {
  value: number
  children: Node[]
}
export function main(): string {
  const root: Node = {
    value: 1,
    children: [
      {
        value: 2,
        children: [
          { value: 5, children: [] },
          { value: 6, children: [] }
        ]
      },
      { value: 3, children: [] },
      { value: 4, children: [{ value: 7, children: [] }] }
    ]
  }
  const a = root.children[0]?.children[0]?.value ?? -1
  const b = root.children[3]?.children[0]?.value ?? -1
  const c = root.children[2]?.children[0]?.value ?? -1
  const d = root.children[0]?.children[5]?.value ?? -1
  return 'a=' + a + ' b=' + b + ' c=' + c + ' d=' + d
}
console.log(main())
