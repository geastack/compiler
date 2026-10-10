// A record recast into another layout keeps every field's presence. Presence
// bits are laid out for required fields too once the program deletes a
// declared field (so none can be a static constant); a positional initializer
// that skipped them put the optional bits on the required ones, and a database
// client's `TimeoutContext.create` saw `'serverSelectionTimeoutMS' in options` false.
type Legacy = { serverSelectionTimeoutMS: number; waitQueueTimeoutMS: number; socketTimeoutMS?: number }
type Csot = { timeoutMS: number; serverSelectionTimeoutMS: number; socketTimeoutMS?: number }
type Options = (Legacy | Csot) & { label?: string }

function isLegacy(v: unknown): v is Legacy {
  return v != null && typeof v === 'object' && 'serverSelectionTimeoutMS' in v && 'waitQueueTimeoutMS' in v
}
function create(options: Options): string {
  if (isLegacy(options)) return `legacy ${options.serverSelectionTimeoutMS}/${options.waitQueueTimeoutMS} ${'socketTimeoutMS' in options}`
  return 'unrecognized'
}

const scratch: { gone?: number; kept: number } = { gone: 1, kept: 2 }
delete scratch.gone
console.log('scratch', 'gone' in scratch, scratch.kept)

const built = { serverSelectionTimeoutMS: 30000, waitQueueTimeoutMS: 0 }
console.log(create(built))
const withSocket = { serverSelectionTimeoutMS: 5, waitQueueTimeoutMS: 6, socketTimeoutMS: 7 }
console.log(create(withSocket))

//! expect: scratch false 2
//! expect: legacy 30000/0 false
//! expect: legacy 5/6 true
