import type { FunctionId, RegionId } from '../../identity/ids.js'

/**
 * The sealed `ExecutableBodyOwnershipReport` (architecture.md, "Definition of
 * done"). Every source executable region must be recorded exactly once before
 * any class header or module body renders: a legacy class method, accessor,
 * constructor, static-field initializer, or static block acquires its exact
 * lease before it emits source AST as C++, and a typed-IR member forwarder or
 * elided/structural region never competes for the same lease. This module is
 * the only place that lease bookkeeping happens.
 */

/**
 * A source executable region eligible to emit: a callable member keyed by its
 * checker-stable `FunctionId`, or a class static-lifecycle region keyed by its
 * censused `RegionId`. There is no third owner kind -- widening this union is
 * how a region could be recorded that admits no exact identity.
 */
export type ExecutableBodyOwner = FunctionId | RegionId

type LeaseState = 'acquired' | 'spent'

/**
 * An opaque handle. The real ledger lives in a module-private `WeakMap`, not
 * on the handle itself, so no caller can inspect, copy, or reconstruct
 * ownership state by holding a reference to the report -- the only way to
 * affect a lease is through `acquireLease`/`spendLease` below. In particular,
 * there is no function here that derives a lease or an owner from generated
 * C++ text: ownership is recorded once, from the identity that authored the
 * region, and never re-discovered from what that region rendered.
 */
export interface ExecutableBodyOwnershipReport {
  readonly brand: 'ExecutableBodyOwnershipReport'
}

const ledgers = new WeakMap<ExecutableBodyOwnershipReport, Map<ExecutableBodyOwner, LeaseState>>()

export const createOwnershipReport = (): ExecutableBodyOwnershipReport => {
  const report: ExecutableBodyOwnershipReport = { brand: 'ExecutableBodyOwnershipReport' }
  ledgers.set(report, new Map())
  return report
}

const ledgerOf = (report: ExecutableBodyOwnershipReport): Map<ExecutableBodyOwner, LeaseState> => {
  const ledger = ledgers.get(report)
  if (!ledger) throw new Error('ownership report was not created by createOwnershipReport')
  return ledger
}

/**
 * Records a region exactly once. A second acquisition for the same owner --
 * even after its lease has already been spent -- means two emission sites
 * believe they own one source region, which the sealed boundary must never
 * allow silently.
 */
export const acquireLease = (report: ExecutableBodyOwnershipReport, owner: ExecutableBodyOwner): void => {
  const ledger = ledgerOf(report)
  if (ledger.has(owner)) throw new Error(`executable body owner ${owner} already recorded; a region may acquire its lease exactly once`)
  ledger.set(owner, 'acquired')
}

/**
 * Consumes the lease immediately before the owner's C++ actually renders.
 * Spending an unacquired or already-spent lease names the exact owner, so the
 * defect is traceable to one region instead of a class of them.
 */
export const spendLease = (report: ExecutableBodyOwnershipReport, owner: ExecutableBodyOwner): void => {
  const ledger = ledgerOf(report)
  const state = ledger.get(owner)
  if (state === undefined) throw new Error(`executable body owner ${owner} has no acquired lease to spend`)
  if (state === 'spent') throw new Error(`executable body owner ${owner} lease was already spent`)
  ledger.set(owner, 'spent')
}
