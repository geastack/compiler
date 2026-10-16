// Actual typed CallableObject host-event path; injected transport, no networking.
#define GEA_HOST_DECLARED 1
#include "gea/embedded.h"
#include "gea_runtime.h"
#include "host/worker.h"
#include "host/websocket_platform.h"
#include <cassert>
#include <cstdio>
#include <memory>
#include <string>
#include <unistd.h>
using namespace gea::host;
struct Event {std::string data,reason,message;double code=0;bool wasClean=false;};
namespace gea::host::websocket {
void platform_open(NativeWebSocketHandle,const std::string&,const std::string&,const std::string&){}
void platform_close(NativeWebSocketHandle){}
void platform_destroy(NativeWebSocketHandle){}
}
template<class T>void install(int kind,const WebSocket&socket,const std::shared_ptr<T>&owner){
 using namespace gea::runtime::hostevent;
 if(kind<4){gea::CallableObject<void()>handler{+[](void*){},gea::packEnvironment(owner)};
  if(kind==0)setWebSocketOnOpen(socket,handler);if(kind==1)setWebSocketOnMessage(socket,handler);if(kind==2)setWebSocketOnClose(socket,handler);if(kind==3)setWebSocketOnError(socket,handler);
 }else{gea::CallableObject<void(Event)>handler{+[](void*,Event){},gea::packEnvironment(owner)};
  if(kind==4)setWebSocketOnMessage(socket,handler);if(kind==5)setWebSocketOnClose(socket,handler);if(kind==6)setWebSocketOnError(socket,handler);
 }
}
struct Reenter {NativeWebSocketHandle handle;~Reenter(){websocket::destroy_handle(handle);}};
int main(int argc,char**argv){assert(argc==2);alarm(8);std::string mode=argv[1];
 if(mode=="null-first"){
  workers::retireMainContext();WebSocket socket(static_cast<NativeWebSocketHandle>(42));using namespace gea::runtime::hostevent;
  setWebSocketOnOpen(socket,nullptr);setWebSocketOnMessage(socket,nullptr);setWebSocketOnClose(socket,nullptr);setWebSocketOnError(socket,nullptr);
 }else if(mode=="destroyed"||mode=="terminal"){
  auto handle=websocket::create_handle("ws://authored.invalid/socket");WebSocket socket(handle);
  if(mode=="terminal")workers::retireMainContext();else websocket::destroy_handle(handle);
  for(int kind=0;kind<7;++kind){auto owner=std::make_shared<int>(kind);std::weak_ptr<int>weak=owner;install(kind,socket,owner);owner.reset();assert(weak.expired());}
  if(mode!="terminal")workers::retireMainContext();
 }else if(mode=="replacement"){
  for(int kind=0;kind<7;++kind){auto handle=websocket::create_handle("ws://authored.invalid/socket");WebSocket socket(handle);auto old=std::make_shared<Reenter>();old->handle=handle;std::weak_ptr<Reenter>oldWeak=old;install(kind,socket,old);old.reset();assert(!oldWeak.expired());
   auto next=std::make_shared<int>(kind);std::weak_ptr<int>nextWeak=next;install(kind,socket,next);next.reset();assert(oldWeak.expired()&&nextWeak.expired());}
  workers::retireMainContext();
 }else assert(false);
 std::printf("PASS actual typed WebSocket lifetime %s; seven typed/four null overloads, injected transport/no IO\n",mode.c_str());
}
