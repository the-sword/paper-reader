/** 划线标注的语义色：单击划词菜单色点即保存为对应颜色的下划线 */
export interface AnnotationColor {
  color: string
  label: string
}

export const ANNOTATION_COLORS: AnnotationColor[] = [
  { color: '#E9B949', label: '重点' },
  { color: '#E5736B', label: '疑问' },
  { color: '#5B8DEF', label: '定义' },
  { color: '#3FAE7C', label: '方法' },
]

/** 默认划线色：首次使用前的 lastColor */
export const DEFAULT_ANNOTATION_COLOR = ANNOTATION_COLORS[0].color

/** 按颜色取语义名；未知颜色（历史标注）返回空串 */
export function annotationLabel(color: string): string {
  return ANNOTATION_COLORS.find((c) => c.color.toLowerCase() === color.toLowerCase())?.label ?? ''
}
