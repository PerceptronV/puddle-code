#import <AppKit/AppKit.h>
#include <node_api.h>

// Go through NSApplication's actual event dispatch, not CDP/sendInputEvent,
// which bypass the macOS behaviour this regression test needs to exercise.
static napi_value postKey(napi_env env, NSEventType type) {
  NSWindow *window = NSApp.keyWindow;
  if (!window) {
    napi_throw_error(env, NULL, "Test window is not the key window");
    return NULL;
  }
  NSEvent *event = [NSEvent keyEventWithType:type
      location:NSZeroPoint
      modifierFlags:NSEventModifierFlagCommand | NSEventModifierFlagOption
      timestamp:NSProcessInfo.processInfo.systemUptime
      windowNumber:window.windowNumber context:nil
      characters:@"/" charactersIgnoringModifiers:@"/"
      isARepeat:NO keyCode:44];
  [NSApp postEvent:event atStart:NO];
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value post(napi_env env, napi_callback_info info) {
  return postKey(env, NSEventTypeKeyUp);
}
static napi_value down(napi_env env, napi_callback_info info) {
  return postKey(env, NSEventTypeKeyDown);
}

static napi_value install(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "post", NAPI_AUTO_LENGTH, post, NULL, &fn);
  napi_set_named_property(env, exports, "post", fn);
  napi_create_function(env, "down", NAPI_AUTO_LENGTH, down, NULL, &fn);
  napi_set_named_property(env, exports, "down", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, install)
