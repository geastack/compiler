// hono `router/reg-exp-router/trie.ts:10` and `router.ts:132` --
// `(path.match(/\/:/g) || []).length`. `String.prototype.match` publishes the
// native `gea::runtime::regex::MatchResult` or null, and the union join drops
// the `[]` arm (an array literal with no elements is already a value of the arm
// beside it), so the merge publishes MatchResult alone. The empty literal is
// then BUILT in that carrier -- MatchResult is an `ArrayObject<std::string>`
// with 22.1.3.13's optional named members beside it -- rather than converted
// into it, exactly as an empty arm merging into an `ArrayObject` already is.
const parameterCount = (path: string): number => (path.match(/\/:/g) || []).length

// The `??` spelling of the same join, and the same arm: `null` is the only
// value `match` publishes besides the record, so this reaches the identical
// merge through the nullish operator's own kept branch.
const separatorCount = (path: string): number => (path.match(/\//g) ?? []).length

console.log(parameterCount('/posts/:id/comments/:commentId'), parameterCount('/posts'))
console.log(separatorCount('/a/b/c'), separatorCount('bare'))
//! expect: 2 0
//! expect: 3 0
