"use strict";
const CACHE = "live-admin-static-v5";
const scoped = (path) => new URL(path, self.registration.scope).pathname;
const SAFE_ASSETS = ["admin-offline.html", "admin-offline.css", "admin-offline.js", "admin.css", "admin.js", "assets/admin-icons/admin-icon-192.png", "assets/admin-icons/admin-icon-512.png"].map(scoped);
self.addEventListener("install", (event) =>
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SAFE_ASSETS)),
  ),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith("live-admin-") && name !== CACHE)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.includes("/api/") ||
    url.pathname === "/admin.html"
  )
    return;
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match(scoped("admin-offline.html"))),
    );
    return;
  }
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request)
          .then((response) => {
            if (!response.ok || response.type !== "basic") return response;
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
            return response;
          })
          .catch(() =>
            request.mode === "navigate"
              ? caches.match(scoped("admin-offline.html"))
              : Response.error(),
          ),
    ),
  );
});
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data?.type === "CLEAR_PRIVATE_CACHES")
    event.waitUntil(
      caches
        .keys()
        .then((names) =>
          Promise.all(
            names
              .filter((name) => name.startsWith("live-admin-"))
              .map((name) => caches.delete(name)),
          ),
        ),
    );
});
