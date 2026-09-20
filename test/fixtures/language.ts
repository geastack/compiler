// Constructs `spread.ts` does not reach: iteration, destructuring, spread,
// inheritance, generics, async, and getters. Still ordinary TypeScript — the
// point is coverage of the language, not of any application.

export interface Named {
  readonly name: string
}

export class Animal implements Named {
  constructor(readonly name: string) {}

  speak(): string {
    return `${this.name} makes a sound`
  }
}

export class Dog extends Animal {
  private barks = 0

  constructor(
    name: string,
    readonly breed: string
  ) {
    super(name)
  }

  get barkCount(): number {
    return this.barks
  }

  override speak(): string {
    this.barks += 1
    return `${this.name} barks`
  }
}

export const first = <T>(values: readonly T[]): T | undefined => {
  for (const value of values) return value
  return undefined
}

export const partition = (values: readonly number[]): { low: number[]; high: number[] } => {
  const low: number[] = []
  const high: number[] = []
  for (const value of values) {
    if (value < 10) low.push(value)
    else high.push(value)
  }
  return { low, high }
}

export const describe = ({ name }: Named, ...rest: readonly string[]): string => [name, ...rest].join(' ')

export const settle = async (values: readonly number[]): Promise<number> => {
  const total = await Promise.resolve(values.length)
  return total
}

export const merge = (base: Named, extra: { age: number }): Named & { age: number } => ({ ...base, ...extra })

export const swap = ([left, right]: readonly [number, number]): [number, number] => [right, left]

export const counts = new Map<string, number>()

export const run = (): string => {
  const pack = [new Dog('rex', 'husky'), new Animal('cat')]
  const { low, high } = partition([1, 2, 30])
  let label = ''
  for (const member of pack) label += member.speak()
  switch (low.length) {
    case 0:
      label += 'none'
      break
    default:
      label += String(high.length)
  }
  return describe({ name: label }, ...low.map(String)) + String(first(pack)?.name ?? '') + String(swap([1, 2])[0])
}
