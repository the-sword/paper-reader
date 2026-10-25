/**
 * 旧外壳自愈。
 *
 * 背景：静态产物按内容 hash 命名，服务器发新版后旧 hash 文件即被删除。
 * 长驻标签页 / SW 缓存的旧外壳仍引用旧 hash（典型：pdf.js worker、动态
 * import 的 chunk），请求 404 后功能坏死。识别这类「脚本/模块加载失败」
 * 并整页刷新一次以拿到新外壳；sessionStorage 标记防止刷新循环，
 * 成功渲染后由调用方清除标记（下次发版还能再自愈）。
 */
const STALE_SHELL_RE =
  /fake worker|Cannot load script|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i

const FLAG_KEY = 'pr-stale-shell-reloaded'

export function isStaleShellError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return STALE_SHELL_RE.test(msg)
}

/** 命中旧外壳特征且本会话尚未刷新过 → 刷新页面并返回 true。 */
export function selfHealStaleShell(e: unknown): boolean {
  if (!isStaleShellError(e)) return false
  try {
    if (sessionStorage.getItem(FLAG_KEY)) return false
    sessionStorage.setItem(FLAG_KEY, '1')
  } catch {
    return false
  }
  window.location.reload()
  return true
}

/** 新外壳成功渲染后调用，清除标记以便下次发版仍可自愈。 */
export function clearStaleShellFlag(): void {
  try {
    sessionStorage.removeItem(FLAG_KEY)
  } catch {
    /* 隐私模式等场景忽略 */
  }
}
