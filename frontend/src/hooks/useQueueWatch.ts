/**
 * 队列完成监听：轮询 BabelDOC 队列，检测条目 running→done 边沿并弹通知。
 *
 * 挂在 App 层（而非 QueueIndicator）：手机端阅读时 TabBar 隐藏、
 * QueueIndicator 不挂载，通知会丢失；App 层常驻轮询保证手机端也能收到。
 * 有任务时 2s、空闲时 10s 轮询，同一数据源可被 QueueIndicator 复用
 * （各自轮询，代价可忽略；如需严格单源可再提 store）。
 */
import { useEffect, useRef } from 'react'
import { api } from '../api/client'
import { useStore } from '../stores/useStore'

export function useQueueWatch(onBusyEdge?: (busy: boolean) => void): void {
  /** 上一轮快照中各条目的状态：用于检测 running→done 的完成边沿 */
  const prevStatus = useRef<Map<string, string>>(new Map())
  const prevBusy = useRef(false)
  const busyEdgeRef = useRef(onBusyEdge)
  busyEdgeRef.current = onBusyEdge

  useEffect(() => {
    let timer = 0
    let stopped = false
    const tick = async (): Promise<void> => {
      if (stopped) return
      try {
        const s = await api.babelDocQueue()
        const busy = (s.counts.running ?? 0) + (s.counts.pending ?? 0) > 0
        // 刚完成时刷新文献列表，让按钮状态跟上
        if (prevBusy.current && !busy) void useStore.getState().refreshLibrary()
        // 完成边沿（上一轮 running → 本轮 done）→ 中性提示 + 「查看」动作：
        // 点击后打开该文档并切到双语视图。failed 不弹（队列详情里已有，避免打扰）。
        // 同一轮多篇完成合并为一条通知（后弹覆盖前弹，避免刷屏漏知感）。
        const finished = s.items.filter(
          (it) => it.status === 'done' && prevStatus.current.get(it.doc_id) === 'running',
        )
        if (finished.length === 1) {
          useStore.getState().setNotice(`《${finished[0].title}》双语版已就绪`, {
            label: '查看',
            run: () => { useStore.getState().requestBilingualView(finished[0].doc_id) },
          })
        } else if (finished.length > 1) {
          const first = finished[0]
          useStore.getState().setNotice(`${finished.length} 篇论文双语版已就绪（含《${first.title}》）`, {
            label: '查看',
            run: () => { useStore.getState().requestBilingualView(first.doc_id) },
          })
        }
        prevStatus.current = new Map(s.items.map((it) => [it.doc_id, it.status]))
        if (prevBusy.current !== busy) busyEdgeRef.current?.(busy)
        prevBusy.current = busy
        timer = window.setTimeout(tick, busy ? 2000 : 10000)
      } catch {
        timer = window.setTimeout(tick, 10000)
      }
    }
    void tick()
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [])
}
