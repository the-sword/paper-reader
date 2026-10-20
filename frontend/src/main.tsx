import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// KaTeX 样式必须引入，否则公式只剩裸字符（缺少字体与排版规则）
import 'katex/dist/katex.min.css'
import './styles/global.css'

// PWA：注册 service worker（仅生产构建生效；注册失败静默，不影响使用）
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      /* 注册失败（如非 HTTPS/localhost）忽略 */
    })
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
