/* 韩语背诵 - Service Worker
 * 策略：网络优先（保证加新册后刷新即更新），断网时回退缓存。
 */
const CACHE = 'korean-memorizer-v61';
const ASSETS = [
  './', './index.html', './styles.css', './ink-theme.css',
  './data.js', './profiles.js', './srs.js', './audio.js',
  './recordings.js', './importer.js', './app.js',
  './manifest.json', './icon-192.png', './icon-512.png',
  './audio/ko_index.json'
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

// 是否为在线韩语 TTS 请求（百度/有道）
function isTTSRequest(url) {
  return /fanyi\.baidu\.com\/gettts/.test(url.href) ||
         /dict\.youdao\.com\/dictvoice/.test(url.href);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 跨域 TTS：用 no-cors 抓取并缓存 opaque 响应。
  // 关键：浏览器 <video>/<audio> 直接加载跨域媒体不受 CORS 限制，
  // 而 SW 用 no-cors fetch 能把跨域 TTS 响应缓存进 Cache Storage，
  // 使导入的新单词首次联网发音后、离线也能响（本地发音包只覆盖内置词）。
  if (isTTSRequest(url)) {
    e.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          if (cached) return cached;            // 离线 / 二次命中
          return fetch(req, { mode: 'no-cors' })
            .then((res) => {
              cache.put(req, res.clone()).catch(() => {});
              return res;
            })
            .catch(() => cached || Response.error());
        })
      )
    );
    return;
  }

  if (url.origin !== self.location.origin) return;  // 其他跨域不处理
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
