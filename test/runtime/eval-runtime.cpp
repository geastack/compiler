#include <iostream>

#include "gea_runtime.h"
static int run(int argc, char** argv) {
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
  return 0;
}

#if defined(_WIN32)
// Windows hands `main` its arguments in the ANSI code page, which has no
// emoji; the source under test arrives as UTF-16 here and is passed on as the
// UTF-8 the evaluator reads, as `main` receives it on every other host.
#include <string>
#include <vector>
extern "C" __declspec(dllimport) int __stdcall WideCharToMultiByte(unsigned int, unsigned long, const wchar_t*, int, char*, int,
                                                                  const char*, int*);
int wmain(int argc, wchar_t** wide) {
  std::vector<std::string> arguments;
  for (int index = 0; index < argc; ++index) {
    const int bytes = WideCharToMultiByte(65001, 0, wide[index], -1, nullptr, 0, nullptr, nullptr);
    std::string text(static_cast<std::size_t>(bytes > 0 ? bytes - 1 : 0), '\0');
    if (bytes > 1) WideCharToMultiByte(65001, 0, wide[index], -1, text.data(), bytes, nullptr, nullptr);
    arguments.push_back(std::move(text));
  }
  std::vector<char*> argv;
  for (auto& argument : arguments) argv.push_back(argument.data());
  argv.push_back(nullptr);
  return run(argc, argv.data());
}
#else
int main(int argc, char** argv) { return run(argc, argv); }
#endif
