// Fonction Vitamines NF : fonctionne hors connexion après la première ouverture
const CACHE="vitamines-nf-v5";
const FILES=["./","index.html","manifest.webmanifest","icon-192.png","icon-512.png","apple-touch-icon.png","data.js","products.js","arabe-calligraphie.png","accueil.jpg"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES.map(f=>new Request(f,{cache:"reload"})))).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith("vitamines-nf")&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{
  const r=e.request; if(r.method!=="GET")return;
  const u=new URL(r.url);
  if(r.mode==="navigate"){e.respondWith(fetch(r,{cache:"no-cache"}).then(res=>{const c=res.clone();caches.open(CACHE).then(k=>k.put("index.html",c));return res}).catch(()=>caches.match("index.html")));return}
  /* Fichiers de l'application : toujours la version en ligne d'abord, la mémoire seulement sans Internet */
  if(u.origin===location.origin){e.respondWith(fetch(r,{cache:"no-cache"}).then(res=>{if(res.ok){const c=res.clone();caches.open(CACHE).then(k=>k.put(r,c))}return res}).catch(()=>caches.match(r,{ignoreSearch:true})));return}
  e.respondWith(caches.match(r).then(hit=>hit||fetch(r).then(res=>{if(res.ok&&(u.host.endsWith("googleapis.com")||u.host.endsWith("gstatic.com"))){const c=res.clone();caches.open(CACHE).then(k=>k.put(r,c))}return res})));
});
