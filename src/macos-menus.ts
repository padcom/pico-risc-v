/**
 * macOS: take the Window menu SDL gives the app off its menu bar, so that
 * the keys of macOS's own window commands reach the window (and the guest).
 * macOS puts those commands (Fill, Center, the tiling ones) in an app's
 * Window menu, with keyboard shortcuts that may be plain keys (F11 can be
 * Fill), and a menu takes its keys before the window gets them.
 *
 * Through the Objective-C runtime, with the optional koffi package (without
 * it, or elsewhere, nothing happens). Call it once SDL has made its menus
 * (its first window).
 */
export async function dropWindowMenu(): Promise<void> {
  if (process.platform !== 'darwin') return
  let koffi: typeof import('koffi')
  try {
    koffi = (await import('koffi')).default
  } catch {
    return
  }
  const objc = koffi.load('/usr/lib/libobjc.A.dylib')
  const getClass = objc.func('void *objc_getClass(const char *name)')
  const selector = objc.func('void *sel_registerName(const char *name)')
  // objc_msgSend, by the types of what it's sent.
  const send = objc.func('objc_msgSend', 'void *', ['void *', 'void *'])
  const sendObject = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'void *'])
  const indexOf = objc.func('objc_msgSend', 'long', ['void *', 'void *', 'void *'])
  const removeAt = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'long'])

  const app = send(getClass('NSApplication'), selector('sharedApplication'))
  const bar = send(app, selector('mainMenu'))
  const windows = send(app, selector('windowsMenu'))
  if (!bar || !windows) return
  sendObject(app, selector('setWindowsMenu:'), null)
  const index = indexOf(bar, selector('indexOfItemWithSubmenu:'), windows) as number
  if (index >= 0) removeAt(bar, selector('removeItemAtIndex:'), index)
}
