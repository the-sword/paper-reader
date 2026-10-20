/**
 * Paper Reader Service Worker
 *
 * 策略（面向弱 VPS + 离线阅读）：
 *  - 应用外壳（HTML/JS/CSS/图标/字体）：cache-first，带版本号，新版本后清理旧缓存
 *  - API 请求：完全网络优先，不缓存（文献列表、翻译等必须实时）
 *  - 已生成的双语/原文 PDF：cache-first（文件不可变，缓存后可离线阅读）
 *
 * 注意：构建产物文件名带 hash，内容变化 ⇒ 文件名变化 ⇒ 自动失效，
 * 版本号仅用于缓存桶清理。
 */
const VERSION = 'v1'
const SHELL_CACHE = `pr-shell-${VERSION}`
const PDF_CACHE = `pr-pdf-${VERSION}`

self.addEventListener('install', (event) => {
  // 不做预缓存清单——外壳资源在首次访问时按需缓存即可
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names
          .filter((n) => n.startsWith('pr-') && n !== SHELL_CACHE && n !== PDF_CACHE)
          .map((n) => caches.delete(n)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // API：永远走网络（带 token 的查询串不影响判断）
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname.startsWith('/api/reading/babeldoc/') && url.pathname.endsWith('/pdf')) {
      // 双语/原文 PDF 文件：不可变内容，cache-first，支持离线阅读
      event.respondWith(
        (async () => {
          const cache = await caches.open(PDF_CACHE)
          const hit = await cache.match(req)
          if (hit) return hit
          const resp = await fetch(req)
          if (resp.ok) cache.put(req, resp.clone())
          return resp
        })(),
      )
    }
    return
  }

  // 静态资源（含 hash 的 assets / 图标 / manifest）：cache-first
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      const hit = await cache.match(req)
      if (hit) return hit
      const resp = await fetch(req)
      if (resp.ok && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || url.pathname === '/manifest.json')) {
        cache.put(req, resp.clone())
      }
      return resp
    })(),
  )
})
