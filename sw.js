/* 韩语背诵 - Service Worker
 * 策略：网络优先（保证加新册后刷新即更新），断网时回退缓存。
 */
const CACHE = 'korean-memorizer-v68';
const ASSETS = [
  './', './index.html', './styles.css', './ink-theme.css',
  './data.js', './profiles.js', './srs.js', './audio.js',
  './recordings.js', './importer.js', './app.js',
  './manifest.json', './icon-192.png', './icon-512.png'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 音频 CDN（jsDelivr / raw.githubusercontent）：缓存优先，保证离线也能播内置词发音。
  // jsDelivr 返回 Access-Control-Allow-Origin:*，可用 cors 模式 fetch 并缓存真实响应。
  if (url.hostname.includes('jsdelivr.net') || url.hostname.includes('githubusercontent.com')) {
    e.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const res = await fetch(req);
          if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
          return res;
        } catch (err) {
          return cached || Response.error();
        }
      })
    );
    return;
  }
  // 在线韩语 TTS（百度 gettts 等跨域媒体）不拦截：让 <video>/<audio> 直连请求，
  // 浏览器原生支持跨域媒体播放（无需 CORS）。
  // 若 SW 用 no-cors 拦截并回传 opaque 响应，Chromium 系（夸克/Chrome）会拒绝用于媒体播放 → 发音失败。
  if (url.origin !== self.location.origin) return;  // 跨域一律不处理，直达网络
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
  );
});
