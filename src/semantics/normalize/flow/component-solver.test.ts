import assert from 'node:assert/strict'
import test from 'node:test'
import { dependencyComponentSolver, dependencyFactSolver } from './component-solver.js'
import { seededOriginSolver } from './seeded-origins.js'

test('all-dependencies admits complete self and mutual recursion and expands each node once', () => {
  const graph = new Map<string, { locallyComplete: boolean; dependencies: readonly string[] }>([
    ['self', { locallyComplete: true, dependencies: ['self'] }],
    ['left', { locallyComplete: true, dependencies: ['right'] }],
    ['right', { locallyComplete: true, dependencies: ['left'] }]
  ])
  const expansions = new Map<string, number>()
  const solve = dependencyComponentSolver((key: string) => {
    expansions.set(key, (expansions.get(key) ?? 0) + 1)
    return graph.get(key)!
  }, 'all-dependencies')

  assert.equal(solve('left').status, 'complete')
  assert.equal(solve('right').status, 'complete')
  assert.equal(solve('self').status, 'complete')
  assert.deepEqual(
    [...expansions],
    [
      ['left', 1],
      ['right', 1],
      ['self', 1]
    ]
  )
})

test('a recursive dependency stays refused when one local frame is opaque', () => {
  const solve = dependencyComponentSolver(
    (key: string) =>
      key === 'left'
        ? { locallyComplete: true, dependencies: ['right'] }
        : { locallyComplete: false, dependencies: ['left'], causes: ['unknown-target'] },
    'all-dependencies'
  )
  assert.equal(solve('left').status, 'refused')
  assert.deepEqual(solve('left').explain(), [{ kind: 'opaque', root: 'right', cause: 'unknown-target', path: ['left', 'right'] }])
})

test('opaque terminal causes propagate through every dependency path lazily', () => {
  let causeReads = 0
  const opaque = (cause: string) =>
    Object.defineProperty({ locallyComplete: false, dependencies: [] as readonly string[] }, 'causes', {
      get: () => {
        causeReads += 1
        return [cause]
      }
    })
  const graph = new Map<string, { locallyComplete: boolean; dependencies: readonly string[]; causes?: readonly string[] }>([
    ['root', { locallyComplete: true, dependencies: ['left', 'right'] }],
    ['left', { locallyComplete: true, dependencies: ['opaque-a'] }],
    ['right', { locallyComplete: true, dependencies: ['opaque-b'] }],
    ['opaque-a', opaque('external-target')],
    ['opaque-b', opaque('spread-frame')]
  ])
  const solve = dependencyComponentSolver((key: string) => graph.get(key)!, 'all-dependencies')
  const result = solve('root')
  assert.equal(result.status, 'refused')
  assert.equal(causeReads, 0)
  const reasons = result.explain()
  assert.equal(causeReads, 2)
  assert.deepEqual(
    reasons.map((reason) => {
      assert.equal(reason.kind, 'opaque')
      if (reason.kind !== 'opaque') throw new Error('expected an opaque terminal cause')
      const { kind, root, cause, path } = reason
      return { kind, root, cause, path }
    }),
    [
      { kind: 'opaque', root: 'opaque-a', cause: 'external-target', path: ['root', 'left', 'opaque-a'] },
      { kind: 'opaque', root: 'opaque-b', cause: 'spread-frame', path: ['root', 'right', 'opaque-b'] }
    ]
  )
})

test('an incomplete node without an authored cause remains an explicit root', () => {
  const solve = dependencyComponentSolver(
    (key: string) => (key === 'root' ? { locallyComplete: true, dependencies: ['unknown'] } : { locallyComplete: false, dependencies: [] }),
    'all-dependencies'
  )
  assert.deepEqual(solve('root').explain(), [{ kind: 'incomplete-node', root: 'unknown', path: ['root', 'unknown'] }])
})

test('seeded-origin wrapper retains seeded, vacuous and unseeded-cycle behavior', () => {
  const graph = new Map<string, { seed: boolean; admitted: boolean; dependencies: readonly string[] }>([
    ['seeded-a', { seed: false, admitted: true, dependencies: ['seeded-b'] }],
    ['seeded-b', { seed: true, admitted: true, dependencies: ['seeded-a'] }],
    ['empty', { seed: false, admitted: true, dependencies: [] }],
    ['cycle-a', { seed: false, admitted: true, dependencies: ['cycle-b'] }],
    ['cycle-b', { seed: false, admitted: true, dependencies: ['cycle-a'] }],
    ['sibling', { seed: true, admitted: true, dependencies: [] }],
    ['grounded-a', { seed: false, admitted: true, dependencies: ['grounded-b', 'sibling'] }],
    ['grounded-b', { seed: false, admitted: true, dependencies: ['grounded-a'] }],
    ['mixed', { seed: false, admitted: true, dependencies: ['cycle-a', 'sibling'] }],
    ['opaque', { seed: false, admitted: false, dependencies: [] }]
  ])
  const origins = seededOriginSolver((key: string) => graph.get(key)!)
  assert.equal(origins('seeded-a'), 'allocated')
  assert.equal(origins('seeded-b'), 'allocated')
  assert.equal(origins('empty'), 'vacuous')
  assert.equal(origins('cycle-a'), 'refused')
  assert.equal(origins('cycle-b'), 'refused')
  assert.equal(origins('grounded-a'), 'allocated', 'a proven dependency allocation grounds the whole cycle')
  assert.equal(origins('grounded-b'), 'allocated')
  assert.equal(origins('mixed'), 'refused', 'a separate allocation cannot seed an ungrounded dependency cycle')
  assert.equal(origins('opaque'), 'refused')
})

test('seeded-origin grounding can come from a completed dependency component', () => {
  const origins = seededOriginSolver((key: string) =>
    key === 'root' ? { seed: false, admitted: true, dependencies: ['leaf'] } : { seed: true, admitted: true, dependencies: [] }
  )
  assert.equal(origins('root'), 'allocated')
})

test('seeded-origin explanation names an ungrounded recursive component', () => {
  const solve = dependencyComponentSolver(
    (key: string) => ({ locallyComplete: true, dependencies: [key === 'left' ? 'right' : 'left'] }),
    'seeded-origin'
  )
  const result = solve('left')
  assert.equal(result.status, 'refused')
  assert.deepEqual(result.explain(), [{ kind: 'unseeded-cycle', members: ['right', 'left'], path: ['left'] }])
})

test('fact propagation discovers every receiver target and is independent of query order', () => {
  const makeSolver = () =>
    dependencyFactSolver<string, string, string>((key) => {
      if (key === 'origins')
        return {
          transfer: () => new Set(['ClassA', 'ClassB']),
          seal: () => ({ locallyComplete: true, seed: true })
        }
      if (key === 'invoke')
        return {
          transfer: (read) => {
            const facts = new Set<string>()
            for (const receiver of read('origins')) for (const target of read(`${receiver}.method`)) facts.add(target)
            return facts
          },
          seal: (read) => {
            read('origins')
            return { locallyComplete: true }
          }
        }
      if (key === 'ClassA.method' || key === 'ClassB.method')
        return {
          transfer: () => new Set([key.replace('.method', '.run')]),
          seal: () => ({ locallyComplete: true })
        }
      throw new Error(`unexpected node: ${key}`)
    }, 'all-dependencies').solve

  const forward = makeSolver()
  const forwardResult = forward('invoke')
  assert.equal(forwardResult.status, 'complete')
  if (forwardResult.status !== 'complete') throw new Error('expected a complete invocation')
  assert.deepEqual([...forwardResult.facts].sort(), ['ClassA.run', 'ClassB.run'])
  assert.equal(forward('origins').status, 'complete')

  const reversed = makeSolver()
  assert.equal(reversed('origins').status, 'complete')
  const reversedResult = reversed('invoke')
  assert.equal(reversedResult.status, 'complete')
  if (reversedResult.status !== 'complete') throw new Error('expected a complete invocation')
  assert.deepEqual([...reversedResult.facts].sort(), [...forwardResult.facts].sort())
})

test('an unseeded recursive origin branch cannot borrow a sibling allocation', () => {
  const { solve } = dependencyFactSolver<string, string, string>((key) => {
    if (key === 'mixed')
      return {
        transfer: (read) => new Set([...read('cycle'), ...read('allocation')]),
        seal: (read) => {
          read('cycle')
          read('allocation')
          return { locallyComplete: true }
        }
      }
    if (key === 'cycle')
      return {
        transfer: (read) => read('cycle'),
        seal: (read) => {
          read('cycle')
          return { locallyComplete: true }
        }
      }
    if (key === 'allocation')
      return {
        transfer: () => new Set(['Item']),
        seal: () => ({ locallyComplete: true, seed: true })
      }
    throw new Error(`unexpected node: ${key}`)
  }, 'seeded-origin')

  const result = solve('mixed')
  assert.equal(result.status, 'refused')
  assert.equal('facts' in result, false, 'partial values from the allocation sibling are not public')
  assert.deepEqual(result.explain(), [{ kind: 'unseeded-cycle', members: ['cycle'], path: ['mixed', 'cycle'] }])
})

test('facts propagate beside an opaque sibling, while closure refuses the partial result', () => {
  const { solve } = dependencyFactSolver<string, string, string>((key) => {
    if (key === 'root')
      return {
        transfer: (read) => new Set([...read('known'), ...read('opaque')]),
        seal: (read) => {
          read('known')
          read('opaque')
          return { locallyComplete: true }
        }
      }
    if (key === 'known')
      return {
        transfer: () => new Set(['known-target']),
        seal: () => ({ locallyComplete: true })
      }
    if (key === 'opaque')
      return {
        transfer: () => new Set<string>(),
        seal: () => ({ locallyComplete: false, causes: ['unknown-target'] })
      }
    throw new Error(`unexpected node: ${key}`)
  }, 'all-dependencies')

  const result = solve('root')
  assert.equal(result.status, 'refused')
  assert.equal('facts' in result, false, 'partially propagated target sets remain internal')
  assert.deepEqual(result.explain(), [{ kind: 'opaque', root: 'opaque', cause: 'unknown-target', path: ['root', 'opaque'] }])
})

test('grounding domains do not let a sibling allocation or function identity ground an empty origin cycle', () => {
  const allocation = 'allocation-origin'
  const functionIdentity = 'function-identity'
  const solve = dependencyComponentSolver<string, string>((key) => {
    if (key === 'root')
      return {
        locallyComplete: true,
        dependencies: ['origin-a', 'sibling-allocation'],
        groundingDependencies: [{ domain: allocation, dependency: 'sibling-allocation' }]
      }
    if (key === 'origin-a')
      return {
        locallyComplete: true,
        dependencies: ['origin-b', 'known-function-target', 'obligation-only-allocation'],
        groundingRequirements: [allocation],
        groundingDependencies: [{ domain: functionIdentity, dependency: 'known-function-target' }]
      }
    if (key === 'origin-b')
      return {
        locallyComplete: true,
        dependencies: ['origin-a'],
        groundingRequirements: [allocation]
      }
    if (key === 'known-function-target')
      return {
        locallyComplete: true,
        dependencies: ['cross-domain-allocation'],
        groundingSeeds: [functionIdentity],
        groundingDependencies: [{ domain: allocation, dependency: 'cross-domain-allocation' }]
      }
    if (key === 'cross-domain-allocation') return { locallyComplete: true, dependencies: [], groundingSeeds: [allocation] }
    if (key === 'obligation-only-allocation')
      return {
        locallyComplete: true,
        dependencies: ['origin-a'],
        groundingSeeds: [allocation]
      }
    if (key === 'sibling-allocation') return { locallyComplete: true, dependencies: [], groundingSeeds: [allocation] }
    throw new Error(`unexpected node: ${key}`)
  }, 'grounding-domains')

  const result = solve('root')
  assert.equal(result.status, 'refused')
  assert.equal(result.groundedDomains.has(allocation), true, 'the acyclic root can see its sibling origin')
  const cycle = result.explain()[0]
  assert.equal(cycle?.kind, 'unseeded-cycle')
  if (cycle?.kind !== 'unseeded-cycle' || !('domain' in cycle)) throw new Error('expected a domain-specific cycle cause')
  assert.equal(cycle.domain, allocation)
  assert.deepEqual(new Set(cycle.members), new Set(['origin-a', 'origin-b', 'obligation-only-allocation']))
  assert.deepEqual(cycle.path, ['root', 'origin-a'])
})

test('a verified allocation grounds a mixed origin and invocation component through its labelled origin edge', () => {
  const allocation = 'allocation-origin'
  const solve = dependencyComponentSolver<string, string>((key) => {
    if (key === 'origin')
      return {
        locallyComplete: true,
        dependencies: ['invocation-target', 'allocation'],
        groundingRequirements: [allocation],
        groundingDependencies: [{ domain: allocation, dependency: 'allocation' }]
      }
    if (key === 'invocation-target') return { locallyComplete: true, dependencies: ['origin'] }
    if (key === 'allocation') return { locallyComplete: true, dependencies: [], groundingSeeds: [allocation] }
    throw new Error(`unexpected node: ${key}`)
  }, 'grounding-domains')

  const result = solve('origin')
  assert.equal(result.status, 'complete')
  assert.equal(result.groundedDomains.has(allocation), true)
  assert.deepEqual(result.explain(), [])
})

test('recursive invocation components need complete targets, not allocation seeds', () => {
  const solve = dependencyComponentSolver<string, string>(
    (key) =>
      key === 'left-call'
        ? { locallyComplete: true, dependencies: ['right-call'] }
        : { locallyComplete: true, dependencies: ['left-call'] },
    'grounding-domains'
  )
  const result = solve('left-call')
  assert.equal(result.status, 'complete')
  assert.equal(result.grounded, false)
  assert.equal(result.groundedDomains.size, 0)
})

test('observed candidates are discovered without becoming closure requirements', () => {
  let candidateExpanded = false
  const { solve } = dependencyFactSolver<string, string, string>((key) => {
    if (key === 'query')
      return {
        transfer: (_read, observe) => {
          observe('candidate')
          return new Set<string>()
        },
        seal: (read, observe) => {
          observe('candidate')
          read('certified-closure')
          return { locallyComplete: true }
        }
      }
    if (key === 'candidate') {
      candidateExpanded = true
      return { transfer: () => new Set<string>(), seal: () => ({ locallyComplete: false, causes: ['unrelated-opaque-candidate'] }) }
    }
    if (key === 'certified-closure') return { transfer: () => new Set<string>(), seal: () => ({ locallyComplete: true }) }
    throw new Error(`unexpected node: ${key}`)
  }, 'all-dependencies')

  const result = solve('query')
  assert.equal(candidateExpanded, true, 'observation still discovers and expands the candidate')
  assert.equal(result.status, 'complete', 'the separately required closure alone controls completeness')
  assert.deepEqual(result.explain(), [], 'an observed-only opaque node is outside the closure explanation')
})

test('upgrading an observation to a required read refuses with the dependency path', () => {
  const { solve } = dependencyFactSolver<string, string, string>((key) => {
    if (key === 'query')
      return {
        transfer: (_read, observe) => {
          observe('opaque-candidate')
          return new Set<string>()
        },
        seal: (read, observe) => {
          observe('opaque-candidate')
          read('opaque-candidate')
          return { locallyComplete: true }
        }
      }
    if (key === 'opaque-candidate')
      return { transfer: () => new Set<string>(), seal: () => ({ locallyComplete: false, causes: ['unknown-callers'] }) }
    throw new Error(`unexpected node: ${key}`)
  }, 'all-dependencies')

  const result = solve('query')
  assert.equal(result.status, 'refused')
  assert.deepEqual(result.explain(), [
    { kind: 'opaque', root: 'opaque-candidate', cause: 'unknown-callers', path: ['query', 'opaque-candidate'] }
  ])
})

test('observed fact growth revisits its dependent transfer', () => {
  let queryTransfers = 0
  const { solve } = dependencyFactSolver<string, string, string>((key) => {
    if (key === 'query')
      return {
        transfer: (_read, observe) => {
          queryTransfers++
          return observe('candidate')
        },
        seal: (_read, observe) => {
          observe('candidate')
          return { locallyComplete: true }
        }
      }
    if (key === 'candidate')
      return {
        transfer: (read) => read('leaf'),
        seal: (read) => {
          read('leaf')
          return { locallyComplete: true }
        }
      }
    if (key === 'leaf') return { transfer: () => new Set(['discovered-target']), seal: () => ({ locallyComplete: true }) }
    throw new Error(`unexpected node: ${key}`)
  }, 'all-dependencies')

  const result = solve('query')
  assert.equal(result.status, 'complete')
  if (result.status !== 'complete') throw new Error('expected observed facts to settle')
  assert.ok(queryTransfers > 1, 'the query transfer reruns after the observed candidate grows')
  assert.deepEqual([...result.facts], ['discovered-target'])
})

test('observations preserve query-order-independent discovery and closure', () => {
  const makeSolver = () =>
    dependencyFactSolver<string, string, string>((key) => {
      if (key === 'query')
        return {
          transfer: (read, observe) => new Set([...observe('candidate'), ...read('closure')]),
          seal: (read, observe) => {
            observe('candidate')
            read('closure')
            return { locallyComplete: true }
          }
        }
      if (key === 'candidate') return { transfer: () => new Set(['candidate-target']), seal: () => ({ locallyComplete: true }) }
      if (key === 'closure') return { transfer: () => new Set(['certified-target']), seal: () => ({ locallyComplete: true }) }
      if (key === 'other-root')
        return {
          transfer: (read) => read('query'),
          seal: (read) => {
            read('query')
            return { locallyComplete: true }
          }
        }
      throw new Error(`unexpected node: ${key}`)
    }, 'all-dependencies').solve

  const forward = makeSolver()
  const forwardQuery = forward('query')
  const forwardOther = forward('other-root')
  const reverse = makeSolver()
  const reverseOther = reverse('other-root')
  const reverseQuery = reverse('query')
  assert.equal(forwardQuery.status, 'complete')
  assert.equal(reverseQuery.status, 'complete')
  assert.equal(forwardOther.status, 'complete')
  assert.equal(reverseOther.status, 'complete')
  if (forwardQuery.status !== 'complete' || reverseQuery.status !== 'complete') throw new Error('expected complete query roots')
  if (forwardOther.status !== 'complete' || reverseOther.status !== 'complete') throw new Error('expected complete dependent roots')
  assert.deepEqual([...forwardQuery.facts].sort(), ['candidate-target', 'certified-target'])
  assert.deepEqual([...reverseQuery.facts].sort(), [...forwardQuery.facts].sort())
  assert.deepEqual([...forwardOther.facts].sort(), [...forwardQuery.facts].sort())
  assert.deepEqual([...reverseOther.facts].sort(), [...forwardQuery.facts].sort())
  assert.deepEqual(forwardQuery.explain(), reverseQuery.explain())
})

test('an observed edge cannot carry a required grounding witness', () => {
  const origin = 'allocation-origin'
  const { solve } = dependencyFactSolver<string, string, string>((key) => {
    if (key === 'origin')
      return {
        transfer: (_read, observe) => {
          observe('allocation')
          return new Set<string>()
        },
        seal: (_read, observe) => {
          observe('allocation')
          return {
            locallyComplete: true,
            groundingRequirements: [origin],
            groundingDependencies: [{ domain: origin, dependency: 'allocation' }]
          }
        }
      }
    if (key === 'allocation')
      return { transfer: () => new Set(['Item']), seal: () => ({ locallyComplete: true, groundingSeeds: [origin] }) }
    throw new Error(`unexpected node: ${key}`)
  }, 'grounding-domains')

  assert.throws(() => solve('origin'), /grounding dependency must also be a closure dependency/)
})

test('grounded facts are query-order independent and opaque siblings still refuse', () => {
  const makeSolver = () =>
    dependencyFactSolver<string, string, string>((key) => {
      if (key === 'entry')
        return {
          transfer: (read) => new Set([...read('origin'), ...read('opaque')]),
          seal: (read) => {
            read('origin')
            read('opaque')
            return { locallyComplete: true }
          }
        }
      if (key === 'origin')
        return {
          transfer: (read) => new Set([...read('call-fact'), ...read('allocation')]),
          seal: (read) => {
            read('call-fact')
            read('allocation')
            return {
              locallyComplete: true,
              groundingRequirements: ['allocation-origin'],
              groundingDependencies: [{ domain: 'allocation-origin', dependency: 'allocation' }]
            }
          }
        }
      if (key === 'call-fact')
        return {
          transfer: (read) => read('origin'),
          seal: (read) => {
            read('origin')
            return { locallyComplete: true }
          }
        }
      if (key === 'allocation')
        return {
          transfer: () => new Set(['Item']),
          seal: () => ({ locallyComplete: true, groundingSeeds: ['allocation-origin'] })
        }
      if (key === 'opaque')
        return {
          transfer: () => new Set<string>(),
          seal: () => ({ locallyComplete: false, causes: ['external-caller'] })
        }
      throw new Error(`unexpected node: ${key}`)
    }, 'grounding-domains').solve

  const first = makeSolver()
  const firstOrigin = first('origin')
  assert.equal(firstOrigin.status, 'complete')
  const firstEntry = first('entry')
  assert.equal(firstEntry.status, 'refused')

  const reversed = makeSolver()
  const reversedEntry = reversed('entry')
  assert.equal(reversedEntry.status, 'refused')
  const reversedOrigin = reversed('origin')
  assert.equal(reversedOrigin.status, 'complete')
  if (firstOrigin.status !== 'complete' || reversedOrigin.status !== 'complete') throw new Error('expected complete origin facts')
  assert.deepEqual([...reversedOrigin.facts], [...firstOrigin.facts])
  assert.deepEqual(firstEntry.explain(), reversedEntry.explain())
  assert.deepEqual(firstEntry.explain(), [{ kind: 'opaque', root: 'opaque', cause: 'external-caller', path: ['entry', 'opaque'] }])
})

// `holdersOf` inverts `read`/`observe`: instead of a node naming the
// dependencies it might hold a fact from, it asks the solver which nodes
// already hold a given fact VALUE. This is what `unknown-reads` in
// `source-value-session.ts` uses to stop 570 containers each `observe`-ing
// the same 968 computed-key receivers -- see the type's own doc comment in
// component-solver.ts for the full shape.

test('holdersOf finds a holder that appears only after the subscriber already ran', () => {
  const { solve, seed } = dependencyFactSolver<string, string, string>((key) => {
    if (key === 'subscriber')
      return {
        transfer: (_read, _observe, holdersOf) => new Set(holdersOf('container')),
        seal: () => ({ locallyComplete: true })
      }
    if (key === 'late-candidate') return { transfer: () => new Set(['container']), seal: () => ({ locallyComplete: true }) }
    throw new Error(`unexpected node: ${key}`)
  }, 'all-dependencies')

  const before = solve('subscriber')
  assert.equal(before.status, 'complete')
  if (before.status !== 'complete') throw new Error('expected a complete subscriber')
  assert.deepEqual([...before.facts], [], 'no candidate has published the fact yet')

  // Nothing in the graph reads or observes `late-candidate` -- a reverse
  // index only finds nodes that already exist, so the caller must
  // materialise it explicitly, exactly as `source-value-session.ts` seeds
  // every unknown-read receiver once for the session.
  seed('late-candidate')
  const after = solve('subscriber')
  assert.equal(after.status, 'complete')
  if (after.status !== 'complete') throw new Error('expected a complete subscriber')
  assert.deepEqual(
    [...after.facts],
    ['late-candidate'],
    'the value-subscription registered by the first call wakes the subscriber once the fact is published, with no edge named up front'
  )
})

test('holdersOf finds every state that publishes the same fact', () => {
  const { solve, seed } = dependencyFactSolver<string, string, string>((key) => {
    if (key === 'subscriber')
      return {
        transfer: (_read, _observe, holdersOf) => new Set(holdersOf('shared-fact')),
        seal: () => ({ locallyComplete: true })
      }
    if (key === 'candidate-a' || key === 'candidate-b')
      return { transfer: () => new Set(['shared-fact']), seal: () => ({ locallyComplete: true }) }
    throw new Error(`unexpected node: ${key}`)
  }, 'all-dependencies')

  seed('candidate-a')
  seed('candidate-b')
  const result = solve('subscriber')
  assert.equal(result.status, 'complete')
  if (result.status !== 'complete') throw new Error('expected a complete subscriber')
  assert.deepEqual([...result.facts].sort(), ['candidate-a', 'candidate-b'])
})

test('holdersOf returns nothing for a fact nobody has ever published', () => {
  const { solve } = dependencyFactSolver<string, string, string>((key) => {
    if (key === 'subscriber')
      return {
        transfer: (_read, _observe, holdersOf) => new Set(holdersOf('never-published')),
        seal: () => ({ locallyComplete: true })
      }
    throw new Error(`unexpected node: ${key}`)
  }, 'all-dependencies')

  const result = solve('subscriber')
  assert.equal(result.status, 'complete')
  if (result.status !== 'complete') throw new Error('expected a complete subscriber')
  assert.deepEqual([...result.facts], [], 'an empty holder set is a valid answer, not a refusal')
})

test('a seeded node with no subscriber still transfers and publishes its facts', () => {
  let transferred = false
  const { solve, seed } = dependencyFactSolver<string, string, string>((key) => {
    if (key === 'lonely-candidate')
      return {
        transfer: () => {
          transferred = true
          return new Set(['candidate-fact'])
        },
        seal: () => ({ locallyComplete: true })
      }
    if (key === 'unrelated-root') return { transfer: () => new Set<string>(), seal: () => ({ locallyComplete: true }) }
    throw new Error(`unexpected node: ${key}`)
  }, 'all-dependencies')

  seed('lonely-candidate')
  assert.equal(transferred, false, 'seed only schedules the node -- nothing has drained the queue yet')
  const result = solve('unrelated-root')
  assert.equal(result.status, 'complete')
  assert.equal(
    transferred,
    true,
    'a root query drains the whole shared queue, including a seeded node nobody reads, observes, or asks holdersOf about'
  )
})
