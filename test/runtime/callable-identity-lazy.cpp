// Lazy function identity, anchored on the environment block.
//
// `identifyCallable` used to mint a `FunctionObjectIdentity` (and its
// property table) at every allocation the callable-identity census could not
// prove unobserved -- most closures, once anything in the program compares
// one, boxes one, or reads a property off one. A heap-environment closure now
// defers that mint to whichever copy first actually asks
// (`CallableObject::functionObjectIdentity()`), anchored in the
// `EnvironmentIdentityHeader` every copy already shares through
// `environmentOwner`'s refcount, so `identifyCallable` itself only stamps the
// declaration tag and mints nothing. `FunctionObjectIdentity::properties` is
// separately lazy: `Value::box` no longer installs name/length eagerly, only
// `Value::functionProperties()` does, on first genuine use.
#include "gea_runtime.h"
#include <cassert>
#include <string>

// A struct wider than a pointer forces `packEnvironmentStorage` down the heap
// path (`environmentFitsInline` requires fitting in `sizeof(void*)`), which is
// what gives this closure an `EnvironmentIdentityHeader` to anchor on.
struct Env {
  double a;
  double b;
};

static double addEnv(void* environment, double x) {
  const auto* env = static_cast<const Env*>(environment);
  return env->a + env->b + x;
}
static const bool addEnvRegistered = gea::CallableObject<double(double)>::registerSource<&addEnv>("addEnv", 1, "(x) => a + b + x");

static double doubleIt(void*, double value) { return value * 2; }

// (a) A heap-environment closure copied before anything asks for its identity
// mints nothing at `identifyCallable`, mints exactly once on the first ask
// (through whichever copy asks first), and every other copy -- already made,
// or made later -- reads that same identity.
static void heapEnvironmentSharesIdentityAcrossCopies() {
  auto& identities = gea::detail::allocationTypeProfile<gea::FunctionObjectIdentity>();
  const auto createdBefore = identities.created;
  auto original =
      gea::identifyCallable<&addEnv>(gea::CallableObject<double(double)>{&addEnv, gea::packEnvironmentStorage(Env{10.0, 20.0})});
  assert(identities.created == createdBefore);  // identifyCallable only stamps the tag; no mint yet
  auto copyA = original;
  auto copyB = original;
  assert(identities.created == createdBefore);  // copying a heap environment shares the Ref: still nothing minted

  const auto& idA = copyA.functionObjectIdentity();  // first ask: mints, into the shared header
  assert(identities.created == createdBefore + 1);
  const auto& idB = copyB.functionObjectIdentity();  // second ask, different copy: reads the same header
  assert(identities.created == createdBefore + 1);
  assert(idA && idA == idB);
  assert(original.functionObjectIdentity() == idA);
  assert(copyA == copyB && copyA == original);
  assert(gea::callableDeclarationIdentityOf(idA) == gea::detail::callableDeclarationTagFor<&addEnv>());

  // A copy made AFTER the mint sees it too: the header, not the moment of
  // copying, is what every carrier reads through.
  auto copyC = copyA;
  assert(copyC.functionObjectIdentity() == idA);
  assert(identities.created == createdBefore + 1);
}

// (b) A capture-free callable has no environment block to anchor on, so
// `identifyCallable` mints right away (as it always did); copies share that
// one object and mint nothing further.
static void captureFreeMintsOnceAndCopiesShare() {
  auto& identities = gea::detail::allocationTypeProfile<gea::FunctionObjectIdentity>();
  const auto createdBefore = identities.created;
  auto original = gea::identifyCallable<&doubleIt>(gea::CallableObject<double(double)>{&doubleIt, nullptr});
  assert(identities.created == createdBefore + 1);
  auto copyA = original;
  auto copyB = original;
  assert(identities.created == createdBefore + 1);
  assert(original.functionObjectIdentity() == copyA.functionObjectIdentity());
  assert(copyA == copyB && copyA == original);
}

// (c) Two boxes of the SAME callable are two views of one ECMAScript function
// object: a property written through one is visible through the other's
// `getProperty` and through `Value::functionProperties()` on either.
static void boxedPropertiesShareThroughIdentity() {
  auto callable = gea::identifyCallable<&addEnv>(gea::CallableObject<double(double)>{&addEnv, gea::packEnvironmentStorage(Env{1.0, 2.0})});
  auto boxA = gea::Value::box(gea::Value::Tag::Function, callable);
  auto boxB = gea::Value::box(gea::Value::Tag::Function, callable);
  const auto key = gea::PropertyKey::string("tag");
  boxA.setProperty(key, gea::Value::box(gea::Value::Tag::Number, 7.0));
  assert(boxB.getProperty(key).as<double>() == 7.0);
  assert(boxA.functionProperties().get() == boxB.functionProperties().get());
  assert(boxA.functionProperties()->hasProperty(key));
}

// (d) `Value::box` alone installs no own facts (no property table at all, if
// nothing else has forced one); `name`/`length` appear only once something
// actually reads a property, and only then.
static void ownFactsInstallLazily() {
  auto callable = gea::identifyCallable<&addEnv>(gea::CallableObject<double(double)>{&addEnv, gea::packEnvironmentStorage(Env{3.0, 4.0})});
  auto box = gea::Value::box(gea::Value::Tag::Function, callable);
  const auto& identity = callable.functionObjectIdentity();
  assert(!identity->ownFactsInstalled);
  assert(!identity->properties);

  const auto name = box.getProperty(gea::PropertyKey::string("name"));
  assert(identity->ownFactsInstalled);
  assert(static_cast<bool>(identity->properties));
  assert(name.as<std::string>() == "addEnv");
  assert(box.getProperty(gea::PropertyKey::string("length")).as<double>() == 1.0);
}

// (e) A closure nothing ever asks about -- copied, called, and dropped, but
// never compared, boxed, or read as a property -- mints no
// `FunctionObjectIdentity` at all. `identifyCallable` costs a header write;
// `functionObjectIdentity()` costs an allocation, and this path never calls it.
static void neverAskedNeverAllocates() {
  auto& identities = gea::detail::allocationTypeProfile<gea::FunctionObjectIdentity>();
  const auto createdBefore = identities.created;
  {
    auto callable =
        gea::identifyCallable<&addEnv>(gea::CallableObject<double(double)>{&addEnv, gea::packEnvironmentStorage(Env{5.0, 6.0})});
    auto copy1 = callable;
    auto copy2 = copy1;
    assert(copy1.call(1.0) == 12.0);
    assert(copy2.call(2.0) == 13.0);
    assert(identities.created == createdBefore);
  }
  assert(identities.created == createdBefore);
}

int main() {
  heapEnvironmentSharesIdentityAcrossCopies();
  captureFreeMintsOnceAndCopiesShare();
  boxedPropertiesShareThroughIdentity();
  ownFactsInstallLazily();
  neverAskedNeverAllocates();
}
