#include <iostream>

#include "gea_runtime.h"
int main(int argc, char** argv) {
  try {
    gea::Eval evaluator;
    if (argc > 2 && std::string(argv[2]) == "params-factory") {
      auto ctor = evaluator.function({}, "");
      ctor.setProperty(gea::PropertyKey::string("prototype"), gea::Value::object());
      auto factory = evaluator.function({"NullObject"}, argv[1]).callAsFunction({ctor});
      auto values = gea::makeRef<gea::ArrayObject<gea::Value>>();
      values->push(gea::eval_detail::string("route-value"));
      auto result = factory.callAsFunction({gea::Value::box(gea::Value::Tag::Object, values)});
      const auto keys = result.ownPropertyKeys();
      for (const auto& key : keys) std::cout << key.text() << '=' << gea::eval_detail::text(result.getProperty(key)) << ';';
      std::cout << '\n';
      return 0;
    }
    gea::Value result =
        argc > 2 && std::string(argv[2]) == "script" ? evaluator.run(argv[1]) : evaluator.function({}, argv[1]).callAsFunction({});
    std::cout << gea::host::detail::typeOf(result) << ':' << gea::eval_detail::text(result) << '\n';
  } catch (const gea::Value& error) {
    if (gea::host::isRuntimeError(error))
      std::cout << "throw:" << error.getProperty(gea::PropertyKey::string("name")).as<std::string>() << '\n';
    else
      std::cout << "throw-value:" << gea::host::detail::typeOf(error) << ':' << gea::eval_detail::text(error) << '\n';
  }
}
