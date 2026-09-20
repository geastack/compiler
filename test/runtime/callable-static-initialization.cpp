#include "gea_runtime.h"

#include <cassert>

static double identity(void*, double value) { return value; }

// Host builtins such as Math.floor are CallableObjects with static storage.
// Constructing one must not allocate from gea::Ref pools before main starts.
static const gea::CallableObject<double(double)> globalCallable{identity, nullptr};
static const bool allocatedBeforeMain = static_cast<bool>(globalCallable.functionObject);

int main() {
  assert(!allocatedBeforeMain);
  assert(!globalCallable.functionObject);
  assert(globalCallable.call(42) == 42);

  // A copy carries whatever identity its source holds and mints none of its
  // own: an identity exists where the program observes one (`identifyCallable`
  // at the allocation, `===`, a Set), not per copy. Minting on copy put two
  // heap objects behind every `fns[i]` read in a hot loop.
  {
    const auto unobserved = globalCallable;
    assert(!unobserved.functionObject && !globalCallable.functionObject);
  }

  const auto& minted = globalCallable.functionObjectIdentity();
  assert(minted && globalCallable.functionObject == minted);
  const auto firstCopy = globalCallable;
  const auto secondCopy = globalCallable;
  assert(firstCopy.functionObject == minted && secondCopy.functionObject == minted);
  assert(firstCopy == globalCallable);
  assert(secondCopy == globalCallable);
  assert(firstCopy == secondCopy);

  const gea::CallableObject<double(double)> distinctCallable{identity, nullptr};
  assert(distinctCallable != globalCallable);
  return 0;
}
