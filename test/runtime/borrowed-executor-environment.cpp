// Stack-resident closure environments for a synchronous, non-retaining
// callee (`ir/borrowed-callable-uses.ts`'s whole-program proof,
// `emit-callable.ts`'s new branch in `emitAllocateCallable`, and
// `gea_runtime.h`'s `packBorrowedEnvironment`) -- the Promise executor case
// this starts with.
//
// Three things this proves against the real runtime, not a description of
// it:
//
// (a) the executor's OWN multi-field environment never touches
//     `gea::HeapEnvironmentBlock`, even though the ordinary
//     `packTransientEnvironment` path would have put a two-field struct like
//     this one there;
// (b) a NESTED closure that captures the SAME boxed cell and IS retained
//     past the executor's return (stashed the way a `resolve` callback a
//     `Timeout` keeps for later is) keeps its own heap-boxed environment and
//     still observes what the executor wrote into that cell, called long
//     after the executor's own stack frame is gone -- the borrow and the
//     retained closure's heap cell are two independent lifetimes, never one;
// (c) an executor that throws still rejects the promise:
//     `PromiseConstructor::constructVoid`'s `catch (...)` runs around a
//     borrowed executor exactly as it does around a heap one.
#include "gea_runtime.h"
#include <cassert>
#include <stdexcept>

// Never `SoleRefField`-shaped (two fields), and not `environmentFitsInline`
// either once one field is a `Ref` -- exactly the shape that used to mean a
// `HeapEnvironmentBlock`, and the one `packBorrowedEnvironment`'s own
// "otherwise" branch exists for.
struct ExecutorEnv {
  gea::Ref<gea::Optional<int>> box;
  int base;
};

struct RetainedEnv {
  gea::Ref<gea::Optional<int>> box;
};

using Resolve = gea::CallableObject<void(int)>;
using Reject = gea::CallableObject<void(gea::Value)>;
using Retained = gea::CallableObject<void()>;

static Retained gea_escaped;

static void retainedThunk(void* environment) {
  auto* env = static_cast<RetainedEnv*>(environment);
  const int current = env->box->has_value() ? **env->box : 0;
  *env->box = current + 1000;
}

static void executorWritesAndRetainsThunk(void* environment, Resolve, Reject) {
  auto* env = static_cast<ExecutorEnv*>(environment);
  *env->box = env->base;
  // Stashed for later, exactly like a database client's `Timeout` pattern
  // (a Promise subclass whose constructor calls `super(executor)`, which the
  // measured client already shows retaining a resolver into a `Ref<Optional<
  // CallableObject<...>>>` cell): this MUST keep its own heap environment
  // regardless of the executor's own borrow, because it outlives this call.
  auto held = gea::makeRef<gea::HeapEnvironmentBlock<RetainedEnv>>(RetainedEnv{env->box});
  auto* captured = &held->captured;
  gea_escaped = Retained{&retainedThunk, gea::PackedEnvironment{captured, std::move(held).template staticCast<void>(), nullptr}};
}

static void throwingExecutorThunk(void*, Resolve, Reject) { throw std::runtime_error("executor rejects"); }

static void executorEnvironmentIsBorrowedAndInnerClosureIsRetained() {
  using Block = gea::HeapEnvironmentBlock<ExecutorEnv>;
  auto& blocks = gea::detail::allocationTypeProfile<Block>();
  const auto createdBefore = blocks.created;

  auto box = gea::makeRef<gea::Optional<int>>();
  {
    ExecutorEnv env{box, 42};
    gea::CallableObject<void(Resolve, Reject)> executor{&executorWritesAndRetainsThunk, gea::packBorrowedEnvironment(env)};
    executor.call(Resolve{}, Reject{});
  }
  // The executor's OWN environment never allocated a HeapEnvironmentBlock<ExecutorEnv>.
  assert(blocks.created == createdBefore);
  // What the executor wrote is visible: the retained closure reads the same cell.
  assert(box->has_value() && **box == 42);
  // The retained closure -- heap-boxed, independent of the executor's stack
  // frame, which is long gone by now -- still works and still shares the cell.
  gea_escaped.call();
  assert(box->has_value() && **box == 42 + 1000);
}

static void throwingExecutorStillRejects() {
  struct Env {
    int a;
    int b;
  };
  Env env{1, 2};
  gea::CallableObject<void(Resolve, Reject)> executor{&throwingExecutorThunk, gea::packBorrowedEnvironment(env)};
  gea::Promise<void> promise = gea::host::PromiseConstructor::constructVoid(executor);
  bool rejected = false;
  promise.observe([]() { assert(false); }, [&](const std::exception_ptr& reason) {
    rejected = true;
    try {
      std::rethrow_exception(reason);
    } catch (const std::runtime_error& error) {
      assert(std::string(error.what()) == "executor rejects");
    }
  });
  gea::detail::drainPromiseJobs();
  assert(rejected);
}

int main() {
  executorEnvironmentIsBorrowedAndInnerClosureIsRetained();
  throwingExecutorStillRejects();
}
