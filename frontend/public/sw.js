/**
 * Paper Reader Service Worker
 *
 * 策略（面向弱 VPS + 离线阅读）：
 *  - HTML 入口：network-first（保证发新版后用户下次访问即拿到新外壳），断网回退缓存
 *  - 带 hash 的构建产物（JS/CSS/字体/worker）：cache-first（内容不变即永久有效）
 *  - 图标 / manifest：cache-first
 *  - 原文 PDF 与双语 PDF（/api/documents/*\/file、/api/reading/babeldoc/*\/pdf）：
 *      不可变文件，cache-first → 已读文献可离线打开。
 *      只缓存完整 200 响应；pdf.js 的 Range 分块请求命中缓存时由 SW 现场切成 206，
 *      绝不把部分内容写进缓存（否则离线拿到半截 PDF）。
 *  - 阅读视图数据（segments / references / asset 图片 / 标注）：stale-while-revalidate，
 *      离线时展示最近一次已加载的内容
 *  - 其余 API：完全网络优先，不缓存（文献列表、翻译、任务状态必须实时）
 *
 * 更新机制：HTML 每次联网校验，新 HTML 引用新 hash 的资源，天然失效旧缓存；
 * 新 SW 就绪后 skipWaiting + clients.claim 立即接管，无需手动加版本号。
 * 旧缓存桶在 activate 时按前缀清理（保留当前版本桶）。
 */
const SHELL_CACHE = 'pr-shell-v3'
const PDF_CACHE = 'pr-pdf-v2'
const DATA_CACHE = 'pr-data-v1'

// 当前激活的缓存桶（activate 时清理其它 pr-* 桶）
const ACTIVE = new Set([SHELL_CACHE, PDF_CACHE, DATA_CACHE])

// PDF 缓存条数上限（FIFO 淘汰最旧条目，防止离线缓存无限占盘）
const PDF_CACHE_LIMIT = 20

// 安装时预缓存的外壳资源：保证「装完即断网」也能打开应用
const SHELL_ASSETS = [
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon.svg',
  '/icons/apple-touch-icon.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
]

/** 抓取并缓存资源；JS/HTML 文本递归解析 /assets/ 引用（入口 JS、worker） */
async function putAndScan(cache, url, seen) {
  if (seen.has(url)) return
  seen.add(url)
  let resp
  try {
    resp = await fetch(url)
  } catch {
    return
  }
  if (!resp.ok) return
  const ct = resp.headers.get('content-type') || ''
  if (/text\/(html|javascript)|javascript|text\/css/.test(ct)) {
    const text = await resp.text()
    await cache.put(url, new Response(text, { status: 200, headers: resp.headers }))
    for (const m of text.matchAll(/["'`(](\/assets\/[\w.-]+)["'`)]/g)) {
      await putAndScan(cache, m[1], seen)
    }
  } else {
    await cache.put(url, resp)
  }
}

self.addEventListener('install', (event) => {
  // 预缓存 '/' + 静态图标 + HTML/JS 中引用的全部 /assets/*（含 pdf.js worker）：
  // 首次加载时入口资源先于 SW 接管发出，不预缓存则「装完即离线」拿不到外壳。
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      const seen = new Set()
      await putAndScan(cache, '/', seen)
      await Promise.all(SHELL_ASSETS.map((u) => putAndScan(cache, u, seen)))
      // 新 SW 就绪即接管，不等旧页面关闭（配合 clients.claim 实现静默更新）
      await self.skipWaiting()
    })(),
  )
})

// 可离线阅读的 API 资源判定
const RE_PDF = /^\/api\/(documents\/[^/]+\/file|reading\/babeldoc\/[^/]+\/pdf)$/
// SWR（stale-while-revalidate）：离线时用最近一次快照，在线时后台刷新——
// 文档列表/文件夹/标签 + 解析产物 + 标注，保证「离线打开应用能进库、能读已缓存的文献」
const RE_READER_DATA = /^\/api\/(reading\/[^/]+\/(segments|references|asset\/.+)|annotations|documents(\/[^/]+)?|folders|tags)$/

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

/** 用缓存的完整响应现场合成 206 分片（pdf.js Range 请求的离线应答） */
async function rangeResponse(hit, rangeHeader) {
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
  if (!m) return hit
  const buf = await hit.arrayBuffer()
  const total = buf.byteLength
  let start
  let end
  if (m[1] === '') {
    // 后缀区间 bytes=-N
    start = Math.max(0, total - parseInt(m[2], 10))
    end = total - 1
  } else {
    start = parseInt(m[1], 10)
    end = m[2] === '' ? total - 1 : parseInt(m[2], 10)
  }
  end = Math.min(total - 1, end)
  if (start > end || start >= total) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${total}` },
    })
  }
  const headers = new Headers(hit.headers)
  headers.set('Content-Range', `bytes ${start}-${end}/${total}`)
  headers.set('Content-Length', String(end - start + 1))
  headers.set('Accept-Ranges', 'bytes')
  return new Response(buf.slice(start, end + 1), { status: 206, headers })
}

/** FIFO 淘汰：keys() 返回插入序，删到上限为止 */
async function trimCache(cache, limit) {
  const keys = await cache.keys()
  for (let i = 0; i + limit < keys.length; i++) {
    await cache.delete(keys[i])
  }
}

/** PDF：cache-first + Range 感知（仅缓存完整 200，现场合成 206） */
async function handlePdf(req, event) {
  const cache = await caches.open(PDF_CACHE)
  const hit = await cache.match(req)
  if (hit) {
    const range = req.headers.get('range')
    return range ? rangeResponse(hit, range) : hit
  }
  const resp = await fetch(req)
  // 只缓存完整文件：带 Range 头的请求回的是 206 部分内容，缓存它会污染后续请求
  if (resp.status === 200 && !req.headers.get('range')) {
    event.waitUntil(
      (async () => {
        await cache.put(req, resp.clone())
        await trimCache(cache, PDF_CACHE_LIMIT)
      })(),
    )
  }
  return resp
}

/** 阅读数据：stale-while-revalidate —— 有缓存秒回 + 后台刷新，断网用旧数据 */
async function staleWhileRevalidate(req, event) {
  const cache = await caches.open(DATA_CACHE)
  const hit = await cache.match(req)
  const net = fetch(req).then((resp) => {
    if (resp.status === 200) event.waitUntil(cache.put(req, resp.clone()))
    return resp
  })
  if (hit) {
    event.waitUntil(net.catch(() => undefined))
    return hit
  }
  return net
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  if (url.pathname.startsWith('/api/')) {
    if (RE_PDF.test(url.pathname)) {
      event.respondWith(handlePdf(req, event))
    } else if (RE_READER_DATA.test(url.pathname)) {
      event.respondWith(staleWhileRevalidate(req, event))
    }
    // 其它 API：永远走网络
    return
  }

  // HTML 入口：network-first，保证部署新版后用户立即拿到新外壳；
  // 离线时回退到缓存的 HTML（PWA 离线打开入口），再兜底到缓存的 '/'
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE)
        try {
          const resp = await fetch(req)
          if (resp.ok) event.waitUntil(cache.put(req, resp.clone()))
          return resp
        } catch {
          return (await cache.match(req)) || (await cache.match('/')) || Response.error()
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
      if (
        resp.ok &&
        (url.pathname.startsWith('/assets/') ||
          url.pathname.startsWith('/icons/') ||
          url.pathname === '/manifest.json')
      ) {
        event.waitUntil(cache.put(req, resp.clone()))
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
