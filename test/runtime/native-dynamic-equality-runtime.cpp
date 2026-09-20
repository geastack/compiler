#include "gea_runtime.h"
#include <cassert>
#include <limits>

int main() {
  using gea::Value;
  const auto nan = std::numeric_limits<double>::quiet_NaN();
  const gea::Symbol symbol(1024);
  const gea::Symbol otherSymbol(1025);
  const gea::BigInt integer(7);
  const Value cases[] = {
    Value(), Value::box(Value::Tag::Null, nullptr),
    Value::box(Value::Tag::Boolean, true), Value::box(Value::Tag::Boolean, false),
    Value::box(Value::Tag::Number, 7.0), Value::box(Value::Tag::Number, 0.0),
    Value::box(Value::Tag::Number, -0.0), Value::box(Value::Tag::Number, nan),
    Value::box(Value::Tag::String, std::string("7")),
    Value::box(Value::Tag::String, std::string("")),
    Value::box(Value::Tag::Symbol, symbol), Value::box(Value::Tag::Symbol, otherSymbol),
    Value::box(Value::Tag::BigInt, integer)
  };
  for (const Value& value : cases) {
    for (double native : {7.0, 0.0, -0.0, nan})
      assert(gea::strictEqualNumber(value, native) == Value::strictEquals(value, Value::box(Value::Tag::Number, native)));
    for (bool native : {true, false})
      assert(gea::strictEqualBoolean(value, native) == Value::strictEquals(value, Value::box(Value::Tag::Boolean, native)));
    for (const std::string native : {std::string("7"), std::string("")})
      assert(gea::strictEqualString(value, native) == Value::strictEquals(value, Value::box(Value::Tag::String, native)));
    assert(gea::strictEqualSymbol(value, symbol) == Value::strictEquals(value, Value::box(Value::Tag::Symbol, symbol)));
    assert(gea::strictEqualBigInt(value, integer) == Value::strictEquals(value, Value::box(Value::Tag::BigInt, integer)));
  }
}
