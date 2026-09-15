/**
 * 复核求解器。
 *
 * 在增强状态 (位置, 朝向, 已付费电梯组集合) 上做 Dijkstra 最短路。
 * 每“张”状态标签依次比较：
 *   1. 总秒数（最小）
 *   2. 转弯数（最小）
 *   3. 从起点起逐项比较 (行号, 列号) 坐标序列，字典序取小
 *
 * 动作：
 *   - 四向正交移动：基础费 = 目标格耗时；方向改变再加 5 秒转弯费；
 *   - 同组电梯换乘：仅可从电梯格出发，到达同组任意另一部电梯，
 *     固定 8 秒，朝向不变；该组首次乘用额外加收一次等待秒数。
 *
 * 所有边费用为正（行走至少 1 秒，换乘 8 秒），因此总时间为 t 的标签
 * 只能由总时间小于 t 的标签生成；按 (总秒数, 转弯数) 排序的 Dijkstra
 * 在弹出任何时间 t 的标签之前，时间 t 的全部候选都已入堆，第三级
 * 坐标序列字典序可在松弛时直接比较定论。坐标序列的字典序在“追加
 * 相同后缀”下保持不变，故每个状态只保留三级最优标签是安全的。
 */

import {
  Cell,
  DIR_DELTA,
  Dir,
  ElevatorCell,
  Grid,
  RouteStep,
  SolveResult,
  TURN_PENALTY,
  ELEVATOR_FARE,
} from './types'

const POS_BITS = 9 // 20*20 = 400 < 512
const POS_MASK = (1 << POS_BITS) - 1

function makeKey(pos: number, dir: Dir, paid: number): number {
  return pos | (dir << POS_BITS) | (paid << (POS_BITS + 2))
}

function keyPos(key: number): number {
  return key & POS_MASK
}
function keyDir(key: number): Dir {
  return ((key >> POS_BITS) & 3) as Dir
}
function keyPaid(key: number): number {
  return key >> (POS_BITS + 2)
}

type MoveKind = 'start' | 'walk' | 'elevator'

/** 到达某状态时的最优标签及其来源边。 */
interface Label {
  key: number
  time: number
  turns: number
  pred: number // 前驱状态 key，起点为 -1
  via: MoveKind
  base: number // 来源边的基础耗时
  turn: number // 来源边的转弯费
  fare: number // 来源边的电梯费（8，首次乘用时另含等待）
  wait: number // 来源边中首次等待部分
  group: number // 电梯换乘组号（否则 0）
  gen: number // 堆条目代号：标签每被替换一次加 1
}

interface HeapEntry {
  key: number
  time: number
  turns: number
  gen: number
}

/** 最小二叉堆：按 (总秒数, 转弯数, key) 排序（路径序列不参与堆序）。 */
class MinHeap {
  private a: HeapEntry[] = []

  get size(): number {
    return this.a.length
  }

  push(e: HeapEntry): void {
    const a = this.a
    a.push(e)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.less(a[i], a[p])) {
        ;[a[i], a[p]] = [a[p], a[i]]
        i = p
      } else break
    }
  }

  pop(): HeapEntry | undefined {
    const a = this.a
    if (a.length === 0) return undefined
    const top = a[0]
    const last = a.pop()!
    if (a.length > 0) {
      a[0] = last
      let i = 0
      const n = a.length
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < n && this.less(a[l], a[m])) m = l
        if (r < n && this.less(a[r], a[m])) m = r
        if (m === i) break
        ;[a[i], a[m]] = [a[m], a[i]]
        i = m
      }
    }
    return top
  }

  private less(x: HeapEntry, y: HeapEntry): boolean {
    if (x.time !== y.time) return x.time < y.time
    if (x.turns !== y.turns) return x.turns < y.turns
    return x.key < y.key
  }
}

/** 沿前驱链重建坐标序列 [r0,c0,r1,c1,...]（含起点，前驱在前）。 */
function coordChain(labels: Map<number, Label>, key: number, cols: number): number[] {
  const seq: number[] = []
  let k = key
  while (k !== -1) {
    const lab = labels.get(k)!
    const pos = keyPos(lab.key)
    seq.push((pos / cols) | 0, pos % cols)
    k = lab.pred
  }
  seq.reverse()
  return seq
}

/**
 * 坐标序列字典序：逐项比较，首个不同的 (行,列) 决定大小。
 * 当一条序列是另一条的严格前缀时，把较短者判为“更大”（等价于在结尾
 * 放置 +∞ 终结符）。该约定使偏序在“追加相同后缀”下保持不变：
 *   A ≤ B ⇒ A+suffix ≤ B+suffix
 * 这是按状态只保留一张标签所必需的（否则中间标签被替换后，延伸到
 * 终点的最优链可能被破坏）。而到同一终点的等总秒数路线不可能互为
 * 前缀——所有边费用为正，前缀路线必然更便宜——所以终点裁决与题目
 * 要求的“逐项比较取小者”完全等价。
 */
function compareSeq(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  if (a.length !== b.length) return a.length < b.length ? 1 : -1
  return 0
}

export interface SolveOptions {
  startR: number
  startC: number
  goalR: number
  goalC: number
  startDir: Dir
}

export function solve(grid: Grid, opt: SolveOptions): SolveResult {
  const { rows, cols, cells } = grid
  const startPos = opt.startR * cols + opt.startC
  const goalPos = opt.goalR * cols + opt.goalC

  const toResult = (reachable: boolean, total: number, turns: number, steps: RouteStep[]): SolveResult => {
    const { seen, count } = floodReachSet(grid, startPos)
    return { reachable, total, turns, steps, reachableCount: count, reachSeen: seen }
  }

  if (cells[startPos].kind === 'blocked' || cells[goalPos].kind === 'blocked') {
    return toResult(false, 0, 0, [])
  }

  // 各组电梯位置与等待秒数（同组等待一致性由校验层保证）。
  const groupOf = new Int8Array(cells.length) // 0 表示不在任何组
  const members: number[][] = []
  const groupWait: number[] = [0]
  for (let p = 0; p < cells.length; p++) {
    const cell = cells[p]
    if (cell.kind === 'elevator') {
      const g = cell.group
      groupOf[p] = g
      if (!members[g]) {
        members[g] = []
        groupWait[g] = cell.wait
      }
      members[g].push(p)
    }
  }

  const labels = new Map<number, Label>()
  const heap = new MinHeap()

  const startKey = makeKey(startPos, opt.startDir, 0)
  labels.set(startKey, {
    key: startKey,
    time: 0,
    turns: 0,
    pred: -1,
    via: 'start',
    base: 0,
    turn: 0,
    fare: 0,
    wait: 0,
    group: 0,
    gen: 0,
  })
  heap.push({ key: startKey, time: 0, turns: 0, gen: 0 })

  const relax = (
    pred: Label,
    nextPos: number,
    nextDir: Dir,
    nextPaid: number,
    edgeTime: number,
    edgeTurns: number,
    via: MoveKind,
    base: number,
    turn: number,
    fare: number,
    wait: number,
    group: number,
  ): void => {
    const nk = makeKey(nextPos, nextDir, nextPaid)
    const nt = pred.time + edgeTime
    const nTurns = pred.turns + edgeTurns
    const old = labels.get(nk)
    let better: boolean
    if (!old) {
      better = true
    } else if (nt !== old.time) {
      better = nt < old.time
    } else if (nTurns !== old.turns) {
      better = nTurns < old.turns
    } else {
      // 第三级：逐项比较坐标序列。候选标签临时挂表以便沿前驱链重建。
      const cand: Label = {
        key: nk, time: nt, turns: nTurns, pred: pred.key, via,
        base, turn, fare, wait, group, gen: 0,
      }
      labels.set(nk, cand)
      const sNew = coordChain(labels, nk, cols)
      labels.set(nk, old)
      const sOld = coordChain(labels, old.key, cols)
      better = compareSeq(sNew, sOld) < 0
    }
    if (better) {
      const gen = old ? old.gen + 1 : 0
      labels.set(nk, {
        key: nk, time: nt, turns: nTurns, pred: pred.key, via,
        base, turn, fare, wait, group, gen,
      })
      heap.push({ key: nk, time: nt, turns: nTurns, gen })
    }
  }

  while (heap.size > 0) {
    const e = heap.pop()!
    const lab = labels.get(e.key)
    // 过时条目（标签已被更优者替换）
    if (!lab || lab.gen !== e.gen) continue

    const pos = keyPos(e.key)
    const dir = keyDir(e.key)
    const paid = keyPaid(e.key)
    const r = (pos / cols) | 0
    const c = pos % cols

    // 1) 四向正交移动
    for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
      const [dr, dc] = DIR_DELTA[d]
      const nr = r + dr
      const nc = c + dc
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue
      const np = nr * cols + nc
      const target: Cell = cells[np]
      if (target.kind === 'blocked') continue
      const turned = d !== dir
      relax(
        lab, np, d, paid,
        target.cost + (turned ? TURN_PENALTY : 0),
        turned ? 1 : 0,
        'walk', target.cost, turned ? TURN_PENALTY : 0, 0, 0, 0,
      )
    }

    // 2) 同组电梯换乘（朝向不变，不转弯；首次乘用加收等待）
    const here = cells[pos]
    if (here.kind === 'elevator') {
      const g = here.group
      const bit = 1 << (g - 1)
      const first = (paid & bit) === 0
      const wait = first ? groupWait[g] : 0
      for (const np of members[g]) {
        if (np === pos) continue
        relax(
          lab, np, dir, paid | bit,
          ELEVATOR_FARE + wait, 0,
          'elevator', 0, 0, ELEVATOR_FARE + wait, wait, g,
        )
      }
    }
  }

  // 在所有“位于终点”的状态标签中选三级字典序最优者
  let best: Label | null = null
  let bestSeq: number[] | null = null
  for (const lab of labels.values()) {
    if (keyPos(lab.key) !== goalPos) continue
    let take = false
    if (!best) {
      take = true
    } else if (lab.time !== best.time) {
      take = lab.time < best.time
    } else if (lab.turns !== best.turns) {
      take = lab.turns < best.turns
    } else {
      const s = coordChain(labels, lab.key, cols)
      take = compareSeq(s, bestSeq!) < 0
      if (take) bestSeq = s
    }
    if (take) {
      best = lab
      bestSeq = coordChain(labels, lab.key, cols)
    }
  }

  if (!best) {
    return toResult(false, 0, 0, [])
  }

  if ((globalThis as any).__X && goalPos === 8 && rows === 3) {
    for (const gk of [520, 1032]) {
      if (!labels.has(gk)) continue
      console.log('GK', gk, 'coord', JSON.stringify(coordChain(labels, gk, cols)),
        'built', JSON.stringify(buildSteps(labels, gk, grid).map(x => [x.r, x.c])))
    }
  }
  return toResult(true, best.time, best.turns, buildSteps(labels, best.key, grid))
}

/** 沿前驱链还原逐步费用明细与累计值。 */
function buildSteps(labels: Map<number, Label>, goalKey: number, grid: Grid): RouteStep[] {
  const chain: Label[] = []
  let k: number = goalKey
  const bb: number[] = []
  while (k !== -1) {
    bb.push(k, labels.get(k)!.pred)
    chain.push(labels.get(k)!)
    k = labels.get(k)!.pred
  }
  if ((globalThis as any).__X && (goalKey === 520 || goalKey === 1032)) console.log('BSRAW', goalKey, JSON.stringify(bb))
  chain.reverse()

  const { cells, cols } = grid
  const out: RouteStep[] = []
  let total = 0
  for (let i = 0; i < chain.length; i++) {
    const lab = chain[i]
    const pos = keyPos(lab.key)
    const r = (pos / cols) | 0
    const c = pos % cols
    if (i === 0) {
      out.push({
        r, c, dir: keyDir(lab.key),
        base: 0, turn: 0, fare: 0, wait: 0, stepCost: 0, total: 0,
        kind: 'start',
      })
      continue
    }
    total += lab.base + lab.turn + lab.fare
    const here = cells[pos]
    out.push({
      r,
      c,
      dir: keyDir(lab.key),
      base: lab.base,
      turn: lab.turn,
      fare: lab.fare,
      wait: lab.wait,
      stepCost: lab.base + lab.turn + lab.fare,
      total,
      kind: lab.via === 'elevator' ? 'elevator' : 'walk',
      group: lab.via === 'elevator' ? lab.group : undefined,
      enteredGroup:
        here.kind === 'elevator' && lab.via === 'walk'
          ? (here as ElevatorCell).group
          : undefined,
    })
  }
  return out
}

/**
 * 失败证据：在与求解器相同的连通关系（正交相邻 + 同组电梯）上，
 * 从起点做广度优先，返回可达的非阻断格集合与数量。审核员可据此
 * 在网格着色上独立复核“终点不在可达集合内”。
 */
export function floodReachSet(grid: Grid, startPos: number): { seen: Uint8Array; count: number } {
  const { rows, cols, cells } = grid
  const seen = new Uint8Array(cells.length)
  if (startPos < 0 || startPos >= cells.length || cells[startPos].kind === 'blocked') {
    return { seen, count: 0 }
  }

  const groupOf = new Int8Array(cells.length)
  const members: number[][] = []
  for (let p = 0; p < cells.length; p++) {
    const cell = cells[p]
    if (cell.kind === 'elevator') {
      groupOf[p] = cell.group
      ;(members[cell.group] ??= []).push(p)
    }
  }

  const queue: number[] = [startPos]
  seen[startPos] = 1
  let count = 0
  while (queue.length > 0) {
    const p = queue.shift()!
    count++
    const r = (p / cols) | 0
    const c = p % cols
    for (const [dr, dc] of DIR_DELTA) {
      const nr = r + dr
      const nc = c + dc
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue
      const np = nr * cols + nc
      if (!seen[np] && cells[np].kind !== 'blocked') {
        seen[np] = 1
        queue.push(np)
      }
    }
    const g = groupOf[p]
    if (g) {
      for (const np of members[g]) {
        if (!seen[np]) {
          seen[np] = 1
          queue.push(np)
        }
      }
    }
  }
  return { seen, count }
}

export function floodReach(grid: Grid, startPos: number): number {
  return floodReachSet(grid, startPos).count
}
