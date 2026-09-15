import { Dir } from './types'
import { RawDoc, RawCell, defaultCell } from './validation'

/**
 * 暴雨示例：5×6 站厅，第 4 列整列被倒灌封闭，左右两侧仅靠
 * 1 组电梯（(2,2) 与 (2,5)，首次等待 10 秒）连通。
 * 起点 (5,1) 朝北，终点 (1,6)；手算最优为 46 秒、2 次转弯。
 */
export interface Scenario {
  name: string
  doc: RawDoc
  start: { r: number; c: number }
  goal: { r: number; c: number }
  dir: Dir
}

function fill(rows: number, cols: number, make: (r: number, c: number) => RawCell): RawCell[] {
  const out: RawCell[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) out.push(make(r, c))
  }
  return out
}

export function floodScenario(): Scenario {
  const rows = 5
  const cols = 6
  const blocked = new Set(['0,3', '1,3', '2,3', '3,3', '4,3'])
  const elevators = new Map([
    ['1,1', { group: '1', wait: '10' }],
    ['1,4', { group: '1', wait: '10' }],
  ])
  const cells = fill(rows, cols, (r, c) => {
    const key = `${r},${c}`
    const base = defaultCell()
    if (blocked.has(key)) return { ...base, kind: 'blocked' }
    const el = elevators.get(key)
    if (el) return { ...base, cost: '3', kind: 'elevator', ...el }
    return { ...base, cost: '3' }
  })
  return {
    name: '暴雨倒灌示例',
    doc: { rows: String(rows), cols: String(cols), cells },
    start: { r: 4, c: 0 },
    goal: { r: 0, c: 5 },
    dir: 0, // 北
  }
}

/** 纯步行示例：3×3，无阻断无电梯，用于最短路径与转弯权衡。 */
export function plainScenario(): Scenario {
  const rows = 3
  const cols = 3
  const cells = fill(rows, cols, () => ({ ...defaultCell(), cost: '1' }))
  return {
    name: '纯步行 3×3',
    doc: { rows: String(rows), cols: String(cols), cells },
    start: { r: 2, c: 0 },
    goal: { r: 0, c: 2 },
    dir: 0,
  }
}
