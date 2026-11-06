#import <AppKit/AppKit.h>
#include <node_api.h>

static id monitor;

static void cleanup(void *unused) {
  if (monitor) [NSEvent removeMonitor:monitor];
  monitor = nil;
}

static napi_value install(napi_env env, napi_value exports) {
  if (![NSThread isMainThread]) {
    napi_throw_error(env, NULL, "Command key-up forwarding requires the main thread");
    return NULL;
  }
  if (monitor) return exports;
  // NSApplication swallows keyUp while Command is held. Forward the original
  // event to this app's key window before that happens, as Chromium does in its
  // Chrome application subclass. Window dispatch does not re-enter this monitor.
  // This is an app-local monitor: no global input hook or OS permission.
  monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyUp
      handler:^NSEvent *(NSEvent *event) {
    NSWindow *window = NSApp.keyWindow;
    if ((event.modifierFlags & NSEventModifierFlagCommand) && window &&
        (!event.window || event.window == window)) {
      [window sendEvent:event];
      return nil; // deliver once, even if a future NSApplication forwards it
    }
    return event;
  }];
  napi_add_env_cleanup_hook(env, cleanup, NULL);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, install)
