// An object literal passed where a union of two option shapes is expected,
// `(Legacy | Timed) & { session? }`. The literal states every field of the
// legacy arm and an OPTIONAL `timeoutMS`, so which arm it is depends on whether
// `timeoutMS` holds a number at run time -- the callee asks exactly that with
// `'timeoutMS' in v && typeof v.timeoutMS === 'number'`. Choosing either arm
// at compile time answers that question wrongly for one of the two calls. A
// database driver's timeout context factory is the shape.

export {}

class Session {
  constructor(readonly name: string) {}
}

type Legacy = { serverSelectionTimeoutMS: number; waitQueueTimeoutMS: number; socketTimeoutMS?: number }
type Timed = { timeoutMS: number; serverSelectionTimeoutMS: number; socketTimeoutMS?: number }
type Options = (Legacy | Timed) & { session?: Session }

function isTimed(v: unknown): v is Timed {
  return (
    v != null &&
    typeof v === 'object' &&
    'serverSelectionTimeoutMS' in v &&
    typeof v.serverSelectionTimeoutMS === 'number' &&
    'timeoutMS' in v &&
    typeof v.timeoutMS === 'number'
  )
}

function isLegacy(v: unknown): v is Legacy {
  return (
    v != null &&
    typeof v === 'object' &&
    'serverSelectionTimeoutMS' in v &&
    typeof v.serverSelectionTimeoutMS === 'number' &&
    'waitQueueTimeoutMS' in v &&
    typeof v.waitQueueTimeoutMS === 'number'
  )
}

function create(options: Options): string {
  const owner = options.session?.name ?? 'none'
  if (isTimed(options)) return `timed:${options.timeoutMS}:${options.serverSelectionTimeoutMS}:${owner}`
  if (isLegacy(options)) return `legacy:${options.waitQueueTimeoutMS}:${options.serverSelectionTimeoutMS}:${owner}`
  throw new Error('Unrecognized options')
}

// Whichever arm holds the value, the object still owns every key the literal
// wrote -- `timeoutMS` even when it holds `undefined`.
function keys(options: Options): string {
  return `${'timeoutMS' in options}:${'waitQueueTimeoutMS' in options}`
}

function run(session: Session | undefined, timeoutMS: number | undefined): string {
  const options: Options = {
    session,
    serverSelectionTimeoutMS: 30000,
    waitQueueTimeoutMS: 5,
    timeoutMS
  }
  return `${create(options)}|${keys(options)}`
}

const timeouts: (number | undefined)[] = [undefined, 250]
for (const timeoutMS of timeouts) {
  console.log(run(undefined, timeoutMS))
  console.log(run(new Session('s'), timeoutMS))
}
//! expect: legacy:5:30000:none|true:true
//! expect: legacy:5:30000:s|true:true
//! expect: timed:250:30000:none|true:true
//! expect: timed:250:30000:s|true:true
