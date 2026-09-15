/**
 * 复核求解器（不可变标签树实现）。
 *
 * 在增强状态 (位置, 朝向, 已付费电梯组集合) 上做 Dijkstra 最短路。
 * 每个状态标签依次比较：
 *   1. 总秒数（最小）
 *   2. 转弯数（最小）
 *   3. 从起点起逐项比较 (行号, 列号) 坐标序列，字典序取小
 *
 * 动作：
 *   - 四向正交移动：基础费 = 目标格耗时；方向改变再加 5 秒转弯费；
 *   - 同组电梯换乘：仅可从电梯格出发，到达同组任意另一部电梯，
 *     固定 8 秒，朝向不变；该组首次乘用额外加收一次等待秒数。
 *
 * 实现要点
 * --------
 *  - 状态用稠密整数 sid 索引，距离/转弯/节点指针均为定长整型数组，
 *    不使用 Map，避免大规模状态下的装箱与散列开销。
 *  - 每个被采纳的“到达事件”是标签树上的一个不可变节点，只记录
 *    父节点与本步费用，任何后继节点都不会改写它（杜绝前驱指针
 *    被后续松弛覆盖导致的链别名问题）。
 *  - 坐标序列的字典序通过树上最近公共祖先（LCA，倍增法）在
 *    O(log n) 内比较，无需重建整条序列。两条同终点序列在 LCA
 *    之后的第一个分叉节点决定大小；一条是另一条严格前缀时，把
 *    短者判为“更大”（等价于结尾放 +∞ 终结符）。该约定保证
 *    “追加同一后缀”保持偏序，故每个状态只保留一张最优标签是
 *    安全的；且所有边费用为正，到达同一终点的等总秒数路线不可
 *    能互为前缀，终点裁决与题目“逐项比较取小者”完全等价。
 */

import {
  DIR_DELTA,
  Dir,
  ElevatorCell,
  Grid,
  RouteStep,
  SolveResult,
  TURN_PENALTY,
  ELEVATOR_FARE,
} from './types'

const LOG = 20 // 2^20 超过标签树最大可能深度
const CHUNK_BITS = 16
const CHUNK = 1 << CHUNK_BITS
const CHUNK_MASK = CHUNK - 1
const INF = 0x3f3f3f3f

/** 分块定长整型数组：按需分配，避免一次性巨型连续内存。 */
class Chunks {
  private cs: Int32Array[] = []
  private readonly fillValue: number

  constructor(fillValue = 0) {
    this.fillValue = fillValue
  }

  private ensure(i: number): Int32Array {
    const ci = i >> CHUNK_BITS
    let a = this.cs[ci]
    if (!a) {
      a = new Int32Array(CHUNK)
      if (this.fillValue !== 0) a.fill(this.fillValue)
      this.cs[ci] = a
    }
    return a
  }

  get(i: number): number {
    const a = this.cs[i >> CHUNK_BITS]
    return a ? a[i & CHUNK_MASK] : this.fillValue
  }

  set(i: number, v: number): void {
    this.ensure(i)[i & CHUNK_MASK] = v
  }
}

const VIA_WALK = 0
const VIA_RIDE = 1

/**
 * 不可变标签树：节点只增不改。
 * 每个节点记录所在格、父节点、树深与来源边费用；up[k] 为向上
 * 2^k 层祖先，用于 O(log n) 的 LCA 与序列字典序比较。
 */
class NodeTree {
  readonly pos = new Chunks()
  readonly parent = new Chunks(-1)
  readonly depth = new Chunks()
  readonly base = new Chunks()
  readonly turn = new Chunks()
  readonly fare = new Chunks()
  readonly wait = new Chunks()
  readonly group = new Chunks()
  readonly via = new Chunks()
  private readonly up: Chunks[] = []
  count = 0

  constructor() {
    for (let k = 0; k < LOG; k++) this.up.push(new Chunks(-1))
  }

  add(
    pos: number,
    parentNode: number,
    via: number,
    base: number,
    turn: number,
    fare: number,
    wait: number,
    group: number,
  ): number {
    const id = this.count++
    this.pos.set(id, pos)
    this.base.set(id, base)
    this.turn.set(id, turn)
    this.fare.set(id, fare)
    this.wait.set(id, wait)
    this.group.set(id, group)
    this.via.set(id, via)
    if (parentNode < 0) {
      this.parent.set(id, -1)
      this.depth.set(id, 0)
      return id
    }
    this.parent.set(id, parentNode)
    const d = this.depth.get(parentNode) + 1
    this.depth.set(id, d)
    this.up[0].set(id, parentNode)
    // 仅实际可达的层级才会分配分块
    for (let k = 1; k < LOG; k++) {
      const mid = this.up[k - 1].get(id)
      if (mid < 0) break
      this.up[k].set(id, this.up[k - 1].get(mid))
    }
    return id
  }

  private lift(node: number, targetDepth: number): number {
    let d = this.depth.get(node) - targetDepth
    let n = node
    for (let k = 0; d > 0; k++, d >>= 1) {
      if (d & 1) n = this.up[k].get(n)
    }
    return n
  }

  private lca(a: number, b: number): number {
    const da = this.depth.get(a)
    const db = this.depth.get(b)
    let x = da > db ? this.lift(a, db) : a
    let y = db > da ? this.lift(b, da) : b
    if (x === y) return x
    for (let k = LOG - 1; k >= 0; k--) {
      const ux = this.up[k].get(x)
      const uy = this.up[k].get(y)
      if (ux !== uy) {
        x = ux
        y = uy
      }
    }
    return this.up[0].get(x)
  }

  /**
   * 比较两条根→节点坐标序列的字典序（pos 行优先，数值序即
   * (行号, 列号) 逐项序）。-1：x 更小；1：更大；0：同一节点。
   * 严格前缀按 +∞ 终结符约定判为“更大”。
   */
  compareSeq(x: number, y: number): number {
    if (x === y) return 0
    const w = this.lca(x, y)
    if (w === x) return 1
    if (w === y) return -1
    const wd = this.depth.get(w)
    const cx = this.pos.get(this.lift(x, wd + 1))
    const cy = this.pos.get(this.lift(y, wd + 1))
    return cx < cy ? -1 : cx > cy ? 1 : 0
  }

  /**
   * 比较“候选序列 seq(parent)+[npos]”与在位序列 seq(old)，
   * 不创建候选节点。
   */
  compareExtension(parentNode: number, npos: number, old: number): number {
    if (parentNode === old) {
      // P+[npos] 与 Q 完全同长同项（终点状态位置相同）
      return 0
    }
    const w = this.lca(parentNode, old)
    if (w === old) {
      // old 是 parent 的严格前缀（正费用下不会出现，理论上候选更优）
      return -1
    }
    if (w === parentNode) {
      // 共同前缀到 parent：先比较追加的第一项
      const wd = this.depth.get(parentNode)
      const childPos = this.pos.get(this.lift(old, wd + 1))
      if (npos !== childPos) return npos < childPos ? -1 : 1
      // 第一项相同：若 old 链更长，候选是其严格前缀 → 短者更大
      return this.depth.get(old) === wd + 1 ? 0 : 1
    }
    // 分叉位于两条前缀内部：追加终点不改变首个差异
    return this.compareSeq(parentNode, old)
  }
}

/** 最小二叉堆：A* 键 (f=g+h, sid)。 */
interface HeapEntry {
  sid: number
  time: number
  turns: number
  node: number
  f: number
}

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

  pop(): HeapEntry {
    const a = this.a
    const top = a[0]
    const last = a.pop()!
    if (a.length > 0) {
      a[0] = last
      let i = 0
      const n = a.length
      for (;;) {
        const l = 2 * i + 1
        const rr = l + 1
        let m = i
        if (l < n && this.less(a[l], a[m])) m = l
        if (rr < n && this.less(a[rr], a[m])) m = rr
        if (m === i) break
        ;[a[i], a[m]] = [a[m], a[i]]
        i = m
      }
    }
    return top
  }

  private less(x: HeapEntry, y: HeapEntry): boolean {
    if (x.f !== y.f) return x.f < y.f
    return x.sid < y.sid
  }
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
  const cellCount = cells.length
  const startPos = opt.startR * cols + opt.startC
  const goalPos = opt.goalR * cols + opt.goalC

  const reach = floodReachSet(grid, startPos)
  let blockedCount = 0
  for (const c of cells) if (c.kind === 'blocked') blockedCount++
  const fail = (): SolveResult => ({
    reachable: false,
    total: 0,
    turns: 0,
    steps: [],
    reachableCount: reach.count,
    reachSeen: reach.seen,
    blockedCount,
  })

  if (cells[startPos].kind === 'blocked' || cells[goalPos].kind === 'blocked') {
    return fail()
  }

  // 洪水连通与 Dijkstra 使用完全相同的边（正交非阻断 + 同组电梯）。
  // 终点不在可达集合内时，最短路不存在，无需再做状态空间搜索——
  // 这也避免了“终点隔离 + 多组电梯”时对全部掩码状态的无效展开。
  if (reach.seen[goalPos] === 0) {
    return fail()
  }

  // 同组电梯成员与等待秒数（一致性由校验层保证）。
  // 掩码只按“实际出现的组”分配位，避免无电梯时状态无谓膨胀。
  const members: number[][] = []
  const groupWait = new Int32Array(10)
  const groupLocal = new Int8Array(10).fill(-1)
  const presentGroups: number[] = []
  for (let p = 0; p < cellCount; p++) {
    const cell = cells[p]
    if (cell.kind === 'elevator') {
      ;(members[cell.group] ??= []).push(p)
      groupWait[cell.group] = cell.wait
      if (groupLocal[cell.group] < 0) {
        groupLocal[cell.group] = presentGroups.length
        presentGroups.push(cell.group)
      }
    }
  }
  const masks = 1 << presentGroups.length // 0 组时为 1

  /**
   * A* 可采纳启发值 h[pos]：在“只看位置”的松弛问题上（忽略朝向、
   * 转弯费与首次等待，正交边按目标格耗时、同组电梯 8）到终点的最短
   * 秒数。松弛问题的每条边费都不大于真实边费，故 h 是真实剩余费用
   * 的下界，且满足一致性（h 本身是最短路距离）。
   * 反向求解：从终点出发，松弛边 v→u 的权 = 正向 u→v 的目标格费
   * cost(v)；同组电梯成员之间权 8。
   */
  const h = new Float64Array(cellCount).fill(Infinity)
  {
    const pq: { p: number; d: number }[] = []
    const pushPq = (p: number, d: number): void => {
      pq.push({ p, d })
      let i = pq.length - 1
      while (i > 0 && pq[i].d < pq[(i - 1) >> 1].d) {
        const pi = (i - 1) >> 1
        ;[pq[i], pq[pi]] = [pq[pi], pq[i]]
        i = pi
      }
    }
    h[goalPos] = 0
    pushPq(goalPos, 0)
    while (pq.length > 0) {
      let top = 0
      const cur = pq[0]
      const last = pq.pop()!
      if (pq.length > 0) {
        pq[0] = last
        for (;;) {
          const l = 2 * top + 1
          const rr = l + 1
          let m = top
          if (l < pq.length && pq[l].d < pq[m].d) m = l
          if (rr < pq.length && pq[rr].d < pq[m].d) m = rr
          if (m === top) break
          ;[pq[m], pq[top]] = [pq[top], pq[m]]
          top = m
        }
      }
      if (cur.d !== h[cur.p]) continue
      const v = cur.p
      const vr = (v / cols) | 0
      const vc = v % cols
      const forwardDestCost = cells[v].kind === 'blocked' ? 0 : (cells[v] as { cost: number }).cost
      // 反向正交边：u→v 正向花费 cost(v)
      for (const [dr, dc] of DIR_DELTA) {
        const ur = vr + dr
        const uc = vc + dc
        if (ur < 0 || ur >= rows || uc < 0 || uc >= cols) continue
        const u = ur * cols + uc
        if (cells[u].kind === 'blocked') continue
        const nd = cur.d + forwardDestCost
        if (nd < h[u]) {
          h[u] = nd
          pushPq(u, nd)
        }
      }
      // 反向同组电梯：费用 8
      const vCell = cells[v]
      if (vCell.kind === 'elevator') {
        for (const u of members[vCell.group]) {
          if (u === v) continue
          const nd = cur.d + ELEVATOR_FARE
          if (nd < h[u]) {
            h[u] = nd
            pushPq(u, nd)
          }
        }
      }
    }
  }

  // sid = (pos*4 + dir)*masks + mask
  const stateCount = cellCount * 4 * masks
  const sidOf = (pos: number, dir: Dir, mask: number): number =>
    (pos * 4 + dir) * masks + mask

  const bestTime = new Int32Array(stateCount)
  const bestTurns = new Int32Array(stateCount)
  const bestNode = new Int32Array(stateCount)
  bestTime.fill(INF)
  bestTurns.fill(INF)
  bestNode.fill(-1)

  const tree = new NodeTree()
  const heap = new MinHeap()

  const startSid = sidOf(startPos, opt.startDir, 0)
  const startNode = tree.add(startPos, -1, VIA_WALK, 0, 0, 0, 0, 0)
  bestTime[startSid] = 0
  bestTurns[startSid] = 0
  bestNode[startSid] = startNode
  heap.push({ sid: startSid, time: 0, turns: 0, node: startNode, f: h[startPos] })

  const relax = (
    fromNode: number,
    fromTime: number,
    fromTurns: number,
    npos: number,
    ndir: Dir,
    nmask: number,
    edgeTime: number,
    edgeTurns: number,
    via: number,
    base: number,
    turn: number,
    fare: number,
    wait: number,
    group: number,
  ): void => {
    const nsid = sidOf(npos, ndir, nmask)
    const nt = fromTime + edgeTime
    const ntn = fromTurns + edgeTurns
    const oldNode = bestNode[nsid]

    let better: boolean
    if (oldNode < 0) {
      better = true
    } else if (nt !== bestTime[nsid]) {
      better = nt < bestTime[nsid]
    } else if (ntn !== bestTurns[nsid]) {
      better = ntn < bestTurns[nsid]
    } else {
      better = tree.compareExtension(fromNode, npos, oldNode) < 0
    }
    if (!better) return

    // 仅对被采纳的标签创建节点：不可变、永不被改写
    const node = tree.add(npos, fromNode, via, base, turn, fare, wait, group)
    bestTime[nsid] = nt
    bestTurns[nsid] = ntn
    bestNode[nsid] = node
    heap.push({ sid: nsid, time: nt, turns: ntn, node, f: nt + h[npos] })
  }

  let goalBestTime = INF
  let goalBestTurns = INF
  let goalBestNode = -1

  while (heap.size > 0) {
    const e = heap.pop()
    if (bestNode[e.sid] !== e.node) continue // 已被替换的过时堆条目

    // A* 终止：h 一致且非负。首个弹出的终点给出最短总秒数 G*；
    // 处理完所有 f == G* 的状态即可覆盖等秒数路线的转弯数与字典序
    // 裁决；f > G* 的状态到终点必超过 G*，无需再处理。
    if (goalBestNode >= 0 && e.f > goalBestTime) break

    const mask = e.sid % masks
    const q = (e.sid / masks) | 0
    const dir = (q % 4) as Dir
    const pos = (q / 4) | 0

    if (pos === goalPos) {
      let take = false
      if (goalBestNode < 0) take = true
      else if (e.time !== goalBestTime) take = e.time < goalBestTime
      else if (e.turns !== goalBestTurns) take = e.turns < goalBestTurns
      else take = tree.compareSeq(e.node, goalBestNode) < 0
      if (take) {
        goalBestTime = e.time
        goalBestTurns = e.turns
        goalBestNode = e.node
      }
      continue // 终点不再扩展（边费用为正）
    }

    const r = (pos / cols) | 0
    const c = pos % cols

    // 1) 四向正交移动
    for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
      const [dr, dc] = DIR_DELTA[d]
      const nr = r + dr
      const nc = c + dc
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue
      const np = nr * cols + nc
      const target = cells[np]
      if (target.kind === 'blocked') continue
      const turned = d !== dir
      relax(
        e.node, e.time, e.turns,
        np, d, mask,
        target.cost + (turned ? TURN_PENALTY : 0),
        turned ? 1 : 0,
        VIA_WALK, target.cost, turned ? TURN_PENALTY : 0, 0, 0, 0,
      )
    }

    // 2) 同组电梯换乘（朝向不变；首次乘用加收等待）
    const here = cells[pos]
    if (here.kind === 'elevator') {
      const g = here.group
      const bit = 1 << groupLocal[g]
      const first = (mask & bit) === 0
      const wait = first ? groupWait[g] : 0
      const nmask = mask | bit
      for (const np of members[g]) {
        if (np === pos) continue
        relax(
          e.node, e.time, e.turns,
          np, dir, nmask,
          ELEVATOR_FARE + wait, 0,
          VIA_RIDE, 0, 0, ELEVATOR_FARE + wait, wait, g,
        )
      }
    }
  }

  if (goalBestNode < 0) return fail()

  return {
    reachable: true,
    total: goalBestTime,
    turns: goalBestTurns,
    steps: buildSteps(tree, goalBestNode, grid, opt.startDir),
    reachableCount: reach.count,
    reachSeen: reach.seen,
    blockedCount,
  }
}

/** 沿不可变父节点链还原逐步费用明细与累计值。 */
function buildSteps(tree: NodeTree, goalNode: number, grid: Grid, startDir: Dir): RouteStep[] {
  const ids: number[] = []
  let n = goalNode
  while (n >= 0) {
    ids.push(n)
    n = tree.parent.get(n)
  }
  ids.reverse()

  const { cells, cols } = grid
  const out: RouteStep[] = []
  let total = 0
  let curDir: Dir = startDir
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    const pos = tree.pos.get(id)
    const r = (pos / cols) | 0
    const c = pos % cols
    if (i === 0) {
      out.push({
        r, c, dir: curDir,
        base: 0, turn: 0, fare: 0, wait: 0, stepCost: 0, total: 0,
        kind: 'start',
      })
      continue
    }
    const via = tree.via.get(id)
    if (via === VIA_WALK) {
      const prevPos = tree.pos.get(ids[i - 1])
      const dr = r - ((prevPos / cols) | 0)
      const dc = c - (prevPos % cols)
      curDir = DIR_DELTA.findIndex(([x, y]) => x === dr && y === dc) as Dir
    }
    // 乘梯不改变朝向：curDir 保持
    const base = tree.base.get(id)
    const turn = tree.turn.get(id)
    const fare = tree.fare.get(id)
    total += base + turn + fare
    const here = cells[pos]
    out.push({
      r,
      c,
      dir: curDir,
      base,
      turn,
      fare,
      wait: tree.wait.get(id),
      stepCost: base + turn + fare,
      total,
      kind: via === VIA_RIDE ? 'elevator' : 'walk',
      group: via === VIA_RIDE ? tree.group.get(id) : undefined,
      enteredGroup:
        via === VIA_WALK && here.kind === 'elevator'
          ? (here as ElevatorCell).group
          : undefined,
    })
  }
  return out
}

/**
 * 失败证据：在与求解器相同的连通关系（正交相邻 + 同组电梯）上，
 * 从起点做广度优先，返回可达的非阻断格位图与数量。阻断格与终点
 * 所在的另一片开放区域都不会计入“可达”，审核员可逐格着色核对：
 *   总格数 = 阻断格数 + 起点可达格数 + 其它开放片区格数。
 */
export function floodReachSet(
  grid: Grid,
  startPos: number,
): { seen: Uint8Array; count: number } {
  const { cols, cells } = grid
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

  const queue = new Int32Array(cells.length)
  let head = 0
  let tail = 0
  queue[tail++] = startPos
  seen[startPos] = 1
  let count = 0
  while (head < tail) {
    const p = queue[head++]
    count++
    const r = (p / cols) | 0
    const c = p % cols
    for (const [dr, dc] of DIR_DELTA) {
      const nr = r + dr
      const nc = c + dc
      if (nr < 0 || nr >= grid.rows || nc < 0 || nc >= cols) continue
      const np = nr * cols + nc
      if (!seen[np] && cells[np].kind !== 'blocked') {
        seen[np] = 1
        queue[tail++] = np
      }
    }
    const g = groupOf[p]
    if (g) {
      for (const np of members[g]) {
        if (!seen[np]) {
          seen[np] = 1
          queue[tail++] = np
        }
      }
    }
  }
  return { seen, count }
}

export function floodReach(grid: Grid, startPos: number): number {
  return floodReachSet(grid, startPos).count
}
