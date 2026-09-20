//! oracle: node
interface User {
  id: number
  name: string
  tags: string[]
}
export function main(): string {
  const users: User[] = [
    { id: 1, name: 'a', tags: ['x', 'y'] },
    { id: 2, name: 'b', tags: [] },
    { id: 3, name: 'c', tags: ['z'] }
  ]
  const out = JSON.stringify(users)
  return 'json=' + out + ' len=' + out.length
}
console.log(main())
