const table = { count: 7, label: 'ready' }

function read(key: keyof typeof table): number | string {
  return table[key]
}

console.log(read('count'), read('label'))
