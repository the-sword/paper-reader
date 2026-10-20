/**
 * Paper Reader Service Worker
 *
 * 策略（面向弱 VPS + 离线阅读）：
 *  - HTML 入口：network-first（保证发新版后用户下次访问即拿到新外壳）
 *  - 带 hash 的构建产物（JS/CSS/字体）：cache-first（内容不变即永久有效）
 *  - 图标 / manifest：cache-first
 *  - API 请求：完全网络优先，不缓存（文献列表、翻译等必须实时）
 *  - 已生成的双语/原文 PDF：cache-first（文件不可变，缓存后可离线阅读）
 *
 * 更新机制：HTML 每次联网校验，新 HTML 引用新 hash 的资源，天然失效旧缓存；
 * 新 SW 就绪后 skipWaiting + clients.claim 立即接管，无需手动加版本号。
 * 旧缓存桶在 activate 时按前缀清理（保留当前版本桶）。
 */
const SHELL_CACHE = 'pr-shell-v1'
const PDF_CACHE = 'pr-pdf-v1'

// 当前激活的缓存桶（activate 时清理其它 pr-* 桶）
const ACTIVE = new Set([SHELL_CACHE, PDF_CACHE])

self.addEventListener('install', (event) => {
  // 新 SW 就绪即接管，不等旧页面关闭（配合 clients.claim 实现静默更新）
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names.filter((n) => n.startsWith('pr-') && !ACTIVE.has(n)).map((n) => caches.delete(n)),
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

  // HTML 入口：network-first，保证部署新版后用户立即拿到新外壳；
  // 离线时回退到缓存的 HTML（PWA 离线打开入口）
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE)
        try {
          const resp = await fetch(req)
          if (resp.ok) cache.put(req, resp.clone())
          return resp
        } catch {
          return (await cache.match(req)) || Response.error()
        }
      })(),
    )
    return
  }

  // 静态资源（hash 资源 / 图标 / manifest）：cache-first
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

// 页面侧：发现新 SW 后立即让其接管（配合 skipWaiting 静默完成更新，
// 用户无需关标签页；旧 hash 资源缓存由 activate 清理）
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})
