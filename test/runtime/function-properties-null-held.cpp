// `Value::functionProperties()` installs `name`/`length` lazily, on whichever
// caller first actually reads a property off a boxed function
// (`getProperty`/`setProperty`/`deleteOwnProperty`/`hasProperty`, or a
// constructor's own `installCallableConstructorPrototype`). Its guard used to
// read `metadata_ != nullptr && metadata_->calls != nullptr` and nothing
// else, then call `metadata_->calls->name(held_.get())` /
// `->length(held_.get())` unconditionally -- and every `name`/`length` thunk
// this file mints (`nativeCallOpsFor`, `nativeRestCallOpsFor`) does
// `static_cast<const T*>(payload)->name()` with no null check of its own,
// on the assumption that a caller only ever reaches it through `box()`,
// which always sets `held_` in the same call that sets `functionObject_`
// and `metadata_`.
//
// `functionObject_` is a *shared* identity, though (reused across every box
// of one callable, by design -- see `box()`'s own comment on why), and
// `ownFactsInstalled` lives on that shared identity, not on any one `Value`.
// So the guard's `!ownFactsInstalled` half answers "has ANY box of this
// identity asked yet", never "does THIS box have a live payload" -- an
// invariant `box()` happens to uphold today but that this accessor's own
// guard did not encode or enforce. A `Value` that reached here sharing that
// identity with an empty `held_` -- this file could not find a public-API
// path that produces one, which is itself worth recording, since it is
// exactly the shape a suspected production crash (profile build, sustained
// load, SIGSEGV inside `nativeRestCallOpsFor<...>::name`) was reported to
// have hit -- would otherwise pass a null `payload` straight into that
// unchecked cast.
//
// This test constructs that exact state directly (there being no public
// constructor for it) and checks the hardened guard degrades instead of
// crashing: `functionProperties()` still returns a (nameless) table, and a
// SUBSEQUENT box of the same identity with a real payload still installs the
// real facts once asked. `#define private public` is the only way to reach
// the private `held_` field from outside the class; it is confined to this
// one translation unit and never touches the shared header.
#define private public
#include "gea_runtime.h"
#undef private
#include <cassert>
#include <string>

static double doubleIt(void*, double value) { return value * 2; }
static const bool doubleItRegistered = gea::CallableObject<double(double)>::registerSource<&doubleIt>("doubleIt", 1, "(x) => x * 2");

static void nullHeldDoesNotCrashFunctionProperties() {
  auto callable = gea::identifyCallable<&doubleIt>(gea::CallableObject<double(double)>{&doubleIt, nullptr});
  gea::Value boxed = gea::Value::box(gea::Value::Tag::Function, callable);
  assert(boxed.functionObject_);
  assert(boxed.metadata_ != nullptr && boxed.metadata_->calls != nullptr);
  assert(boxed.held_);
  assert(!boxed.functionObject_->ownFactsInstalled);

  // The state `box()` never produces: identity and calls-vtable present,
  // payload gone.
  boxed.held_ = gea::Ref<void>{};
  assert(!boxed.held_);

  const auto& properties = boxed.functionProperties();  // used to be a null-pointer read inside `name()`/`length()`
  assert(static_cast<bool>(properties));
  assert(!boxed.functionObject_->ownFactsInstalled);  // degraded, not crashed: no payload to ask
  assert(!properties->hasProperty(gea::PropertyKey::string("name")));

  // A later box of the SAME identity with a real payload still gets its
  // facts installed once asked -- the guard only ever skips the one box
  // whose payload is gone, not the identity for good.
  gea::Value again = gea::Value::box(gea::Value::Tag::Function, callable);
  assert(again.functionObject_ == boxed.functionObject_);
  const auto name = again.getProperty(gea::PropertyKey::string("name"));
  assert(boxed.functionObject_->ownFactsInstalled);
  assert(name.as<std::string>() == "doubleIt");
  assert(again.getProperty(gea::PropertyKey::string("length")).as<double>() == 1.0);
}

int main() {
  nullHeldDoesNotCrashFunctionProperties();
}
