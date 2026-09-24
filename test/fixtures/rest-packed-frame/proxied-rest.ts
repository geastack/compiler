function emit(name: string, ...args: unknown[]): string {
  return name + ':' + args.length
}
const values: unknown[] = [1, 'a']
const observed = new Proxy(values, {})
console.log(emit('x', ...observed), emit('y', 1, 2), observed.length)
