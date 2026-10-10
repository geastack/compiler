//! expect: cause:boom
//! expect: absent:true
//! expect: present:true boom

// A database client's errors: `class ServiceError extends Error { override cause?:
// Error }`, and its bulk executor's `bulkWriteError.cause = error`. The override
// declares no storage of its own -- the struct holds the one `cause` its
// native `gea::runtime::Error` base declares, a dynamic cell -- so the store
// must enter that cell, not the `Error | undefined` the declaration names.

class ServiceError extends Error {
  override cause?: Error
  constructor(message: string) {
    super(message)
  }
}

class BulkWriteError extends ServiceError {}

const bulk = new BulkWriteError('bulk failed')
console.log('absent:' + (bulk.cause === undefined))
bulk.cause = new Error('boom')
console.log('cause:' + bulk.cause.message)
console.log('present:' + ('cause' in bulk) + ' ' + (bulk.cause?.message ?? 'none'))
