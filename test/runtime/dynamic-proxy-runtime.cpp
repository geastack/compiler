#include "gea_runtime.h"
#include <cassert>

using gea::Value;
using gea::PropertyKey;
using gea::PropertyDescriptor;
const auto x = PropertyKey::string("x");
Value number(double value) { return Value::box(Value::Tag::Number, value); }

template <typename F> void typeError(F run) {
  bool caught = false;
  try { run(); } catch (const Value& error) {
    caught = error.getProperty(PropertyKey::string("name")).as<std::string>() == "TypeError";
  }
  assert(caught);
}

int main() {
  Value target = Value::object();
  target.setProperty(x, number(7));
  Value handler = Value::object();
  handler.setProperty(PropertyKey::string("offset"), number(3));
  handler.setProperty(PropertyKey::string("get"), Value::boxMethod(
    gea::CallableObject<Value(Value, Value, Value, Value)>(+[](void*, Value self, Value target, Value key, Value receiver) {
      assert(receiver.isProxy());
      return gea::dynamicAdd(target.getProperty(gea::host::toPropertyKey(key)), self.getProperty(PropertyKey::string("offset")));
    }, nullptr)));
  Value proxy = Value::proxy(target, handler);
  assert(proxy.getProperty(x).as<double>() == 10);
  handler.setProperty(PropertyKey::string("offset"), number(4));
  assert(proxy.getProperty(x).as<double>() == 11);
  handler.deleteProperty(PropertyKey::string("get"));
  proxy.setProperty(x, number(8));
  assert(target.getProperty(x).as<double>() == 8);

  // Reflect.set preserves the receiver and sends its write through defineProperty.
  handler.setProperty(PropertyKey::string("defineProperty"), Value::box(Value::Tag::Function,
    gea::CallableObject<bool(Value, Value, Value)>(+[](void*, Value target, Value key, Value descriptor) {
      return target.defineProperty(gea::host::toPropertyKey(key), gea::proxyDescriptorFrom(descriptor));
    }, nullptr)));
  assert(gea::reflectSet(target, std::string("x"), 9.0, proxy));
  assert(target.getProperty(x).as<double>() == 9);

  handler.setProperty(PropertyKey::string("set"), Value::box(Value::Tag::Function,
    gea::CallableObject<bool()>(+[](void*) { return false; }, nullptr)));
  assert(!gea::reflectSet(proxy, std::string("x"), 10.0));
  typeError([&] { proxy.setProperty(x, number(10)); });
  assert(target.getProperty(x).as<double>() == 9);

  // Non-configurable data invariants and duplicate own keys must throw.
  target.asDynamicObject()->freezeIntegrity();
  handler.setProperty(PropertyKey::string("get"), Value::box(Value::Tag::Function,
    gea::CallableObject<Value()>(+[](void*) { return number(99); }, nullptr)));
  typeError([&] { proxy.getProperty(x); });
  handler.setProperty(PropertyKey::string("ownKeys"), Value::box(Value::Tag::Function,
    gea::CallableObject<Value()>(+[](void*) {
      return Value::box(Value::Tag::Object, gea::arrayOf<std::string>({"x", "x"}));
    }, nullptr)));
  typeError([&] { proxy.ownPropertyKeys(); });

  Value original = Value::box(Value::Tag::Function,
    gea::CallableObject<Value(Value)>(+[](void*, Value value) { return value; }, nullptr));
  Value callable = Value::proxy(original, Value::object());
  assert(callable.callAsFunction({number(12)}).as<double>() == 12);
  Value alias = callable;
  alias.revokeProxy();
  typeError([&] { callable.callAsFunction({}); });
  Value array = Value::proxy(Value::box(Value::Tag::Object, gea::arrayOf<double>({1})), Value::object());
  array.revokeProxy();
  typeError([&] { array.isArrayPayload(); });
}
