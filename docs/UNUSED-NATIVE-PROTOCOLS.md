# Pruning unused native protocols

The compiler already shakes unreachable TypeScript bodies. Native linking also
discards unreachable function sections. Neither removes functions kept reachable
by generated virtual tables or runtime registration tables. Emitting those
registrations is therefore a size decision, not harmless boilerplate.

## Index-property hooks

Previously `targets/cpp/records.ts` emitted index-property presence, enumeration,
read, write, descriptor, definition, deletion, and integrity hooks even for a
layout with no index sidecar. Their bodies returned false, returned true for an
empty integrity check, or forwarded to a similarly empty base. In class
hierarchies these hooks are virtual, so allocated instances retain their bodies
through their virtual tables. Full reflection also advertises an index capability
which the object does not actually need.

`projection/index-protocols.ts` now publishes whether a physical class family
needs this protocol. A family with no index storage omits it. A descendant with
an index signature retains support on its ancestors and siblings, preserving
virtual dispatch through a base handle. Missing shape or ancestry evidence and
native ancestry retain support conservatively. Structural records use their
published index-sidecar layout directly.

The fixed-field protocol remains intact. Dynamic properties without a declared
index signature continue to live in the runtime expando; removing empty typed
index hooks must not remove that storage or its reflection semantics. Typed
index writes retain their native value carrier and the existing complete
fixed-field predicate/definition/deletion protocol.

## Validation status

Five focused projection tests exercise absence, descendant storage, sibling
closure, missing layouts, and missing bases. These tests were executed by
transpiling the two source modules in memory; they do not constitute a rebuilt
compiler or native execution check.

The runtime fixture `test/runtime/no-index-protocol.runtime.ts` checks omitted
hooks together with fixed fields, a dynamically defined expando, enumeration,
sealing, and freezing. Existing indexed-class fixtures provide the complementary
retention coverage. Native execution, the emitted-set gate, and a new M5 firmware
measurement remain pending: the shared compiler currently has unrelated
incomplete conversion-contract changes which fail TypeScript compilation. No
binary saving is claimed from this unverified implementation.

## Remaining retention

This change does not remove every source of excess flash. Generic dynamic Array
method lookup still registers multiple methods together, and the native style
engine has its own broad dispatch dependencies. Pruning those requires separate
proofs about surviving property-key accesses and engine capabilities. An unknown
runtime key must retain all methods it can legitimately select. Omitting those
methods solely because a fixture never exercised them would change program
semantics.
