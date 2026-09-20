class DynamicBundle {
  first = 1
  second = 'two'
}

function inspect(value: DynamicBundle): string {
  const dynamic = value as any
  const key: string = 'extra'
  dynamic[key] = 3
  return `${Object.keys(value).join(',')}|${dynamic[key]}`
}

console.log(inspect(new DynamicBundle()))
