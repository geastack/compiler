/**
 * The hypotheses a whole-program proof is answering UNDER, and the trail each
 * computation leaves of the ones it leaned on.
 *
 * Two different things park a question in this compiler and both are
 * hypotheses in exactly the same sense:
 *
 * - an OPTIMISTIC park -- `activeMembers`, `activeFamilies`, an open record or
 *   value proof -- answers "closed" on the strength of a proof still running,
 *   so a POSITIVE answer that leaned on it is reusable only where the same
 *   park is in force. `callable-reach.ts` has always recorded these.
 * - a RE-ENTRY guard -- an invocation fact, a record method call, a slot read
 *   or a member-implementation walk already on the stack -- answers "unknown"
 *   for the same reason, so a REFUSAL that leaned on it is reusable only where
 *   that same question is still open. These were recorded nowhere, which is
 *   why no memo in the proof could keep a refusal: a refusal might have been
 *   false, and nothing said which ones could have been.
 *
 * Both are trails of object keys and one stack carries them, so a memo asks
 * one question of an answer -- "is every key it leaned on still in force" --
 * whichever kind of hypothesis produced it.
 *
 * MODULE level, not per proof: a nested question re-enters through a fresh
 * `indexCallableReach`, and only a shared stack sees across those frames.
 */
const trails: Set<object>[] = []
let notes = 0

/** Record that the computation now running leaned on `key` being assumed. */
export const noteHypothesis = (key: object): void => {
  notes++
  trails[trails.length - 1]?.add(key)
}

export const hypothesisNotes = (): number => notes

/** Begin collecting what a computation leans on; the returned set is its trail. */
export const pushHypothesisTrail = (): Set<object> => {
  const trail = new Set<object>()
  trails.push(trail)
  return trail
}

export const popHypothesisTrail = (): void => {
  trails.pop()
}

/**
 * Re-entry guards open right now, counted because the same question can be
 * re-entered through two nesting proofs and the outer one must keep it open
 * after the inner one returns.
 *
 * Counted rather than a plain set for a second reason: the guard SETS
 * themselves are proof-local (`activeInvocationFacts` is a fresh `Set` per
 * `indexCallableReach`), so "is this question still being answered" is a
 * question about the STACK, not about one proof's bookkeeping.
 */
const openGuards = new Map<object, number>()

/**
 * Keys whose guard closed having handed every re-entry exactly the answer the
 * question turned out to have.
 *
 * This is a STRICTLY STRONGER claim than `confirmed` below, and the two must
 * not be conflated. `confirmed` says a conservative answer stays SOUND now that
 * the real answer is known, which is true of every pessimistic guard by
 * construction. That is enough to keep an answer the memo already holds. It is
 * NOT enough to promote a REFUSAL from "true while this question was open" to
 * "true": a refusal computed under a guard that went on to answer something
 * knowable is weaker than the question deserves, and replaying it refuses
 * where a fresh walk would have succeeded -- a program that compiled stops
 * compiling. Certification needs completeness, not only soundness.
 *
 * `settled` is the completeness half: the guard handed out a refusal, and the
 * refusal was the truth. An answer that leaned on it lost nothing by leaning.
 *
 * A guard that reopens on the same key is answering the question again and may
 * answer it differently, so entering clears any settlement from last time; a
 * key is only ever noted while its guard is open, so no trail can carry a
 * settlement that belongs to a previous episode.
 */
const settledAsTruth = new WeakSet<object>()

export const hypothesisSettledAsTruth = (key: object): boolean => settledAsTruth.has(key)

export const enterHypothesisGuard = (key: object): void => {
  settledAsTruth.delete(key)
  openGuards.set(key, (openGuards.get(key) ?? 0) + 1)
}

/**
 * An answer a memo holds whose applicability still names hypotheses.
 *
 * `assumed` is deliberately mutable: a hypothesis is not permanent. The guard
 * that issued it eventually produces the REAL answer to the same question, and
 * when that answer is what the guard handed out, the hypothesis has become a
 * fact -- so the answers that leaned on it stop depending on it and are
 * reusable everywhere.
 */
export interface GuardedAnswer {
  readonly assumed: Set<object>
}

/**
 * A key nothing ever parks and no guard ever opens. An answer carrying it can
 * never apply again -- which is exactly what should happen to one that leaned
 * on a hypothesis the real answer went on to contradict.
 */
export const REFUTED_HYPOTHESIS: object = Object.freeze({ hypothesis: 'refuted' })

interface GuardLean {
  readonly answer: GuardedAnswer
  /** Removes the answer from the memo bucket holding it. */
  readonly discard: (() => void) | undefined
}
const guardDependents = new Map<object, GuardLean[]>()

/**
 * Hold `answer` for every open guard it leaned on, so closing that guard can
 * settle it. Without this a guard-leaning answer was simply discarded, and
 * measurement says that is nearly all of them: in 200,000 three.js proof
 * entries the member-closure memo computed 156,070 answers and KEPT 119 --
 * 155,951 were thrown away for naming an open guard. Every later ask of those
 * same questions then had to prove them again, which is where millions of
 * proof entries over 64 distinct questions come from.
 */
export const registerGuardedAnswer = (answer: GuardedAnswer, discard?: () => void): void => {
  for (const key of answer.assumed) {
    if (!openGuards.has(key)) continue
    let dependents = guardDependents.get(key)
    if (!dependents) guardDependents.set(key, (dependents = []))
    dependents.push({ answer, discard })
    hypothesisStats.registered++
  }
}

/**
 * `confirmed` says whether the answers that leaned on this hypothesis are
 * still sound once the real answer is known.
 *
 * Which way that falls depends on the KIND of hypothesis, and the two kinds
 * are opposites. A RE-ENTRY guard is pessimistic: it hands its re-entries
 * "unknown" -- a refusal, a null, an empty set -- so an answer computed under
 * it is conservative. If the real answer turns out to be KNOWN, that does not
 * make the conservative answer wrong; it only makes it weaker than it needed
 * to be, and a weaker sound answer is still sound. Such a guard confirms
 * either way. An OPTIMISTIC park is the reverse: it hands out "closed/true",
 * so an answer leaning on it is only as good as that claim and must be struck
 * when the claim fails.
 *
 * Getting this backwards is expensive and silent. Every guard enrolled here
 * is pessimistic, and every site reported "cannot tell": of 787,705 answers
 * registered in one three.js run, 0 were ever confirmed and 668,256 were struck
 * AND spliced out of their buckets. The memo then held almost nothing, which
 * is why the buckets never reached their cap (`droppedByLimit=0`) while the
 * same questions kept missing and re-proving.
 */
/** TEMPORARY INSTRUMENT -- not for landing. Counts how the discharge actually settles. */
export const hypothesisStats = { registered: 0, confirmed: 0, struck: 0, discarded: 0 }

export const exitHypothesisGuard = (key: object, confirmed?: boolean, settled?: boolean): void => {
  const remaining = (openGuards.get(key) ?? 0) - 1
  if (remaining > 0) {
    openGuards.set(key, remaining)
    return
  }
  openGuards.delete(key)
  if (settled === true) settledAsTruth.add(key)
  const dependents = guardDependents.get(key)
  if (dependents === undefined) return
  guardDependents.delete(key)
  for (const { answer, discard } of dependents) {
    answer.assumed.delete(key)
    if (confirmed === true) {
      hypothesisStats.confirmed++
      continue
    }
    hypothesisStats.struck++
    if (discard !== undefined) hypothesisStats.discarded++
    // The answer rested on something the real answer contradicted. Striking it
    // is not enough: a memo bucket is BOUNDED, and a dead answer sitting in it
    // keeps a live one out. The three.js app filled every bucket to the cap within the
    // first 200,000 proof entries and then refused 148,185 further answers.
    answer.assumed.add(REFUTED_HYPOTHESIS)
    discard?.()
  }
}

export const hypothesisGuardIsOpen = (key: object): boolean => openGuards.has(key)
