/**
 * 领域模型：车站网格、单元格、求解状态。
 *
 * 三种格子：
 *  - blocked  阻断格（暴雨倒灌后封闭，不可进入，也不可作为电梯端点）
 *  - normal   通行格，cost 为进入该格的基础耗时（1..99 秒）
 *  - elevator 电梯格，cost 为基础耗时（1..99），group 为组号（1..9），
 *             wait 为该组首次乘用的等待秒数（1..99）
 *
 * 坐标全部为 0 基；界面展示时再 +1。
 */

export type Dir = 0 | 1 | 2 | 3 // 北 0、东 1、南 2、西 3

export const DIR_DELTA: ReadonlyArray<readonly [number, number]> = [
  [-1, 0], // 北
  [0, 1], //  东
  [1, 0], //  南
  [0, -1], // 西
]

export const DIR_NAME = ['北', '东', '南', '西'] as const

export const TURN_PENALTY = 5 // 方向改变加 5 秒
export const ELEVATOR_FARE = 8 // 同组任意两部电梯间移动固定 8 秒

export type CellKind = 'blocked' | 'normal' | 'elevator'

export interface NormalCell {
  kind: 'normal'
  cost: number
}

export interface BlockedCell {
  kind: 'blocked'
}

export interface ElevatorCell {
  kind: 'elevator'
  cost: number
  group: number
  wait: number
}

export type Cell = BlockedCell | NormalCell | ElevatorCell

export interface Grid {
  rows: number
  cols: number
  cells: Cell[] // 长度 rows*cols，行优先
}

export function idx(rows: number, cols: number, r: number, c: number): number {
  void rows
  return r * cols + c
}

export function inBounds(g: Grid, r: number, c: number): boolean {
  return r >= 0 && r < g.rows && c >= 0 && c < g.cols
}

export function cellAt(g: Grid, r: number, c: number): Cell {
  return g.cells[r * g.cols + c]
}

/** 求解状态必须包含：位置、朝向、已付费电梯组集合。 */
export interface State {
  pos: number // cells 下标
  dir: Dir
  paid: number // 位掩码：第 g 位置 1 表示组 g 的首次等待已付
}

export function stateKey(s: State): number {
  // pos 最多 400（9 bit），dir 2 bit，paid 9 bit —— 20 bit，安全放入整数
  return s.pos | (s.dir << 12) | (s.paid << 14)
}

/** 路线中的一步（从第 0 步的起点开始）。 */
export interface RouteStep {
  r: number
  c: number
  dir: Dir
  base: number // 本步基础耗时（目标格耗时；起点为 0；电梯换乘为 0）
  turn: number // 本步转弯费
  fare: number // 本步电梯费（含首次等待时一并计入；普通步为 0）
  wait: number // 其中首次等待部分（fare 的子项，便于界面分列展示）
  stepCost: number // base + turn + fare
  total: number // 到达此步后的累计总秒数
  kind: 'start' | 'walk' | 'elevator'
  group?: number // 电梯换乘时的组号
  enteredGroup?: number // 走入电梯格时的组号（普通乘用一步）
}

export interface SolveResult {
  reachable: boolean
  total: number // 总秒数（不可达为 0）
  turns: number // 转弯数（不可达为 0）
  steps: RouteStep[] // reachable 为真时为最优路线
  reachableCount: number // 从起点可达的格数（按“格”计，与状态无关）
  reachSeen: Uint8Array // 可达格位图（逐格复核失败证据；阻断格为 0）
}
