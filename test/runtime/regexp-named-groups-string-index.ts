//! expect: id=42|action=edit|missing=absent|bare=7
//! expect: index=1|input=abc|group=b

// Reading a match's members at a NARROWED carrier.
//
// `RegExpExecArray`/`RegExpMatchArray` are compiler-owned native layouts:
// `representation/derive.ts` deliberately seals no record layout for them, so
// `recordFieldsOfShape` answers nothing and the generic narrowed-field read
// had no declared carrier to reconcile against. It handed back the bare
// member load, which is right only while the read is not narrowed.
//
// It is wrong the moment it is. `groups` stores
// `Optional<Ref<Dictionary<std::string>>>`, so after a `!== undefined` guard
// the bare load is an `Optional` where the payload was wanted: `->has`
// resolved on `gea::Ref`, which has no such member, and the program did not
// compile. node-compat's `apps/http-parity` router was the first case --
// `userMatch.groups['id']` on `/^\/user\/(?<id>\w+)/`.
//
// Both spellings of the key are here because they take different paths: a key
// held in a variable forces the computed read, a literal one could be taken
// by a property-access shortcut instead. And `index`/`input` are here because
// `MatchResult` declares those OPTIONAL too where `ExecResult` does not --
// the same hole, on the members whose storage differs by role.

const userMatch = /^\/user\/(?<id>\w+)(?:\/(?<action>\w+))?$/.exec('/user/42/edit')
if (userMatch === null || userMatch.groups === undefined) throw new Error('no match')
const groups = userMatch.groups

const idKey = 'id'
const id = groups[idKey]
const action = groups['action']
const missing = groups['nope']

const bare = /(?<n>\d+)/.exec('x7y')
if (bare === null || bare.groups === undefined) throw new Error('no bare match')

console.log(
  'id=' +
    (id === undefined ? 'absent' : id) +
    '|action=' +
    (action === undefined ? 'absent' : action) +
    '|missing=' +
    (missing === undefined ? 'absent' : missing) +
    '|bare=' +
    (bare.groups['n'] ?? 'absent')
)

// `String.prototype.match` with a non-global pattern: the exec-shaped answer,
// carried by `MatchResult`, whose `index`, `input` and `groups` are all
// optional storage narrowed away by these guards.
const matched = 'abc'.match(/(?<letter>b)/)
if (matched === null || matched.index === undefined || matched.input === undefined || matched.groups === undefined) {
  throw new Error('no match-result')
}
const at: number = matched.index
const from: string = matched.input
console.log('index=' + String(at) + '|input=' + from + '|group=' + matched.groups['letter'])
