// Helper module for namespace-member-through-reexported-namespace.runtime.ts:
// re-exports a namespace import by name, the way a binary-document serializer's
// index exports its own namespace and node-compat's dns.ts exports `promises`.
import * as inner from './_namespace-reexport-inner'
export { inner }
