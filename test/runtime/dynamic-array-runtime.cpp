#include "gea_runtime.h"

#include <cassert>

using gea::PropertyKey;
using gea::Value;

Value number(double value) { return Value::box(Value::Tag::Number, value); }

int main() {
  // One boxed native Array is still one Array.  The dynamic path must use the
  // recorded exotic hooks, never manufacture an ArrayObject<Value> copy.
  const auto native = gea::makeRef<gea::ArrayObject<Value>>();
  native->setLength(3);  // three holes
  Value array = Value::box(Value::Tag::Object, native);
  Value alias = array;

  assert(array.isArrayPayload());
  assert(array.dynamicArrayLength("dynamic array test") == 3);
  assert(!array.hasProperty(PropertyKey::string("0")));  // hole
  alias.setProperty(PropertyKey::string("1"), Value());  // present undefined
  assert(alias.hasProperty(PropertyKey::string("1")));
  assert(array.getProperty(PropertyKey::string("0")).tag() == Value::Tag::Undefined);
  assert(array.getProperty(PropertyKey::string("1")).tag() == Value::Tag::Undefined);

  // A dynamic indexed write grows length and leaves skipped positions holes.
  alias.setProperty(PropertyKey::string("4"), number(9));
  assert(array.dynamicArrayLength("dynamic array test") == 5);
  assert(!array.hasProperty(PropertyKey::string("3")));
  assert(array.getProperty(PropertyKey::string("4")).as<double>() == 9);

  // Delete preserves length and changes a present value back into a hole.
  assert(alias.deleteProperty(PropertyKey::string("1")));
  assert(array.dynamicArrayLength("dynamic array test") == 5);
  assert(!array.hasProperty(PropertyKey::string("1")));

  // The Array iterator visits holes as undefined and observes live length.
  Value iterator = gea::runtime::iterator::getIterator(array);
  assert(!gea::runtime::iterator::step(iterator).done);  // hole 0
  assert(!gea::runtime::iterator::step(iterator).done);  // hole 1
  array.setProperty(PropertyKey::string("5"), number(11));
  assert(!gea::runtime::iterator::step(iterator).done);  // hole 2
  assert(!gea::runtime::iterator::step(iterator).done);  // hole 3
  assert(gea::runtime::iterator::step(iterator).value.as<double>() == 9);
  assert(gea::runtime::iterator::step(iterator).value.as<double>() == 11);
  assert(gea::runtime::iterator::step(iterator).done);

  // Gathering follows iteration, not property existence: holes become dense,
  // present undefined elements in the fresh result.
  const auto gathered = gea::makeRef<gea::ArrayObject<Value>>();
  gea::runtime::iterator::appendGather(*gathered, gea::runtime::iterator::getIterator(array));
  assert(gathered->size() == 6);
  assert(gathered->present(0) && gathered->at(0).tag() == Value::Tag::Undefined);
  assert(gathered->present(1) && gathered->at(1).tag() == Value::Tag::Undefined);
  assert(gathered->at(4).as<double>() == 9 && gathered->at(5).as<double>() == 11);

  // Length truncation is visible through every alias and removes tail slots.
  alias.setProperty(PropertyKey::string("length"), number(1));
  assert(array.dynamicArrayLength("dynamic array test") == 1);
  assert(!array.hasProperty(PropertyKey::string("4")));

  // An ordinary dynamic object is not an Array exotic object and cannot take
  // the Array iterator fallback merely by looking array-like.
  Value object = Value::object();
  object.setProperty(PropertyKey::string("length"), number(2));
  assert(!object.isArrayPayload());
  bool rejected = false;
  try {
    gea::runtime::iterator::getIterator(object);
  } catch (const Value&) {
    rejected = true;
  }
  assert(rejected);
}
