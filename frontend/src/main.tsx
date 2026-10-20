import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// KaTeX 样式必须引入，否则公式只剩裸字符（缺少字体与排版规则）
import 'katex/dist/katex.min.css'
import './styles/global.css'

// PWA：注册 service worker（仅生产构建生效；注册失败静默，不影响使用）
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    // updateViaCache: 'none' —— 每次更新检查都直接拉最新 sw.js，
    // 不被中间层 HTTP 缓存拖住（VPS + 反代场景下尤其重要）
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((reg) => {
      // 发现等待中的新 SW（发新版后）→ 立即接管，实现静默自动更新
      if (reg.waiting) reg.waiting.postMessage('SKIP_WAITING')
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            nw.postMessage('SKIP_WAITING')
          }
        })
      })
      // 浏览器只在导航/页面加载时做更新检查；本应用常长时间挂在前台，
      // 定时 + 回到前台时主动检查，发新版后无需手动刷新即可拿到
      const check = () => { void reg.update().catch(() => undefined) }
      window.setInterval(check, 60 * 60 * 1000)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check()
      })
    }).catch(() => {
      /* 注册失败（如非 HTTPS/localhost）忽略 */
    })
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
