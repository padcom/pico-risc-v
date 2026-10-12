// A service worker that makes the page cross-origin isolated where the server
// doesn't (GitHub Pages, say: no way to set headers there), so it can have
// SharedArrayBuffer, which the harts' threads need: it adds the headers that
// take to every response. src/browser.ts registers it (the page's
// data-service-worker), then reloads through it.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

self.addEventListener('fetch', event => {
  const { request } = event
  // (A request the browser can't make here; leave it be.)
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return
  event.respondWith(
    fetch(request).then(response => {
      if (response.status === 0) return response // opaque: nothing to add to
      const headers = new Headers(response.headers)
      headers.set('Cross-Origin-Opener-Policy', 'same-origin')
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
      headers.set('Cross-Origin-Resource-Policy', 'same-origin')
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    }),
  )
})
