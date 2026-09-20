//! oracle: node
interface Cmd {
  name: string
  args: number[]
}
class Calculator {
  value: number = 0
  history: string[] = []
  execute(cmd: Cmd): number {
    this.history.push(cmd.name + '(' + cmd.args.join(',') + ')=' + this.value)
    if (cmd.name === 'add') for (const a of cmd.args) this.value += a
    else if (cmd.name === 'sub') for (const a of cmd.args) this.value -= a
    else if (cmd.name === 'mul') for (const a of cmd.args) this.value *= a
    else if (cmd.name === 'set') this.value = cmd.args[0]
    return this.value
  }
}
export function main(): string {
  const calc = new Calculator()
  const commands: Cmd[] = [
    { name: 'set', args: [10] },
    { name: 'add', args: [5, 3] },
    { name: 'mul', args: [2] },
    { name: 'sub', args: [6] }
  ]
  for (const c of commands) calc.execute(c)
  return 'value=' + calc.value + ' steps=' + calc.history.length
}
console.log(main())
