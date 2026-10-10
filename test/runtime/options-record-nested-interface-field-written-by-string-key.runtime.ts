// A TYPED OPTIONS RECORD WHOSE NESTED-INTERFACE FIELDS ARE WRITTEN AND READ
// THROUGH A STRING KEY ON AN `any` RECEIVER.
//
// A database client's `parseOptions` builds `ClientOptions` from
// `Object.create(null)` and fills it in `setOption(clientOptions: any, key, descriptor, values)` with
// `clientOptions[name] = values[0]`. `driverInfo: DriverInfo` is a required
// field whose carrier is a reference to the `DriverInfo` record, and its
// descriptor default is `{}`. The field dispatcher could box that field for a
// read but had no write recipe for it, so the program compiled and then aborted
// in the client constructor with "a declared field whose carrier this
// runtime cannot box or unbox". The write now takes the same checked
// `any -> DriverInfo` conversion an assertion takes: the exact struct by
// identity, any other object rebuilt as a checked record product, an array of
// them element by element. The field stays a native record, never a box.

interface Options {
  appName?: string
  driverInfo: DriverInfo
  infos: DriverInfo[]
  extra?: DriverInfo
  size: number
}

interface DriverInfo {
  name?: string
  version?: string
}

interface Descriptor {
  type: 'record' | 'string' | 'int' | 'any'
  default?: any
}

const DESCRIPTORS: Record<string, Descriptor> = {
  appName: { type: 'string', default: 'app' },
  driverInfo: { type: 'record', default: {} },
  infos: { type: 'any', default: [] },
  size: { type: 'int', default: 3 }
}

function setOption(target: any, name: string, value: unknown): void {
  target[name] = value
}

function parse(): Options {
  const out = Object.create(null)
  for (const [key, descriptor] of Object.entries(DESCRIPTORS)) setOption(out, key, descriptor.default)
  return out
}

const options = parse()
console.log(`name=${String(options.driverInfo.name)}`)
console.log(`infos=${options.infos.length}`)
console.log(`size=${options.size}`)
console.log(`app=${String(options.appName)}`)

const info: DriverInfo = { name: 'geatsc', version: '1' }
setOption(options, 'driverInfo', info)
console.log(`after=${String(options.driverInfo.name)}/${String(options.driverInfo.version)}`)
setOption(options, 'extra', info)
console.log(`extra=${String(options.extra?.name)}`)

const read = (options as any)['driverInfo'] as DriverInfo
console.log(`read=${String(read.name)} same=${String(read === info)}`)

//! expect: name=undefined
//! expect: infos=0
//! expect: size=3
//! expect: app=app
//! expect: after=geatsc/1
//! expect: extra=geatsc
//! expect: read=geatsc same=true
