//! dynamic-fallback
//! expect: SEMVER comparing 1 true
//! expect: a mid 2 3 end
//! expect: solo mid end
// semver's `debug = (...args) => console.error('SEMVER', ...args)`: leading
// values beside a spread, into a host call that joins its arguments. The
// whole argument list is packed into the one boxed list the joined runtime
// call takes.
'use strict'
const debug = (...args) => console.log('SEMVER', ...args)
const logAll = (first, ...rest) => console.log(first, 'mid', ...rest, 'end')
debug('comparing', 1, true)
logAll('a', 2, 3)
logAll('solo')
