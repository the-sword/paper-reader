/**
 * 全应用图标一律用内联 SVG，不用 emoji：
 * 缺 emoji 字体的系统/浏览器会把 emoji 渲染成方块（豆腐块）。
 * 路径取 lucide 风格线性图标，颜色跟随 currentColor。
 */

/** 图标路径常量：每个元素是一条 path 的 d 属性 */
export const PATH_BOOK = 'M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20'
export const PATH_BOOK_OPEN = [
  'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z',
  'M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z',
]
export const PATH_LIBRARY = ['M16 6l4 14', 'M12 6v14', 'M8 8v12', 'M4 4v16']
export const PATH_RADAR = [
  'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0',
  'M12 12m-5 0a5 5 0 1 0 10 0a5 5 0 1 0 -10 0',
  'M12 12L19 5',
]
export const PATH_SEARCH = ['M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14', 'M21 21l-4.35-4.35']
export const PATH_SETTINGS = [
  'M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3',
  'M1 14h6', 'M9 8h6', 'M17 16h6',
]
export const PATH_PLUS = 'M12 5v14M5 12h14'
export const PATH_X = 'M18 6L6 18M6 6l12 12'
export const PATH_CHEVRON_LEFT = 'M15 18l-6-6 6-6'
export const PATH_CHEVRON_RIGHT = 'M9 18l6-6-6-6'
export const PATH_CHEVRON_DOWN = 'M6 9l6 6 6-6'
export const PATH_PANEL_RIGHT = ['M3 3h18v18H3z', 'M15 3v18']
export const PATH_FOCUS = [
  'M8 3H5a2 2 0 0 0-2 2v3', 'M21 8V5a2 2 0 0 0-2-2h-3',
  'M3 16v3a2 2 0 0 0 2 2h3', 'M16 21h3a2 2 0 0 0 2-2v-3',
]
export const PATH_DOWNLOAD = ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3']
export const PATH_SPARKLE = 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z'
export const PATH_COMMAND = 'M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3'
export const PATH_FOLDER =
  'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'
export const PATH_PENCIL = 'M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z'
export const PATH_TRASH = [
  'M3 6h18',
  'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
  'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
]
export const PATH_UPLOAD = [
  'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M12 18v-6', 'M9 15l3-3 3 3',
]

interface IconProps {
  d: string | string[]
  size?: number
}

/** 线性图标：d 为单条或多条 path 数据 */
export function Icon({ d, size = 13 }: IconProps) {
  const paths = Array.isArray(d) ? d : [d]
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" style={{ flexShrink: 0 }}
    >
      {paths.map((p) => <path key={p} d={p} />)}
    </svg>
  )
}
