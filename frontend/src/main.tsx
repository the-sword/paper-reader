import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// KaTeX 样式必须引入，否则公式只剩裸字符（缺少字体与排版规则）
import 'katex/dist/katex.min.css'
import './styles/global.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
