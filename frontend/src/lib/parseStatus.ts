/** 解析状态的界面文案：排队中不显示百分比，其余显示「解析中 N%」 */
export function parseStatusText(state: string, progress: number): string {
  if (state === 'queued') return '排队中'
  return `解析中 ${Math.round(progress)}%`
}
