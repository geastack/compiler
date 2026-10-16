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
  whenHypothesisSettles
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

test('settlement work runs once, at the outermost exit, and only when the guard settled as truth', () => {
  const settled = {}
  const unsettled = {}
  const closed = {}
  const ran: string[] = []
  enterHypothesisGuard(settled)
  enterHypothesisGuard(settled)
  enterHypothesisGuard(unsettled)
  whenHypothesisSettles(settled, () => ran.push('settled'))
  whenHypothesisSettles(unsettled, () => ran.push('unsettled'))
  // A key no guard holds open has nothing to wait for.
  whenHypothesisSettles(closed, () => ran.push('closed'))
  exitHypothesisGuard(settled, true, true)
  assert.deepEqual(ran, [])
  exitHypothesisGuard(settled, true, true)
  exitHypothesisGuard(unsettled, true, false)
  assert.deepEqual(ran, ['settled'])
  // A later episode of the same question starts with nothing waiting.
  enterHypothesisGuard(settled)
  exitHypothesisGuard(settled, true, true)
  assert.deepEqual(ran, ['settled'])
})
