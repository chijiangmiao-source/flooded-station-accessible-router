import { useCallback, useEffect, useRef, useState } from 'react'
import { solve } from './solver'
import { Dir, Grid, SolveResult } from './types'
import type { SolveRequest, SolveResponse } from './solver.worker'

export interface SolveArgs {
  startR: number
  startC: number
  goalR: number
  goalC: number
  startDir: Dir
  pushLimit: number | null // 连续推行上限（秒）；null 表示不限制
}

/**
 * 在 Web Worker 中运行求解器，主线程保持可交互。
 * 任何会改变问题的编辑都应调用 clear()：它会作废尚未返回的
 * 旧请求，确保迟到的结果不会覆盖已清空的界面。
 * 若运行环境不支持模块 Worker，则退化为同步求解。
 */
export function useSolver(): {
  busy: boolean
  result: SolveResult | undefined
  run: (grid: Grid, args: SolveArgs) => void
  clear: () => void
} {
  const workerRef = useRef<Worker | null>(null)
  const idRef = useRef(0)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<SolveResult | undefined>(undefined)

  useEffect(() => {
    return () => {
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [])

  const clear = useCallback((): void => {
    idRef.current++
    setBusy(false)
    setResult(undefined)
  }, [])

  const run = useCallback((grid: Grid, args: SolveArgs): void => {
    const id = ++idRef.current
    setBusy(true)
    setResult(undefined)

    let worker = workerRef.current
    if (!worker) {
      try {
        worker = new Worker(new URL('./solver.worker.ts', import.meta.url), {
          type: 'module',
        })
        workerRef.current = worker
      } catch {
        worker = null
      }
    }

    if (!worker) {
      // 同步兜底：仍可得到正确结果，只是极端网格下会短暂占用主线程
      const r = solve(grid, args)
      if (id === idRef.current) {
        setResult(r)
        setBusy(false)
      }
      return
    }

    const req: SolveRequest = { id, grid, ...args }
    worker.onmessage = (ev: MessageEvent<SolveResponse>) => {
      if (ev.data.id !== idRef.current) return // 已被编辑作废
      setResult(ev.data.result)
      setBusy(false)
    }
    worker.onerror = () => {
      if (id !== idRef.current) return
      // Worker 内部异常时退回同步求解，保证功能可用
      const r = solve(grid, args)
      setResult(r)
      setBusy(false)
    }
    worker.postMessage(req)
  }, [])

  return { busy, result, run, clear }
}
