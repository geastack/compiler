#include "gea_runtime.h"

#include <cassert>

using gea::PropertyKey;
using gea::Value;

Value number(double value) { return Value::box(Value::Tag::Number, value); }

Value iteratorResult(Value value, bool done) {
  Value result = Value::object();
  result.setProperty(PropertyKey::string("value"), std::move(value));
  result.setProperty(PropertyKey::string("done"), Value::box(Value::Tag::Boolean, done));
  return result;
}

struct CursorState {
  std::size_t position = 0;
  bool closed = false;
};

struct CursorEnvironment {
  gea::Ref<CursorState> state;
  std::size_t marker = 0;
};

Value next(void* raw) {
  auto* environment = static_cast<CursorEnvironment*>(raw);
  if (environment->state->position == 0) {
    environment->state->position += 1;
    return iteratorResult(number(7), false);
  }
  return iteratorResult(Value(), true);
}

Value close(void* raw) {
  auto* environment = static_cast<CursorEnvironment*>(raw);
  environment->state->closed = true;
  return iteratorResult(Value(), true);
}

Value invalidClose(void*) { return number(1); }

Value throwingClose(void*) { throw number(99); }

Value throwingNext(void*) { throw number(41); }

struct MethodEnvironment {
  Value iterator;
  std::size_t marker = 0;
};

Value iteratorMethod(void* raw) { return static_cast<MethodEnvironment*>(raw)->iterator; }

int main() {
  const gea::Ref<CursorState> state = gea::makeRef<CursorState>();
  const CursorEnvironment cursor{state};
  gea::CallableObject<Value()> nextMethod(&next, gea::packEnvironment(cursor));
  gea::CallableObject<Value()> returnMethod(&close, gea::packEnvironment(cursor));

  Value iterator = Value::object();
  iterator.setProperty(PropertyKey::string("next"), Value::box(Value::Tag::Function, nextMethod));
  iterator.setProperty(PropertyKey::string("return"), Value::box(Value::Tag::Function, returnMethod));

  gea::CallableObject<Value()> method(&iteratorMethod, gea::packEnvironment(MethodEnvironment{iterator}));
  Value source = Value::object();
  source.setProperty(
    PropertyKey::symbol(gea::wellKnownSymbol(gea::detail::WellKnownSymbol::Iterator)), Value::box(Value::Tag::Function, method));

  Value record = gea::runtime::iterator::getIterator(source);
  const gea::runtime::iterator::Step first = gea::runtime::iterator::step(record);
  assert(!first.done && first.value.as<double>() == 7);
  gea::runtime::iterator::close(record);
  assert(state->closed);

  Value array = Value::box(Value::Tag::Object, gea::arrayOf<double>({3, 5}));
  Value arrayRecord = gea::runtime::iterator::getIterator(array);
  assert(gea::runtime::iterator::step(arrayRecord).value.as<double>() == 3);
  assert(gea::runtime::iterator::step(arrayRecord).value.as<double>() == 5);
  assert(gea::runtime::iterator::step(arrayRecord).done);

  gea::CallableObject<Value()> invalidReturnMethod(&invalidClose, nullptr);
  Value invalidCloseIterator = Value::object();
  invalidCloseIterator.setProperty(PropertyKey::string("return"), Value::box(Value::Tag::Function, invalidReturnMethod));
  bool closeReplacedCompletion = false;
  try {
    gea::runtime::iterator::close(invalidCloseIterator);
  } catch (const Value&) {
    closeReplacedCompletion = true;
  }
  assert(closeReplacedCompletion);

  const gea::Ref<CursorState> abruptState = gea::makeRef<CursorState>();
  const CursorEnvironment abruptCursor{abruptState};
  gea::CallableObject<Value()> abruptReturn(&close, gea::packEnvironment(abruptCursor));
  Value abruptIterator = Value::object();
  abruptIterator.setProperty(PropertyKey::string("return"), Value::box(Value::Tag::Function, abruptReturn));
  auto leaveBodyAbruptly = [&]() {
    gea::runtime::iterator::CloseGuard guard(abruptIterator);
    return;
  };
  leaveBodyAbruptly();
  assert(abruptState->closed);

  Value noReturnIterator = Value::object();
  try {
    gea::runtime::iterator::CloseGuard guard(noReturnIterator);
    try {
      throw number(2);
    } catch (const Value&) {
      guard.close();
      throw;
    }
  } catch (const Value& original) {
    assert(original.as<double>() == 2);
  }

  gea::CallableObject<Value()> throwingReturn(&throwingClose, nullptr);
  Value throwingIterator = Value::object();
  throwingIterator.setProperty(PropertyKey::string("return"), Value::box(Value::Tag::Function, throwingReturn));
  try {
    gea::runtime::iterator::CloseGuard guard(throwingIterator);
    try {
      throw number(1);
    } catch (const Value&) {
      try {
        guard.close();
      } catch (const Value&) {
      }
      throw;
    }
  } catch (const Value& original) {
    assert(original.as<double>() == 1);
  }

  // With a non-throw completion, a close failure becomes the completion.
  bool returnWasReplaced = false;
  try {
    auto leaveWithReturn = [&]() {
      gea::runtime::iterator::CloseGuard guard(throwingIterator);
      return;
    };
    leaveWithReturn();
  } catch (const Value& replacement) {
    returnWasReplaced = replacement.as<double>() == 99;
  }
  assert(returnWasReplaced);

  // Generic spread/rest gathering drains exactly the acquired record.  It
  // writes yielded undefined as a PRESENT value and never calls return after
  // normal exhaustion.
  auto gathered = gea::makeRef<gea::ArrayObject<Value>>();
  const gea::Ref<CursorState> gatherState = gea::makeRef<CursorState>();
  const CursorEnvironment gatherCursor{gatherState};
  gea::CallableObject<Value()> gatherNext(&next, gea::packEnvironment(gatherCursor));
  gea::CallableObject<Value()> gatherReturn(&close, gea::packEnvironment(gatherCursor));
  Value gatherIterator = Value::object();
  gatherIterator.setProperty(PropertyKey::string("next"), Value::box(Value::Tag::Function, gatherNext));
  gatherIterator.setProperty(PropertyKey::string("return"), Value::box(Value::Tag::Function, gatherReturn));
  gea::runtime::iterator::appendGather(*gathered, gatherIterator);
  assert(gathered->size() == 1 && gathered->present(0) && gathered->at(0).as<double>() == 7);
  assert(!gatherState->closed);

  // Array iteration visits holes as undefined. Gathering that dynamic record
  // must therefore densify both a hole and a present undefined slot, while
  // retaining source order.
  auto holeySource = gea::makeRef<gea::ArrayObject<Value>>();
  holeySource->pushHole();
  holeySource->push(Value());
  holeySource->push(number(3));
  auto holeyGathered = gea::makeRef<gea::ArrayObject<Value>>();
  gea::runtime::iterator::appendGather(
      *holeyGathered,
      gea::runtime::iterator::getIterator(Value::box(Value::Tag::Object, holeySource)));
  assert(holeyGathered->size() == 3);
  assert(holeyGathered->present(0) && holeyGathered->at(0).tag() == Value::Tag::Undefined);
  assert(holeyGathered->present(1) && holeyGathered->at(1).tag() == Value::Tag::Undefined);
  assert(holeyGathered->present(2) && holeyGathered->at(2).as<double>() == 3);

  // A throwing `next()` propagates as it is: ArrayAccumulation (ECMA-262
  // 13.2.4.1) forwards IteratorStep's abrupt completion with a bare `?`,
  // never IfAbruptCloseIterator, so the iterator's `return` is NOT run --
  // verified against node in 735d8230b, which removed the close this test
  // used to assert. The throw stays primary whatever `return` would do.
  const gea::Ref<CursorState> gatherAbruptState = gea::makeRef<CursorState>();
  const CursorEnvironment gatherAbruptCursor{gatherAbruptState};
  gea::CallableObject<Value()> gatherThrowingNext(&throwingNext, nullptr);
  gea::CallableObject<Value()> gatherClosingReturn(&close, gea::packEnvironment(gatherAbruptCursor));
  Value gatherAbruptIterator = Value::object();
  gatherAbruptIterator.setProperty(PropertyKey::string("next"), Value::box(Value::Tag::Function, gatherThrowingNext));
  gatherAbruptIterator.setProperty(PropertyKey::string("return"), Value::box(Value::Tag::Function, gatherClosingReturn));
  try {
    gea::runtime::iterator::appendGather(*gathered, gatherAbruptIterator);
    assert(false);
  } catch (const Value& original) {
    assert(original.as<double>() == 41 && !gatherAbruptState->closed);
  }

  gea::CallableObject<Value()> gatherReplacingReturn(&throwingClose, nullptr);
  gatherAbruptIterator.setProperty(PropertyKey::string("return"), Value::box(Value::Tag::Function, gatherReplacingReturn));
  try {
    gea::runtime::iterator::appendGather(*gathered, gatherAbruptIterator);
    assert(false);
  } catch (const Value& original) {
    assert(original.as<double>() == 41);
  }
}
