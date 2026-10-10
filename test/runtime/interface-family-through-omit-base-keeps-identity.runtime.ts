// An interface tree whose root extends a lib key-remapping alias over another
// interface (`extends Omit<SerializeOptions, 'index'>`, a database
// client's `WireSerializeOptions`) is still ONE object family: handing an options
// object to a function naming a different member of the tree passes the same
// object, so a write through either name is seen through the other and `===`
// holds. Each member used to be its own struct, and every hand-off a
// field-by-field copy.
interface SerializeOptions {
  checkKeys?: boolean
  index?: number
}
interface BaseOptions extends Omit<SerializeOptions, 'index'> {
  session?: string
}
interface CommandOptions extends BaseOptions {
  timeoutMS?: number
}
interface CreateOptions extends Omit<CommandOptions, 'timeoutMS'> {
  capped?: boolean
  size?: number
}
interface ReadOnlyView extends Readonly<Pick<CreateOptions, 'capped'>> {
  label?: string
}

const seen: BaseOptions[] = []
function remember(options: BaseOptions): BaseOptions {
  seen.push(options)
  options.session = 'tagged'
  return options
}
function command(options: CommandOptions): number {
  return options.timeoutMS ?? -1
}

const create: CreateOptions = { capped: true, size: 10, checkKeys: false }
const back = remember(create)
console.log(back === create, seen[0] === create, create.session, create.capped, create.size)
create.size = 20
console.log(seen[0] === back, (back as CreateOptions).size)
const plain: CommandOptions = { timeoutMS: 5 }
console.log(command(plain), remember(plain) === plain, plain.session)
const view: ReadOnlyView = { capped: false, label: 'v' }
console.log(view.capped, view.label)
//! expect: true true tagged true 10
//! expect: true 20
//! expect: 5 true tagged
//! expect: false v
export {}
