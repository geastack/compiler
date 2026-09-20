#include <cassert>

#include "gea_runtime.h"
using gea::PropertyKey;
using gea::Value;
using namespace gea::eval_detail;

using NativeCallable = gea::CallableObject<double(double)>;
using NativeCallableConstructor = gea::CallableConstructorObject<double(double), double(double)>;

static double nativeCallableInvoke(void*, double value) { return value; }
static double nativeCallableConstruct(void*, double value) { return value + 1; }
static double nativeBoundInvoke(void*, double receiver, double left, double right) { return receiver + left + right; }

template <class F>
void throws(const char* expected, F&& action) {
  bool caught = false;
  try {
    action();
  } catch (const Value& e) {
    caught = text(e.getProperty(PropertyKey::string("name"))) == expected;
  }
  assert(caught);
}
int main() {
  gea::Eval evaluator;
  const auto invokeBody = [&](const std::string& body) { return evaluator.function({}, body).callAsFunction({}); };
  const auto activeGlobal = gea::runtime::globalThis();
  (*activeGlobal)["x"] = number(1);
  const auto readsActiveGlobal = gea::Eval::constructFunction(
      {gea::Eval::functionArgument(std::string("return x;"))});
  assert(numeric(readsActiveGlobal.callAsFunction({})) == 1);
  const auto returnsActiveGlobal = gea::Eval::constructFunction(
      {gea::Eval::functionArgument(std::string("return this;"))});
  const auto returnedGlobal = returnsActiveGlobal.callAsFunction({});
  assert(returnedGlobal.isDynamicDictionaryPayload());
  assert(returnedGlobal.as<gea::Ref<gea::Dictionary<Value>>>() == activeGlobal);
  const auto comparesActiveGlobal = gea::Eval::constructFunction(
      {gea::Eval::functionArgument(std::string("return this === globalThis;"))});
  assert(truth(comparesActiveGlobal.callAsFunction({})));
  Value escapedActiveRealm;
  {
    const auto activeFactory = gea::Eval::constructFunction(
        {gea::Eval::functionArgument(std::string("return function(){ return x; };"))});
    escapedActiveRealm = activeFactory.callAsFunction({});
  }
  (*activeGlobal)["x"] = number(2);
  gea::collectCycles();
  assert(numeric(escapedActiveRealm.callAsFunction({})) == 2);
  const auto generated = gea::Eval::constructFunction(
      {gea::Eval::functionArgument(std::string("captured")),
       gea::Eval::functionArgument(std::string("return function(value){ return captured + value; };"))});
  const auto closure = generated.callAsFunction({gea::eval_detail::string("left-")});
  assert(text(closure.callAsFunction({gea::eval_detail::string("right")})) == "left-right");
  const auto fresh = gea::Eval::constructFunction(
      {gea::Eval::functionArgument(std::string("captured")),
       gea::Eval::functionArgument(std::string("return function(value){ return captured + value; };"))});
  assert(!Value::strictEquals(generated, fresh));
  const auto dynamicBody = Value::box(Value::Tag::String, std::string("return value + '!';"));
  const auto mixed = gea::Eval::constructFunction(
      {gea::Eval::functionArgument(std::string("value")), gea::Eval::functionArgument(dynamicBody)});
  assert(text(mixed.callAsFunction({gea::eval_detail::string("ok")})) == "ok!");
  auto nullObject = evaluator.function({}, "");
  nullObject.setProperty(PropertyKey::string("prototype"), Value::object());
  const auto paramsFactory = gea::Eval::constructFunction(
      {gea::Eval::functionArgument(std::string("NullObject")),
       gea::Eval::functionArgument(std::string("const fn = function _createParamsObject (paramsArray) {\n"
                                              "const params = new NullObject()\n"
                                              "params['id'] = paramsArray[0]\n"
                                              "return params\n"
                                              "}\n"
                                              "return fn"))})
                               .callAsFunction({nullObject});
  auto parameterValues = gea::makeRef<gea::ArrayObject<Value>>();
  parameterValues->push(gea::eval_detail::string("route-value"));
  const auto params = paramsFactory.callAsFunction({Value::box(Value::Tag::Object, parameterValues)});
  assert(text(params.getProperty(PropertyKey::string("id"))) == "route-value");
  const auto matcher = gea::Eval::constructFunction(
      {gea::Eval::functionArgument(std::string("derivedConstraints")),
       gea::Eval::functionArgument(std::string("let candidates = 1\n"
                                              "let mask, matches\n"
                                              "mask = -2\n"
                                              "value = derivedConstraints.host\n"
                                              "if (value === undefined) { candidates &= mask } else {\n"
                                              "matches = this.constrainedHandlerStores.host.get(value) || 0\n"
                                              "candidates &= (matches | mask)\n"
                                              "}\n"
                                              "if (candidates === 0) return null\n"
                                              "return this.handlers[31 - Math.clz32(candidates)]"))});
  auto matcherReceiver = Value::object();
  auto handlers = gea::makeRef<gea::ArrayObject<Value>>();
  handlers->push(gea::eval_detail::string("matched"));
  matcherReceiver.setProperty(PropertyKey::string("handlers"), Value::box(Value::Tag::Object, handlers));
  auto stores = Value::object();
  auto hostStore = Value::object();
  hostStore.setProperty(PropertyKey::string("get"), evaluator.function({"value"}, "return 1;"));
  stores.setProperty(PropertyKey::string("host"), hostStore);
  matcherReceiver.setProperty(PropertyKey::string("constrainedHandlerStores"), stores);
  auto derived = Value::object();
  derived.setProperty(PropertyKey::string("host"), gea::eval_detail::string("fastify.io"));
  assert(text(matcher.callWithReceiver(matcherReceiver, {derived})) == "matched");
  evaluator.globals().setProperty(PropertyKey::string("count"), number(0));
  throws("EvalUnsupportedError", [&] { evaluator.function({}, "count++; if(false) { class C {} }"); });
  assert(numeric(evaluator.globals().getProperty(PropertyKey::string("count"))) == 0);
  throws("SyntaxError", [&] { evaluator.function({}, "count++; let x; let x;"); });
  assert(numeric(evaluator.globals().getProperty(PropertyKey::string("count"))) == 0);
  throws("SyntaxError", [&] { evaluator.function({"", "a"}, "return a;"); });
  assert(numeric(evaluator.function({"a,b"}, "return a+b").callAsFunction({number(2), number(3)})) == 5);
  assert(text(invokeBody("let f=function named(){}; return f.name;")) == "named");
  assert(text(invokeBody("let f=function(){}; return f.name;")) == "f");
  assert(text(invokeBody("let x={f:function(){}}; return x.f.name;")) == "f");
  assert(truth(invokeBody("let F=function(){}; return F.prototype.constructor===F;")));
  assert(numeric(invokeBody("'use strict' + ''; unbound=4; return unbound;")) == 4);

  auto primitiveObject = Value::object();
  primitiveObject.setProperty(PropertyKey::symbol(gea::wellKnownSymbol(gea::detail::WellKnownSymbol::ToPrimitive)),
                              method(+[](void*, Value, Args args) { return argument(args, 0); }));
  evaluator.globals().setProperty(PropertyKey::string("coercible"), primitiveObject);
  assert(text(invokeBody("return coercible + '!';")) == "default!");
  assert(text(invokeBody("return String(coercible);")) == "string");

  auto holder = Value::object();
  gea::PropertyDescriptor descriptor;
  descriptor.hasGet = true;
  descriptor.get = [](const Value& receiver) { return receiver.getProperty(PropertyKey::string("x")); };
  holder.defineProperty(PropertyKey::string("read"), descriptor);
  holder.setProperty(PropertyKey::string("x"), number(7));
  evaluator.globals().setProperty(PropertyKey::string("holder"), holder);
  assert(numeric(invokeBody("return holder.read;")) == 7);
  auto fixed = gea::PropertyDescriptor::assignment(number(2));
  fixed.writable = false;
  holder.defineProperty(PropertyKey::string("fixed"), fixed);
  assert(numeric(invokeBody("holder.fixed=4; return holder.fixed;")) == 2);
  throws("TypeError", [&] { invokeBody("'use strict'; holder.fixed=4;"); });

  // A dynamic ABI adapter is another view of one Function object. Its boxed
  // form must compare equal to the original and retain the exact own-property
  // table, including valid configurable redefinitions of name/length.
  NativeCallable native(&nativeCallableInvoke, nullptr);
  Value nativeBox = Value::box(Value::Tag::Function, native);
  NativeCallable adapted = gea::detail::DynamicCarrier<NativeCallable>::in(nativeBox, 0);
  assert(Value::strictEquals(nativeBox, Value::box(Value::Tag::Function, adapted)));
  assert(!gea::callableDynamicSet(native, PropertyKey::string("name"), Value::box(Value::Tag::String, std::string("no"))));
  gea::PropertyDescriptor renamed;
  renamed.hasValue = true;
  renamed.value = Value::box(Value::Tag::String, std::string("renamed"));
  assert(nativeBox.defineProperty(PropertyKey::string("name"), renamed));
  assert(text(gea::callableDynamicGet(native, PropertyKey::string("name"))) == "renamed");
  gea::PropertyDescriptor relengthed;
  relengthed.hasValue = true;
  relengthed.value = Value::box(Value::Tag::Number, 9.0);
  assert(nativeBox.defineProperty(PropertyKey::string("length"), relengthed));
  assert(numeric(gea::callableDynamicGet(native, PropertyKey::string("length"))) == 9.0);

  // A proven constructor has its non-configurable prototype descriptor and
  // retains its construct entry while reflection reads that same owner.
  NativeCallableConstructor constructor(&nativeCallableInvoke, &nativeCallableConstruct, nullptr);
  Value prototype = gea::callableDynamicGet(constructor, PropertyKey::string("prototype"));
  gea::PropertyDescriptor prototypeDescriptor;
  Value constructorBox = Value::box(Value::Tag::Function, constructor);
  assert(constructorBox.ownDescriptor(PropertyKey::string("prototype"), prototypeDescriptor));
  assert(prototypeDescriptor.writable && !prototypeDescriptor.enumerable && !prototypeDescriptor.configurable);
  assert(Value::strictEquals(prototype.getProperty(PropertyKey::string("constructor")), constructorBox));
  assert(constructor.construct(6) == 7);

  // A native bind result is a new Function identity, while its receiver and
  // prefix are retained exactly once in its native environment.
  using NativeBoundSource = gea::CallableObject<double(double, double, double)>;
  NativeBoundSource boundSource(&nativeBoundInvoke, nullptr);
  auto bound = gea::bindCallable<double(double), 1>(boundSource, 10.0, 2.0);
  assert(bound.call(3.0) == 15.0);
  assert(!Value::strictEquals(Value::box(Value::Tag::Function, boundSource), Value::box(Value::Tag::Function, bound)));

  Value escaped;
  {
    gea::Eval local;
    escaped = local.function({}, "let x=0; return function(){ return ++x; };").callAsFunction({});
  }
  gea::collectCycles();
  assert(numeric(escaped.callAsFunction({})) == 1);
  assert(numeric(escaped.callAsFunction({})) == 2);
  throws("RangeError", [&] { invokeBody("let f=function f(){return f();}; return f();"); });
  throws("EvalUnsupportedError", [&] { evaluator.function({}, std::string(65537, ' ')); });
  gea::WeakRef<gea::DynamicObject> weakGlobal;
  {
    gea::Eval local;
    weakGlobal = local.globals().asDynamicObject();
    auto fn = local.function({}, "let f=function self(){return self;}; return f;");
    fn.callAsFunction({});
  }
  gea::collectCycles();
  assert(weakGlobal.expired());
}
