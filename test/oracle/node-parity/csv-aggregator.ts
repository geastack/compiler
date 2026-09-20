interface Sale {
  region: string
  product: string
  units: number
  revenue: number
  note: string
}

interface Group {
  key: string
  units: number
  revenue: number
  notes: number
}

function parseLine(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && i + 1 < line.length && line[i + 1] === '"') {
        cell += '"'
        i += 2
      } else if (ch === '"') {
        quoted = false
        i += 1
      } else {
        cell += ch
        i += 1
      }
    } else if (ch === '"') {
      quoted = true
      i += 1
    } else if (ch === ',') {
      cells.push(cell)
      cell = ''
      i += 1
    } else {
      cell += ch
      i += 1
    }
  }
  cells.push(cell)
  return cells
}

function parseCsv(input: string): string[][] {
  const rows: string[][] = []
  let line = ''
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '\n') {
      rows.push(parseLine(line))
      line = ''
    } else {
      line += ch
    }
  }
  if (line.length > 0) rows.push(parseLine(line))
  return rows
}

function readSales(csv: string): Sale[] {
  const table = parseCsv(csv)
  const sales: Sale[] = []
  for (let i = 1; i < table.length; i++) {
    const row = table[i]
    if (row.length >= 5) {
      sales.push({
        region: row[0],
        product: row[1],
        units: Number(row[2]),
        revenue: Number(row[3]),
        note: row[4]
      })
    }
  }
  return sales
}

function findGroup(groups: Group[], key: string): Group | undefined {
  for (const group of groups) {
    if (group.key === key) return group
  }
  return undefined
}

function aggregate(sales: Sale[]): Group[] {
  const groups: Group[] = []
  for (const sale of sales) {
    const key = sale.region + '/' + sale.product
    let group = findGroup(groups, key)
    if (group === undefined) {
      group = { key, units: 0, revenue: 0, notes: 0 }
      groups.push(group)
    }
    group.units += sale.units
    group.revenue += sale.revenue
    if (sale.note.length > 0) group.notes += 1
  }
  groups.sort((a: Group, b: Group) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return groups
}

function render(groups: Group[]): string {
  const out: string[] = []
  for (const group of groups) {
    const average = Math.trunc(group.revenue / group.units)
    out.push(group.key + ':units=' + group.units + ',revenue=' + group.revenue + ',avg=' + average + ',notes=' + group.notes)
  }
  return out.join('|')
}

export function main(): string {
  const csv = [
    'region,product,units,revenue,note',
    'north,widget,3,1200,"first batch"',
    'south,gadget,2,800,"priority, east"',
    'north,widget,5,2100,"repeat ""rush"""',
    'north,gadget,4,1250,',
    'south,gadget,1,400,"late"',
    'west,widget,6,3000,"new, channel"'
  ].join('\n')
  return render(aggregate(readSales(csv)))
}

console.log(main())
