import { useEffect, useRef, useState } from 'react'
import { useStore } from '../stores/useStore'
import { api } from '../api/client'

/** 双语 PDF 任务进度轮询间隔（毫秒） */
const POLL_MS = 1500
/** 启动任务时的初始进度（百分比） */
const START_PROGRESS = 5

export interface BilingualJob {
  /** 任务是否在跑 */
  running: boolean
  /** 进度百分比 0–100 */
  progress: number
  /** 任务当前阶段描述 */
  message: string
  /** 各文档双语 PDF 是否已生成（按文档 id） */
  ready: Record<string, boolean>
  /** 为当前文档启动生成任务 */
  start: () => Promise<void>
  /** 取消正在进行的任务 */
  cancel: () => Promise<void>
}

/** 双语 PDF（BabelDOC）后台任务：启动、轮询进度、完成回调与取消 */
export function useBilingualJob(onDone: () => void): BilingualJob {
  const [jobId, setJobId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState('')
  const [ready, setReady] = useState<Record<string, boolean>>({})
  const pollRef = useRef<number | null>(null)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  const currentDocId = useStore((s) => s.currentDoc?.id)

  const stopPoll = (): void => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  const finish = (): void => {
    stopPoll()
    setRunning(false)
    setJobId(null)
  }

  // 切换文档时向后端确认双语 PDF 是否已生成，避免重复生成
  useEffect(() => {
    if (!currentDocId) return
    void api.babelDocStatus(currentDocId)
      .then((r) => setReady((m) => ({ ...m, [currentDocId]: r.generated })))
      .catch(() => { /* 忽略 */ })
  }, [currentDocId])

  useEffect(() => () => stopPoll(), [])

  const pollJob = async (id: string, docId: string): Promise<void> => {
    try {
      const st = await api.babelDocJob(id)
      setProgress(st.progress)
      setMessage(st.message)
      if (st.status === 'running') return
      finish()
      if (st.status === 'done') {
        setReady((m) => ({ ...m, [docId]: true }))
        void useStore.getState().refreshLibrary()
        onDoneRef.current()
        return
      }
      useStore.setState({ error: `双语 PDF 生成失败：${st.error ?? '未知原因'}` })
    } catch (e) {
      finish()
      useStore.setState({ error: `双语 PDF：${String(e).replace(/^Error:\s*/, '')}` })
    }
  }

  const start = async (): Promise<void> => {
    const doc = useStore.getState().currentDoc
    if (!doc || running) return
    setRunning(true); setProgress(START_PROGRESS); setMessage('启动任务')
    useStore.setState({ error: null })
    try {
      const { job_id } = await api.startBabelDoc(doc.id)
      setJobId(job_id)
      pollRef.current = window.setInterval(() => { void pollJob(job_id, doc.id) }, POLL_MS)
    } catch (e) {
      finish()
      useStore.setState({ error: String(e).replace(/^Error:\s*/, '') })
    }
  }

  const cancel = async (): Promise<void> => {
    if (!jobId) return
    setMessage('正在取消…')
    try { await api.cancelBabelDoc(jobId) } catch { /* 忽略 */ }
  }

  return { running, progress, message, ready, start, cancel }
}
