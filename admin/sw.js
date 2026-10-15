// Spartan Ops service worker: keeps the app's own files on the phone so it opens fast, even with a weak signal.
// Orders, inventory and the store data are NOT stored here; they come from Firebase (which keeps its own offline copy).
const VERSION = "spartan-ops-2";
const SHELL = ["./", "./ops/", "./manifest.webmanifest", "./icons/ops-192.png", "./icons/ops-512.png", "./icons/ops-apple-180.png", "./icons/ops-64.png", "../images/helmet-192.png"];
const FIREBASE = "https://www.gstatic.com/firebasejs/";                 // versioned URLs, never change

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("spartan-ops-") && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// the fresh copy when the network answers quickly; the saved copy when it doesn't
function networkFirst(req, key, waitMs){
  return new Promise(resolve => {
    let done = false;
    const fallback = () => caches.match(key).then(hit => { if (!done && hit) { done = true; resolve(hit); } });
    const t = setTimeout(fallback, waitMs);
    fetch(req).then(res => {
      clearTimeout(t);
      if (res && res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(key, copy)); }
      if (!done) { done = true; resolve(res); }
    }).catch(() => { clearTimeout(t); caches.match(key).then(hit => { if (!done) { done = true; resolve(hit || Response.error()); } }); });
  });
}
function cacheFirst(req){
  return caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res && (res.ok || res.type === "opaque")) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  }));
}
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.href.startsWith(FIREBASE)) { e.respondWith(cacheFirst(req)); return; }
  if (url.origin !== location.origin) return;                          // sign-in, Firestore, fonts, PDF tools: straight to the network
  const scope = new URL("./", self.registration.scope).pathname;        // …/admin/
  const path = url.pathname;
  if (req.mode === "navigate") {
    if (path === scope || path === scope + "index.html") { e.respondWith(networkFirst(req, "./", 2500)); return; }
    if (path === scope + "ops/" || path === scope + "ops/index.html") { e.respondWith(networkFirst(req, "./ops/", 2500)); return; }
    return;
  }
  if (SHELL.some(s => new URL(s, self.registration.scope).pathname === path)) e.respondWith(networkFirst(req, req, 2500));
});

// ----- Phone alerts (sent by the alerts script through Firebase Cloud Messaging) -----
self.addEventListener("push", e => {
  let d = {};
  try { const j = e.data ? e.data.json() : {}; d = j.data || j.notification || j; } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  const title = d.title || "Spartan Ops";
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || "", tag: d.tag || undefined, renotify: !!d.tag,
    icon: new URL("./icons/ops-192.png", self.registration.scope).href,
    badge: new URL("./icons/ops-64.png", self.registration.scope).href,
    data: { url: new URL(d.url || "./ops/#orders", self.registration.scope).href }
  }));
});
// tap: bring the open app to the front on that page, or open it
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || new URL("./ops/#orders", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const open = list.find(c => c.url.startsWith(new URL("./", self.registration.scope).href));
    if (open) return open.navigate(url).then(c => (c || open).focus()).catch(() => open.focus());
    return self.clients.openWindow(url);
  }));
});
