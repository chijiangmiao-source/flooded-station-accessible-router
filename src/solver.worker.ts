/**
 * 求解 Worker：把可能较重的最短路计算移出主线程，
 * 保证求解期间界面仍可点击、编辑与滚动。
 */
import { solve } from './solver'
import { Dir, Grid, SolveResult } from './types'

export interface SolveRequest {
  id: number
  grid: Grid
  startR: number
  startC: number
  goalR: number
  goalC: number
  startDir: Dir
}

export interface SolveResponse {
  id: number
  result: SolveResult
}

interface WorkerScope {
  onmessage: ((ev: MessageEvent<SolveRequest>) => void) | null
  postMessage(message: SolveResponse): void
}

const scope = self as unknown as WorkerScope

scope.onmessage = (ev) => {
  const req = ev.data
  const result = solve(req.grid, {
    startR: req.startR,
    startC: req.startC,
    goalR: req.goalR,
    goalC: req.goalC,
    startDir: req.startDir,
  })
  scope.postMessage({ id: req.id, result })
}
