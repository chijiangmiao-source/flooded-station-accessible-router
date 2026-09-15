/**
 * 编辑模型 → 领域模型的解析与校验。
 * 所有非法字段都带单元格定位（0 基下标 -1 表示网格级字段），
 * 供界面逐格标红并列出“第 r 行第 c 列：……”的反馈。
 */

import { Cell, Grid } from './types'

export type CellKindInput = 'blocked' | 'normal' | 'elevator'

export interface RawCell {
  kind: CellKindInput
  cost: string
  group: string
  wait: string
}

export interface RawDoc {
  rows: string
  cols: string
  cells: RawCell[]
}

export interface FieldError {
  pos: number // cells 下标；-1 表示尺寸字段
  r: number
  c: number
  field: 'rows' | 'cols' | 'cost' | 'group' | 'wait'
  message: string
}

export const MIN_DIM = 1
export const MAX_DIM = 20
export const MIN_COST = 1
export const MAX_COST = 99
export const MIN_GROUP = 1
export const MAX_GROUP = 9
export const MIN_WAIT = 1
export const MAX_WAIT = 99

const INT_RE = /^\d+$/

function parseBoundedInt(raw: string, min: number, max: number): number | null {
  if (!INT_RE.test(raw.trim())) return null
  const v = Number(raw.trim())
  if (!Number.isSafeInteger(v) || v < min || v > max) return null
  return v
}

export function defaultCell(): RawCell {
  return { kind: 'normal', cost: '5', group: '1', wait: '10' }
}

export function makeRawDoc(rows: number, cols: number): RawDoc {
  return {
    rows: String(rows),
    cols: String(cols),
    cells: Array.from({ length: rows * cols }, defaultCell),
  }
}

export interface Validated {
  grid: Grid | null
  errors: FieldError[]
}

/** 校验整份编辑文档；errors 为空时 grid 非空。 */
export function validateDoc(doc: RawDoc): Validated {
  const errors: FieldError[] = []

  const rows = parseBoundedInt(doc.rows, MIN_DIM, MAX_DIM)
  const cols = parseBoundedInt(doc.cols, MIN_DIM, MAX_DIM)
  if (rows === null) {
    errors.push({
      pos: -1, r: -1, c: -1, field: 'rows',
      message: `行数须为 ${MIN_DIM}–${MAX_DIM} 的整数`,
    })
  }
  if (cols === null) {
    errors.push({
      pos: -1, r: -1, c: -1, field: 'cols',
      message: `列数须为 ${MIN_DIM}–${MAX_DIM} 的整数`,
    })
  }
  if (rows === null || cols === null) return { grid: null, errors }

  const expected = rows * cols
  if (doc.cells.length !== expected) {
    // 尺寸调整的渲染间隙中理论上可能出现，直接整体判无效
    return { grid: null, errors }
  }

  const parsed: (Cell | null)[] = new Array(expected).fill(null)

  for (let p = 0; p < expected; p++) {
    const raw = doc.cells[p]
    const r = (p / cols) | 0
    const c = p % cols
    if (raw.kind === 'blocked') {
      parsed[p] = { kind: 'blocked' }
      continue
    }
    const cost = parseBoundedInt(raw.cost, MIN_COST, MAX_COST)
    if (cost === null) {
      errors.push({
        pos: p, r, c, field: 'cost',
        message: `第 ${r + 1} 行第 ${c + 1} 列：耗时须为 ${MIN_COST}–${MAX_COST} 的整数秒`,
      })
    }
    if (raw.kind === 'elevator') {
      const group = parseBoundedInt(raw.group, MIN_GROUP, MAX_GROUP)
      if (group === null) {
        errors.push({
          pos: p, r, c, field: 'group',
          message: `第 ${r + 1} 行第 ${c + 1} 列：电梯组号须为 ${MIN_GROUP}–${MAX_GROUP} 的整数`,
        })
      }
      const wait = parseBoundedInt(raw.wait, MIN_WAIT, MAX_WAIT)
      if (wait === null) {
        errors.push({
          pos: p, r, c, field: 'wait',
          message: `第 ${r + 1} 行第 ${c + 1} 列：首次等待须为 ${MIN_WAIT}–${MAX_WAIT} 的整数秒`,
        })
      }
      if (cost !== null && group !== null && wait !== null) {
        parsed[p] = { kind: 'elevator', cost, group, wait }
      }
    } else if (cost !== null) {
      parsed[p] = { kind: 'normal', cost }
    }
  }

  // 同组电梯的首次等待必须一致：该组只允许有一个“首次等待”价。
  if (errors.length === 0) {
    const waitByGroup = new Map<number, { wait: number; pos: number }>()
    for (let p = 0; p < expected; p++) {
      const cell = parsed[p]
      if (cell && cell.kind === 'elevator') {
        const prev = waitByGroup.get(cell.group)
        if (!prev) {
          waitByGroup.set(cell.group, { wait: cell.wait, pos: p })
        } else if (prev.wait !== cell.wait) {
          const r = (p / cols) | 0
          const c = p % cols
          errors.push({
            pos: p, r, c, field: 'wait',
            message: `第 ${r + 1} 行第 ${c + 1} 列：与同组（${cell.group} 组）其他电梯的首次等待不一致，同组必须相同`,
          })
        }
      }
    }
  }

  if (errors.length > 0) return { grid: null, errors }
  return {
    grid: { rows, cols, cells: parsed as Cell[] },
    errors: [],
  }
}

export interface EndpointIssue {
  kind: 'start' | 'goal'
  message: string
}

/** 校验起终点选择（朝向始终合法，由按钮组保证）。 */
export function checkEndpoints(
  grid: Grid,
  start: { r: number; c: number } | null,
  goal: { r: number; c: number } | null,
): EndpointIssue[] {
  const issues: EndpointIssue[] = []
  if (!start) {
    issues.push({ kind: 'start', message: '尚未点选起点' })
  } else {
    const cell = grid.cells[start.r * grid.cols + start.c]
    if (!cell || cell.kind === 'blocked') {
      issues.push({
        kind: 'start',
        message: `起点（第 ${start.r + 1} 行第 ${start.c + 1} 列）位于阻断格，请重新点选`,
      })
    }
  }
  if (!goal) {
    issues.push({ kind: 'goal', message: '尚未点选终点' })
  } else {
    const cell = grid.cells[goal.r * grid.cols + goal.c]
    if (!cell || cell.kind === 'blocked') {
      issues.push({
        kind: 'goal',
        message: `终点（第 ${goal.r + 1} 行第 ${goal.c + 1} 列）位于阻断格，请重新点选`,
      })
    }
  }
  if (start && goal && start.r === goal.r && start.c === goal.c) {
    issues.push({ kind: 'goal', message: '终点与起点重合，请另选终点' })
  }
  return issues
}
