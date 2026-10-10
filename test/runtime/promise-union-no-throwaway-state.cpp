// `co_return u;` / `co_await gea::awaitValue(u)` where `u` is a sum whose live
// arm is either a plain value or a `Promise<V>` to adopt -- a database
// client's operation-execution family and its hand-written
// async iterator both pass a value through exactly this shape (an operation,
// or a generator step, that may answer synchronously or not, met by a
// declared `Promise<V>` result).
//
// Before this fix, a live PLAIN-VALUE arm was routed through `Promise<V>`'s
// converting constructor before being resolved/awaited -- a second
// `PromiseState<V>`, immediately fulfilled, that lived only long enough to be
// read back out and discarded. This pins that neither `settleCoroutineResult`
// (`co_return`) nor `awaitValue`'s `TaggedUnionAwaiter` (`await`) mint that
// throwaway state any more: exactly ONE `PromiseState<int>` is created per
// call -- the coroutine's own result -- whichever arm is live, and the
// promise arm still genuinely suspends rather than resolving early.
//
// `Promise<V>::then` reaches the identical shape from a `.then()` handler
// that returns the union instead of a coroutine that returns or awaits it,
// through `settleThenFromHandled`/`settleFromUnionArm` -- the SAME dispatch,
// not a second one that could answer differently. It has one failure mode
// the coroutine paths cannot: `resolveHandled`'s old route through
// `resolveLiveArm` returned an ALREADY-SETTLED promise arm unchanged (never
// calling `adopt`), so `settleThenResult`'s runtime `.settled()` check took
// the direct-resolve branch instead -- settling the `.then()` result in the
// SAME reaction job, one job earlier than 27.2.1.3.2 gives any thenable
// resolution, settled or not. The block below pins that a promise arm is
// always adopted -- an extra queued job -- however settled it already is.
#include "gea_runtime.h"
#include <cassert>

using IntOrPromise = gea::TaggedUnion<int, gea::Promise<int>>;

static gea::Promise<int> relayReturn(IntOrPromise u) {
  co_await gea::awaitValue(0);  // any suspension makes this a real coroutine
  co_return u;
}

static gea::Promise<int> relayAwait(IntOrPromise u) {
  int v = co_await gea::awaitValue(u);
  co_return v;
}

int main() {
  const auto& states = gea::detail::allocationTypeProfile<gea::detail::PromiseState<int>>();

  // `co_return` of a plain-value arm: only the coroutine's OWN result promise
  // is minted.
  {
    auto before = states.created;
    IntOrPromise u = IntOrPromise::ofArm<0>(42);
    gea::Promise<int> p = relayReturn(u);
    gea::detail::drainPromiseJobs();
    assert(p.settled() && !p.rejected() && p.value() == 42);
    assert(states.created - before == 1);
  }

  // `await` of a plain-value arm: same -- no throwaway state for the arm.
  {
    auto before = states.created;
    IntOrPromise u = IntOrPromise::ofArm<0>(7);
    gea::Promise<int> p = relayAwait(u);
    gea::detail::drainPromiseJobs();
    assert(p.settled() && !p.rejected() && p.value() == 7);
    assert(states.created - before == 1);
  }

  // `co_return` of a genuinely pending promise arm still adopts -- it does
  // not resolve early, and it does not fold into the fast path above.
  {
    gea::Promise<int> inner;
    IntOrPromise u = IntOrPromise::ofArm<1>(inner);
    gea::Promise<int> p = relayReturn(u);
    gea::detail::drainPromiseJobs();
    assert(!p.settled());
    inner.resolve(99);
    gea::detail::drainPromiseJobs();
    assert(p.settled() && !p.rejected() && p.value() == 99);
  }

  // `await` of a genuinely pending promise arm still suspends on it.
  {
    gea::Promise<int> inner;
    IntOrPromise u = IntOrPromise::ofArm<1>(inner);
    gea::Promise<int> p = relayAwait(u);
    gea::detail::drainPromiseJobs();
    assert(!p.settled());
    inner.resolve(123);
    gea::detail::drainPromiseJobs();
    assert(p.settled() && !p.rejected() && p.value() == 123);
  }

  // A rejected promise arm still rejects the coroutine's own promise, through
  // both paths.
  {
    gea::Promise<int> inner;
    IntOrPromise u = IntOrPromise::ofArm<1>(inner);
    gea::Promise<int> p = relayAwait(u);
    try {
      throw std::runtime_error("boom");
    } catch (...) {
      inner.reject(std::current_exception());
    }
    gea::detail::drainPromiseJobs();
    assert(p.settled() && p.rejected());
  }

  // `.then()` of a plain-value arm: only the result `.then()` itself mints is
  // created -- no throwaway state for the arm.
  {
    gea::Promise<int> source(1);
    auto before = states.created;
    gea::Promise<int> result = source.then([](int) -> IntOrPromise { return IntOrPromise::ofArm<0>(84); });
    gea::detail::drainPromiseJobs();
    assert(result.settled() && !result.rejected() && result.value() == 84);
    assert(states.created - before == 1);
  }

  // `.then()` of a genuinely PENDING promise arm still adopts -- it does not
  // resolve early, and it does not fold into the fast path above.
  {
    gea::Promise<int> source(1);
    gea::Promise<int> inner;
    gea::Promise<int> result = source.then([inner](int) mutable -> IntOrPromise { return IntOrPromise::ofArm<1>(inner); });
    gea::detail::drainPromiseJobs();
    assert(!result.settled());
    inner.resolve(200);
    gea::detail::drainPromiseJobs();
    assert(result.settled() && !result.rejected() && result.value() == 200);
  }

  // `.then()` of an ALREADY-SETTLED promise arm still adopts -- one queued
  // job, not a direct resolve inside the reaction job that produced it. This
  // is the sub-bug the coroutine cases above cannot exercise (`co_return`/
  // `await` dispatch on the live arm before an already-settled promise ever
  // reaches a "read its current state back out" branch); see this file's
  // header comment.
  {
    gea::Promise<int> source(1);
    gea::Promise<int> inner(55);  // already fulfilled before the handler runs
    gea::Promise<int> result = source.then([inner](int) mutable -> IntOrPromise { return IntOrPromise::ofArm<1>(inner); });
    assert(!gea::detail::promiseJobs().empty());
    {
      // Run exactly the one job `.then()` queued for `source`'s own
      // settlement -- the handler runs inside it and hands back the
      // already-settled `inner` as the live arm.
      gea::detail::PromiseJob job = std::move(gea::detail::promiseJobs().front());
      gea::detail::promiseJobs().pop_front();
      job();
    }
    assert(!result.settled());
    gea::detail::drainPromiseJobs();
    assert(result.settled() && !result.rejected() && result.value() == 55);
  }

  // A rejected promise arm still rejects the `.then()` result.
  {
    gea::Promise<int> source(1);
    gea::Promise<int> inner;
    gea::Promise<int> result = source.then([inner](int) mutable -> IntOrPromise { return IntOrPromise::ofArm<1>(inner); });
    try {
      throw std::runtime_error("boom");
    } catch (...) {
      inner.reject(std::current_exception());
    }
    gea::detail::drainPromiseJobs();
    assert(result.settled() && result.rejected());
  }

  return 0;
}
