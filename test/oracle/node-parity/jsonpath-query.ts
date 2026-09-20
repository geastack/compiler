interface Product {
  sku: string
  category: string
  prices: number[]
  tags: string[]
  stock: number
}

interface Warehouse {
  code: string
  products: Product[]
}

interface Catalog {
  products: Product[]
  warehouses: Warehouse[]
}

type QueryValue =
  | { kind: 'catalog'; catalog: Catalog }
  | { kind: 'product'; product: Product }
  | { kind: 'warehouse'; warehouse: Warehouse }
  | { kind: 'products'; products: Product[] }
  | { kind: 'warehouses'; warehouses: Warehouse[] }
  | { kind: 'numbers'; numbers: number[] }
  | { kind: 'strings'; strings: string[] }
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }

type Step = { kind: 'field'; name: string } | { kind: 'index'; index: number } | { kind: 'wildcard' }

function parsePath(path: string): Step[] {
  const steps: Step[] = []
  let i = path.startsWith('$.') ? 2 : 0
  let field = ''
  while (i < path.length) {
    const ch = path[i]
    if (ch === '.') {
      if (field.length > 0) {
        steps.push({ kind: 'field', name: field })
        field = ''
      }
      i += 1
    } else if (ch === '[') {
      if (field.length > 0) {
        steps.push({ kind: 'field', name: field })
        field = ''
      }
      if (path[i + 1] === '*') {
        steps.push({ kind: 'wildcard' })
        i += 3
      } else {
        let raw = ''
        i += 1
        while (i < path.length && path[i] !== ']') {
          raw += path[i]
          i += 1
        }
        steps.push({ kind: 'index', index: Number(raw) })
        i += 1
      }
    } else {
      field += ch
      i += 1
    }
  }
  if (field.length > 0) steps.push({ kind: 'field', name: field })
  return steps
}

function field(value: QueryValue, name: string): QueryValue[] {
  if (value.kind === 'catalog') {
    if (name === 'products') return [{ kind: 'products', products: value.catalog.products }]
    if (name === 'warehouses') return [{ kind: 'warehouses', warehouses: value.catalog.warehouses }]
  } else if (value.kind === 'warehouse') {
    if (name === 'code') return [{ kind: 'string', value: value.warehouse.code }]
    if (name === 'products') return [{ kind: 'products', products: value.warehouse.products }]
  } else if (value.kind === 'product') {
    if (name === 'sku') return [{ kind: 'string', value: value.product.sku }]
    if (name === 'category') return [{ kind: 'string', value: value.product.category }]
    if (name === 'prices') return [{ kind: 'numbers', numbers: value.product.prices }]
    if (name === 'tags') return [{ kind: 'strings', strings: value.product.tags }]
    if (name === 'stock') return [{ kind: 'number', value: value.product.stock }]
  }
  return []
}

function index(value: QueryValue, slot: number): QueryValue[] {
  if (value.kind === 'products' && slot >= 0 && slot < value.products.length) return [{ kind: 'product', product: value.products[slot] }]
  if (value.kind === 'warehouses' && slot >= 0 && slot < value.warehouses.length)
    return [{ kind: 'warehouse', warehouse: value.warehouses[slot] }]
  if (value.kind === 'numbers' && slot >= 0 && slot < value.numbers.length) return [{ kind: 'number', value: value.numbers[slot] }]
  if (value.kind === 'strings' && slot >= 0 && slot < value.strings.length) return [{ kind: 'string', value: value.strings[slot] }]
  return []
}

function wildcard(value: QueryValue): QueryValue[] {
  const out: QueryValue[] = []
  if (value.kind === 'products') {
    for (const product of value.products) out.push({ kind: 'product', product })
  } else if (value.kind === 'warehouses') {
    for (const warehouse of value.warehouses) out.push({ kind: 'warehouse', warehouse })
  } else if (value.kind === 'numbers') {
    for (const n of value.numbers) out.push({ kind: 'number', value: n })
  } else if (value.kind === 'strings') {
    for (const s of value.strings) out.push({ kind: 'string', value: s })
  }
  return out
}

function query(catalog: Catalog, path: string): QueryValue[] {
  let values: QueryValue[] = [{ kind: 'catalog', catalog }]
  for (const step of parsePath(path)) {
    const next: QueryValue[] = []
    for (const value of values) {
      const chunk = step.kind === 'field' ? field(value, step.name) : step.kind === 'index' ? index(value, step.index) : wildcard(value)
      for (const item of chunk) next.push(item)
    }
    values = next
  }
  return values
}

function printable(values: QueryValue[]): string {
  const out: string[] = []
  for (const value of values) {
    if (value.kind === 'string') out.push(value.value)
    else if (value.kind === 'number') out.push(String(value.value))
    else if (value.kind === 'product') out.push(value.product.sku)
    else if (value.kind === 'warehouse') out.push(value.warehouse.code)
  }
  return out.join(',')
}

export function main(): string {
  const pen: Product = { sku: 'pen-01', category: 'stationery', prices: [2, 3], tags: ['blue', 'office'], stock: 7 }
  const mug: Product = { sku: 'mug-02', category: 'kitchen', prices: [8, 10], tags: ['ceramic', 'office'], stock: 3 }
  const mat: Product = { sku: 'mat-03', category: 'desk', prices: [12, 15], tags: ['large'], stock: 11 }
  const catalog: Catalog = {
    products: [pen, mug, mat],
    warehouses: [
      { code: 'north', products: [pen, mug] },
      { code: 'south', products: [mat] }
    ]
  }
  const paths = ['$.products[*].sku', '$.products[1].prices[0]', '$.warehouses[*].code', '$.warehouses[0].products[*].tags[1]']
  const lines: string[] = []
  for (const path of paths) lines.push(path + '=>' + printable(query(catalog, path)))
  return lines.join('|')
}

console.log(main())
