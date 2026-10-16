#define GEA_HOST_DECLARED 1
#include "gea/embedded.h"
#ifndef GEA_TEST_RUNTIME_HEADER
#error Actual compiler runtime header path required
#endif
#include GEA_TEST_RUNTIME_HEADER
#include "ui/tree_internal.h"
#include <cassert>
#include <cstdio>
#include <memory>
#include <stdexcept>
namespace gea::framework::graphics::generated { void ensureLinked() {} }
using namespace gea::embedded::ui;
using namespace gea::framework::events;
namespace binding=gea::jsx::detail;
static void send(NodeHandle node){PointerEvent e{};e.type=PointerEventType::KeyDown;e.key=" ";e.code="Space";e.keyCode=32;e.targetId=node.id();dispatchRootKeyEvent(e);}
int main(int argc,char**argv){
 assert(argc==2);auto&t=Tree::instance();auto&d=Document::instance();t.clear();auto root=d.querySelector("#app");d.mount(root,640,400);
 auto parent=d.createElement("section"),child=d.createElement("button"),other=d.createElement("section");root.appendChild(parent);parent.appendChild(child);root.appendChild(other);
 const std::string mode=argv[1];
 if(mode=="unrelated"){
  int calls=0;binding::bindNodeListener(parent,"keydown",[&](auto&){++calls;});send(other);assert(calls==0);send(child);assert(calls==1);
 }else if(mode=="removed"){
  auto leaf=d.createElement("section");root.appendChild(leaf);int id=leaf.id(),calls=0;
  auto marker=std::make_shared<int>(7);std::weak_ptr<int> weak=marker;
  binding::bindNodeListener(leaf,"keydown",[&,marker](auto&){++calls;});marker.reset();send(leaf);assert(calls==1);
  leaf.remove();assert(weak.expired());auto replacement=d.createElement("section");root.appendChild(replacement);assert(replacement.id()==id);
  send(replacement);assert(calls==1);
 }else if(mode=="disposer"){
  int calls=0;auto marker=std::make_shared<int>(7);std::weak_ptr<int> weak=marker;
  binding::bindNodeListener(parent,"keydown",[&,marker](auto&){++calls;});marker.reset();send(parent);assert(calls==1);
  binding::releaseNodeSubscriptions(parent.id());assert(parent.valid()&&weak.expired());send(parent);assert(calls==1);
 }else if(mode=="bubbling"){
  int parents=0,children=0,documents=0;
  binding::bindNodeListener(parent,"keydown",[&](auto&e){++parents;assert(e.currentTargetId==parent.id());});
  binding::bindNodeListener(child,"keydown",[&](auto&e){++children;assert(e.currentTargetId==child.id());e.stopPropagation();});
  int identity=0;assert(addDocumentEventListener("keydown",&identity,[&](auto&){++documents;},false,false));
  send(child);assert(children==1&&parents==0&&documents==0);
  binding::releaseNodeSubscriptions(child.id());send(child);assert(children==1&&parents==1&&documents==1);
 }else if(mode=="throw"){
  binding::bindNodeListener(child,"keydown",[&](auto&e){assert(e.currentTargetId==child.id());throw std::runtime_error("listener");});
  PointerEvent e{};e.type=PointerEventType::KeyDown;e.targetId=child.id();e.currentTarget=EventTarget(other.id());e.currentTargetId=other.id();e.eventPhase=EventPhase::Capturing;
  bool threw=false;try{dispatchRootKeyEvent(e);}catch(const std::runtime_error&){threw=true;}
  assert(threw&&e.currentTargetId==other.id()&&e.currentTarget.id()==other.id()&&e.eventPhase==EventPhase::Capturing);
 }else if(mode=="rotary"){
  int calls=0;binding::bindNodeListener(parent,"rotary",[&](auto&){++calls;});PointerEvent e{};e.type=PointerEventType::Rotary;
  dispatchDocumentEvent(e,false);assert(calls==1);parent.remove();dispatchDocumentEvent(e,false);assert(calls==1);
 }else if(mode=="stale-cleanup"){
  auto old=d.createElement("section");root.appendChild(old);int id=old.id(),oldCalls=0,newCalls=0;
  binding::bindNodeListener(old,"keydown",[&](auto&){++oldCalls;});old.remove();
  auto replacement=d.createElement("section");root.appendChild(replacement);assert(replacement.id()==id);
  binding::bindNodeListener(replacement,"keydown",[&](auto&){++newCalls;});
  binding::releaseSubtreeSubscriptions(old);send(replacement);assert(oldCalls==0&&newCalls==1);
 }else if(mode=="default"){
  int parents=0,children=0,documents=0;
  binding::bindNodeListener(child,"keydown",[&](auto&e){++children;e.preventDefault();});
  binding::bindNodeListener(parent,"keydown",[&](auto&e){++parents;assert(e.defaultPrevented);});
  int identity=0;assert(addDocumentEventListener("keydown",&identity,[&](auto&e){++documents;assert(e.defaultPrevented);},false,false));
  send(child);assert(children==1&&parents==1&&documents==1);
 }else if(mode=="nested"){
  int outer=0,inner=0,parents=0;
  binding::bindNodeListener(other,"keydown",[&](auto&e){++inner;assert(e.currentTargetId==other.id());throw std::runtime_error("inner");});
  binding::bindNodeListener(child,"keydown",[&](auto&e){
   ++outer;assert(e.currentTargetId==child.id()&&e.eventPhase==EventPhase::AtTarget);
   const auto target=e.target;const int id=e.targetId;e.targetId=other.id();bool caught=false;
   try{dispatchRootKeyEvent(e);}catch(const std::runtime_error&){caught=true;}
   assert(caught&&e.currentTargetId==child.id()&&e.currentTarget.id()==child.id()&&e.eventPhase==EventPhase::AtTarget);
   e.target=target;e.targetId=id;
  });
  binding::bindNodeListener(parent,"keydown",[&](auto&e){++parents;assert(e.currentTargetId==parent.id()&&e.eventPhase==EventPhase::Bubbling);});
  send(child);assert(outer==1&&inner==1&&parents==1);
 }else assert(false);
 t.clear();printf("PASS native node keyboard binding %s\n",argv[1]);
}
