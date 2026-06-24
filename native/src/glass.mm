/**
 * Native "liquid glass" window backdrop for macOS.
 *
 * Gives the Electron BrowserWindow the system translucent material and the
 * rounded, unified-toolbar window chrome that Chromium can't produce on its
 * own:
 *
 *   1. Configures the NSWindow with an empty unified NSToolbar. The toolbar is
 *      what makes macOS draw the rounded window corners + unified chrome; a
 *      transparent titlebar and a clear background let the glass show through.
 *   2. Adds a full-window NSGlassEffectView (macOS 26 "Tahoe"+), falling back
 *      to NSVisualEffectView on older systems, behind the web contents.
 *
 * Driven entirely from the main process via a Buffer handle to the window's
 * NSView*; the renderer is unaware of it.
 */
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <napi.h>
#include <cstring>

// A backdrop container that never intercepts mouse events. Returning nil from
// -hitTest: keeps the glass (and this container) out of the event path, so
// toggling DevTools — which can momentarily reorder the window's subviews —
// can never leave the backdrop on top swallowing clicks or inspector targeting.
@interface PDFXBackdropView : NSView
@end
@implementation PDFXBackdropView
- (NSView *)hitTest:(NSPoint)point {
    return nil;
}
@end

// NSGlassEffectView only exists on macOS 26 (Tahoe) and later.
static Class glassEffectViewClass() {
    return NSClassFromString(@"NSGlassEffectView");
}

// Create the translucent backdrop view: the real glass material when
// available, otherwise the closest visual-effect fallback.
static NSView *createGlassView(NSRect frame) {
    Class glassClass = glassEffectViewClass();
    if (glassClass) {
        NSView *view = [[glassClass alloc] initWithFrame:frame];
        [view setWantsLayer:YES];
        return view;
    }

    NSVisualEffectView *view = [[NSVisualEffectView alloc] initWithFrame:frame];
    [view setMaterial:NSVisualEffectMaterialUnderWindowBackground];
    [view setBlendingMode:NSVisualEffectBlendingModeBehindWindow];
    [view setState:NSVisualEffectStateActive];
    [view setWantsLayer:YES];
    return view;
}

// Configure the window for transparency + rounded, unified chrome.
static void configureWindowStyle(NSWindow *window) {
    [window setTitlebarAppearsTransparent:YES];
    [window setTitleVisibility:NSWindowTitleHidden];
    window.styleMask |= NSWindowStyleMaskFullSizeContentView;

    if (@available(macOS 11.0, *)) {
        [window setToolbarStyle:NSWindowToolbarStyleUnified];
    }

    // An empty unified toolbar triggers the rounded-corner chrome; it carries
    // no items, so nothing visible is added to the transparent titlebar.
    NSToolbar *toolbar = [[NSToolbar alloc] initWithIdentifier:@"pdfxGlassToolbar"];
    [toolbar setDisplayMode:NSToolbarDisplayModeIconOnly];
    [toolbar setAllowsUserCustomization:NO];
    [toolbar setAutosavesConfiguration:NO];
    if (@available(macOS 15.0, *)) {
        [toolbar setAllowsDisplayModeCustomization:NO];
    }
    [window setToolbar:toolbar];

    // The whole translucent backdrop becomes a drag handle — a safety net
    // beneath the renderer's -webkit-app-region drag regions.
    [window setMovableByWindowBackground:YES];

    // Clear background so the glass behind the web contents is what shows.
    [window setBackgroundColor:[NSColor clearColor]];
    [window setOpaque:NO];

    // Leave the window appearance unset so it follows the system (and updates
    // live when the user toggles light/dark): the glass material re-renders
    // accordingly, matching the renderer's prefers-color-scheme theme.
}

// applyGlass(handle: Buffer) -> void
static Napi::Value ApplyGlass(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsBuffer()) {
        Napi::TypeError::New(env, "Expected (Buffer windowHandle)").ThrowAsJavaScriptException();
        return env.Null();
    }

    auto handle = info[0].As<Napi::Buffer<void *>>();
    NSView *__unsafe_unretained rootView;
    std::memcpy(&rootView, handle.Data(), sizeof(NSView *));
    if (!rootView) {
        Napi::Error::New(env, "Invalid native window handle").ThrowAsJavaScriptException();
        return env.Null();
    }

    NSWindow *window = [rootView window];
    if (!window) {
        Napi::Error::New(env, "Could not resolve NSWindow").ThrowAsJavaScriptException();
        return env.Null();
    }

    configureWindowStyle(window);

    NSView *contentView = [window contentView];

    // Wrap the glass in a non-interactive container so the backdrop stays out of
    // the mouse event path even if DevTools toggling reorders the subviews.
    PDFXBackdropView *backdrop = [[PDFXBackdropView alloc] initWithFrame:contentView.bounds];
    [backdrop setAutoresizingMask:NSViewWidthSizable | NSViewHeightSizable];

    NSView *glass = createGlassView(backdrop.bounds);
    // Track the container's size so the backdrop always fills the window.
    [glass setAutoresizingMask:NSViewWidthSizable | NSViewHeightSizable];
    [backdrop addSubview:glass];

    // Positioned below the web contents view so the page renders on top.
    [contentView addSubview:backdrop positioned:NSWindowBelow relativeTo:nil];

    return env.Undefined();
}

// isGlassSupported() -> boolean (true when the real NSGlassEffectView exists)
static Napi::Value IsGlassSupported(const Napi::CallbackInfo &info) {
    return Napi::Boolean::New(info.Env(), glassEffectViewClass() != nil);
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("applyGlass", Napi::Function::New(env, ApplyGlass));
    exports.Set("isGlassSupported", Napi::Function::New(env, IsGlassSupported));
    return exports;
}

NODE_API_MODULE(glass, Init)
