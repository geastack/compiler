#include "gea_runtime.h"

#include <cassert>
#include <cmath>
#include <string>

using gea::PropertyKey;
using gea::Value;
using Args = gea::Ref<gea::ArrayObject<Value>>;
using Method = gea::CallableObject<Value(Value, Args)>;

Value number(double value) { return Value::box(Value::Tag::Number, value); }

template <typename F>
void typeError(F run) {
  bool caught = false;
  try {
    run();
  } catch (const Value& error) {
    caught = error.getProperty(PropertyKey::string("name")).as<std::string>() == "TypeError";
  }
  assert(caught);
}

int main() {
  assert(std::isnan(gea::dynamicToNumber(Value())));
  assert(gea::dynamicToNumber(Value::box(Value::Tag::Null, nullptr)) == 0);
  assert(gea::dynamicToNumber(Value::box(Value::Tag::Boolean, true)) == 1);
  assert(gea::dynamicToNumber(Value::box(Value::Tag::Boolean, false)) == 0);
  assert(gea::dynamicToNumber(number(-3.5)) == -3.5);
  assert(gea::dynamicToNumber(Value::box(Value::Tag::String, std::string("\xC2\xA0 0x10 \xEF\xBB\xBF"))) == 16);
  assert(std::isinf(gea::dynamicToNumber(Value::box(Value::Tag::String, std::string("Infinity")))));
  assert(std::isnan(gea::dynamicToNumber(Value::box(Value::Tag::String, std::string("12no")))));

  Value ordinary = Value::object();
  ordinary.setProperty(
    PropertyKey::string("valueOf"),
    Value::boxMethod<1>(Method(+[](void*, Value, Args) { return number(23); }, nullptr)));
  ordinary.setProperty(
    PropertyKey::string("toString"),
    Value::boxMethod<1>(Method(+[](void*, Value, Args) { return number(99); }, nullptr)));
  assert(gea::dynamicToNumber(ordinary) == 23);

  Value exotic = Value::object();
  exotic.setProperty(
    PropertyKey::symbol(gea::wellKnownSymbol(gea::detail::WellKnownSymbol::ToPrimitive)),
    Value::boxMethod<1>(Method(+[](void*, Value, Args arguments) {
      assert(arguments->size() == 1);
      assert(arguments->at(0).as<std::string>() == "number");
      return number(41);
    }, nullptr)));
  assert(gea::dynamicToNumber(exotic) == 41);

  Value nullExotic = Value::object();
  nullExotic.setProperty(
    PropertyKey::symbol(gea::wellKnownSymbol(gea::detail::WellKnownSymbol::ToPrimitive)),
    Value::box(Value::Tag::Null, nullptr));
  nullExotic.setProperty(
    PropertyKey::string("valueOf"),
    Value::boxMethod<1>(Method(+[](void*, Value, Args) { return number(31); }, nullptr)));
  assert(gea::dynamicToNumber(nullExotic) == 31);

  Value objectResult = Value::object();
  objectResult.setProperty(
    PropertyKey::string("valueOf"),
    Value::boxMethod<1>(Method(+[](void*, Value, Args) { return Value::object(); }, nullptr)));
  objectResult.setProperty(
    PropertyKey::string("toString"),
    Value::boxMethod<1>(Method(+[](void*, Value, Args) { return Value::object(); }, nullptr)));
  typeError([&] { gea::dynamicToNumber(objectResult); });

  typeError([] { gea::dynamicToNumber(Value::box(Value::Tag::Symbol, gea::makeSymbol("number"))); });
  typeError([] { gea::dynamicToNumber(Value::box(Value::Tag::BigInt, gea::BigInt(1))); });
}
