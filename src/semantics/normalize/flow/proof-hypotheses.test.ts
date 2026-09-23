import assert from 'node:assert/strict'
import test from 'node:test'
import {
  enterHypothesisGuard,
  exitHypothesisGuard,
  hypothesisGuardIsOpen,
  hypothesisSettledAsTruth,
  noteHypothesis,
  popHypothesisTrail,
  pushHypothesisTrail,
  registerGuardedAnswer
} from './proof-hypotheses.js'

test('a guard stays open until the outermost re-entry leaves it', () => {
  const question = {}
  assert.equal(hypothesisGuardIsOpen(question), false)
  enterHypothesisGuard(question)
  enterHypothesisGuard(question)
  exitHypothesisGuard(question)
  // The guard sets are proof-local and the same question is re-entered through
  // two nesting proofs; a plain set would have declared it settled here, and
  // an answer computed by the outer proof would then look unconditional.
  assert.equal(hypothesisGuardIsOpen(question), true)
  exitHypothesisGuard(question)
  assert.equal(hypothesisGuardIsOpen(question), false)
})

test('a trail collects what the computation under it leaned on, and nothing from outside it', () => {
  const outerKey = {}
  const innerKey = {}
  const outer = pushHypothesisTrail()
  noteHypothesis(outerKey)
  const inner = pushHypothesisTrail()
  noteHypothesis(innerKey)
  popHypothesisTrail()
  popHypothesisTrail()
  assert.deepEqual([...inner], [innerKey])
  // The inner note does not reach the outer trail on its own: the inner memo
  // decides what it can ground and passes the keys outward itself.
  assert.deepEqual([...outer], [outerKey])
})

test('a note with no trail open is discarded rather than leaking into the next one', () => {
  const key = {}
  noteHypothesis(key)
  const trail = pushHypothesisTrail()
  popHypothesisTrail()
  assert.deepEqual([...trail], [])
})

test('a guard reports whether it handed out the answer the question turned out to have', () => {
  const settled = {}
  enterHypothesisGuard(settled)
  exitHypothesisGuard(settled, true, true)
  assert.equal(hypothesisSettledAsTruth(settled), true)

  // `confirmed` alone is the weaker claim -- the answer is still sound -- and
  // must not promote a refusal to a fact. Keeping these apart is the whole
  // difference between a memo that is complete and one that refuses programs
  // it used to compile.
  const confirmedOnly = {}
  enterHypothesisGuard(confirmedOnly)
  exitHypothesisGuard(confirmedOnly, true)
  assert.equal(hypothesisSettledAsTruth(confirmedOnly), false)
})

test('a settlement is recorded only when the outermost re-entry leaves the guard', () => {
  const question = {}
  enterHypothesisGuard(question)
  enterHypothesisGuard(question)
  exitHypothesisGuard(question, true, true)
  // The question is still being answered, so nothing about it is settled yet.
  assert.equal(hypothesisSettledAsTruth(question), false)
  exitHypothesisGuard(question, true, true)
  assert.equal(hypothesisSettledAsTruth(question), true)
})

test('reopening a guard clears what it settled last time', () => {
  const question = {}
  enterHypothesisGuard(question)
  exitHypothesisGuard(question, true, true)
  assert.equal(hypothesisSettledAsTruth(question), true)
  // The same question asked again may answer differently, and a trail noting
  // it now must not be discharged on the strength of the previous episode.
  enterHypothesisGuard(question)
  assert.equal(hypothesisSettledAsTruth(question), false)
  exitHypothesisGuard(question, true, false)
  assert.equal(hypothesisSettledAsTruth(question), false)
})

test('a refusal leaning on a guard is discharged when the guard settles', () => {
  const guard = {}
  enterHypothesisGuard(guard)
  const answer = { assumed: new Set<object>([guard]), refusal: true }
  registerGuardedAnswer(answer)
  exitHypothesisGuard(guard, true, true)
  assert.equal(answer.assumed.has(guard), false)
})

test('a refusal leaning on a guard that closes unsettled keeps the guard and stays in its bucket', () => {
  const guard = {}
  enterHypothesisGuard(guard)
  const answer = { assumed: new Set<object>([guard]), refusal: true }
  let discarded = false
  registerGuardedAnswer(answer, () => {
    discarded = true
  })
  // The question got an answer the re-entries were not handed: the refusal is
  // still true wherever the same guard is open again, and nowhere else.
  exitHypothesisGuard(guard, true, false)
  assert.equal(answer.assumed.has(guard), true)
  assert.equal(discarded, false)
})

test('a positive answer leaning on a pessimistic guard is discharged when the guard is confirmed', () => {
  const guard = {}
  enterHypothesisGuard(guard)
  const answer = { assumed: new Set<object>([guard]) }
  registerGuardedAnswer(answer)
  exitHypothesisGuard(guard, true)
  assert.equal(answer.assumed.has(guard), false)
})

test('a nested guard on the same key that closes unsettled vetoes the outer settlement', () => {
  // An invocation fact and a record method call both guard the call node; the
  // inner question answering something knowable must survive the outer one
  // settling, or a refusal that leaned on the inner one is promoted.
  const call = {}
  enterHypothesisGuard(call)
  enterHypothesisGuard(call)
  const answer = { assumed: new Set<object>([call]), refusal: true }
  registerGuardedAnswer(answer)
  exitHypothesisGuard(call, true, false)
  exitHypothesisGuard(call, true, true)
  assert.equal(hypothesisSettledAsTruth(call), false)
  assert.equal(answer.assumed.has(call), true)
})
