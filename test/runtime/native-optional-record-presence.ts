interface Child {
  label: string
}

interface Bag {
  required: string
  optional?: string | undefined
  nullable?: string | null
  child?: Child | undefined
}

const show = (bag: Bag): void => {
  const keys = Object.keys(bag)
  console.log(
    'optional' in bag,
    'nullable' in bag,
    'child' in bag,
    keys.length,
    bag.optional ?? 'missing',
    bag.nullable === null ? 'null' : (bag.nullable ?? 'missing'),
    bag.child?.label ?? 'missing'
  )
}

const absent: Bag = { required: 'a' }
const present: Bag = { required: 'b', optional: undefined, nullable: null, child: { label: 'kept' } }

show(absent)
show(present)
console.log(delete present.optional, delete present.nullable, delete present.child)
show(present)
present.optional = undefined
present.nullable = 'again'
present.child = { label: 'new' }
show(present)
