import { describe, expect, it } from 'vitest'
import { floodReach, solve } from './solver'
import {
  Cell,
  Dir,
  DIR_DELTA,
  ELEVATOR_FARE,
  Grid,
  TURN_PENALTY,
} from './types'

/* ---------- 造格工具 ---------- */

function blocked(): Cell {
  return { kind: 'blocked' }
}
function normal(cost: number): Cell {
  return { kind: 'normal', cost }
}
function elev(cost: number, group: number, wait: number): Cell {
  return { kind: 'elevator', cost, group, wait }
}

function grid(rows: number, cols: number, cells: Cell[]): Grid {
  if (cells.length !== rows * cols) throw new Error('bad fixture')
  return { rows, cols, cells }
}

function coords(result: ReturnType<typeof solve>): Array<[number, number]> {
  return result.steps.map((s) => [s.r, s.c])
}

/* ---------- 独立 oracle：在同一状态图上做 SPFA（队列 Bellman-Ford），
   仅比较 (总秒数, 转弯数)，实现与二叉堆 Dijkstra 完全独立。 ---------- */

function spfaOracle(
  g: Grid,
  startR: number,
  startC: number,
  goalR: number,
  goalC: number,
  startDir: Dir,
): { time: number; turns: number; reachable: boolean } {
  const { rows, cols, cells } = g
  const N = cells.length
  const startPos = startR * cols + startC
  const goalPos = goalR * cols + goalC
  if (cells[startPos].kind === 'blocked' || cells[goalPos].kind === 'blocked') {
    return { time: 0, turns: 0, reachable: false }
  }

  const members = new Map<number, number[]>()
  const waitOf = new Map<number, number>()
  cells.forEach((cell, p) => {
    if (cell.kind === 'elevator') {
      if (!members.has(cell.group)) {
        members.set(cell.group, [])
        waitOf.set(cell.group, cell.wait)
      }
      members.get(cell.group)!.push(p)
    }
  })

  // 仅枚举出现过的组，压缩 paid 掩码
  const groups = [...members.keys()].sort((a, b) => a - b)
  const groupIndex = new Map(groups.map((gg, i) => [gg, i]))
  const masks = 1 << groups.length
  const id = (pos: number, dir: number, paid: number) =>
    ((pos * 4 + dir) * masks + paid)
  const total = N * 4 * masks

  const dist = new Int32Array(total).fill(-1)
  const turn = new Int32Array(total).fill(-1)
  const inQ = new Uint8Array(total)
  const queue: number[] = []

  const s0 = id(startPos, startDir, 0)
  dist[s0] = 0
  turn[s0] = 0
  queue.push(s0)
  inQ[s0] = 1

  const relax = (u: number, v: number, t: number, tn: number): void => {
    const better =
      dist[v] < 0 ||
      dist[u] + t < dist[v] ||
      (dist[u] + t === dist[v] && turn[u] + tn < turn[v])
    if (better) {
      dist[v] = dist[u] + t
      turn[v] = turn[u] + tn
      if (!inQ[v]) {
        queue.push(v)
        inQ[v] = 1
      }
    }
  }

  while (queue.length > 0) {
    const u = queue.shift()!
    inQ[u] = 0
    let x = u
    const paid = x % masks
    x = (x / masks) | 0
    const dir = x % 4
    x = (x / 4) | 0
    const pos = x
    const r = (pos / cols) | 0
    const c = pos % cols

    for (let d = 0; d < 4; d++) {
      const [dr, dc] = DIR_DELTA[d]
      const nr = r + dr
      const nc = c + dc
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue
      const np = nr * cols + nc
      const t = cells[np]
      if (t.kind === 'blocked') continue
      const v = id(np, d, paid)
      relax(u, v, t.cost + (d === dir ? 0 : TURN_PENALTY), d === dir ? 0 : 1)
    }

    const here = cells[pos]
    if (here.kind === 'elevator') {
      const gi = groupIndex.get(here.group)!
      const bit = 1 << gi
      const first = (paid & bit) === 0
      const wait = first ? waitOf.get(here.group)! : 0
      for (const np of members.get(here.group)!) {
        if (np === pos) continue
        const v = id(np, dir, paid | bit)
        relax(u, v, ELEVATOR_FARE + wait, 0)
      }
    }
  }

  let bestTime = -1
  let bestTurn = -1
  for (let d = 0; d < 4; d++) {
    for (let paid = 0; paid < masks; paid++) {
      const v = id(goalPos, d, paid)
      if (dist[v] < 0) continue
      if (
        bestTime < 0 ||
        dist[v] < bestTime ||
        (dist[v] === bestTime && turn[v] < bestTurn)
      ) {
        bestTime = dist[v]
        bestTurn = turn[v]
      }
    }
  }
  if (bestTime < 0) return { time: 0, turns: 0, reachable: false }
  return { time: bestTime, turns: bestTurn, reachable: true }
}

/** 独立重放求解器给出的逐步路线，校验账目、朝向与电梯规则。 */
function replay(g: Grid, startDir: Dir, result: ReturnType<typeof solve>): void {
  const { cols, cells } = g
  expect(result.steps.length).toBeGreaterThan(0)
  const firstWaitUsed = new Set<number>()
  let total = 0
  result.steps.forEach((s, i) => {
    total += s.stepCost
    expect(s.total).toBe(total)
    if (i === 0) {
      expect(s.kind).toBe('start')
      expect(s.stepCost).toBe(0)
      expect(s.dir).toBe(startDir)
      return
    }
    const prev = result.steps[i - 1]
    const dr = s.r - prev.r
    const dc = s.c - prev.c
    const target = cells[s.r * cols + s.c]

    if (s.kind === 'walk') {
      // 必须正交相邻
      expect(Math.abs(dr) + Math.abs(dc)).toBe(1)
      const movedDir = DIR_DELTA.findIndex(([x, y]) => x === dr && y === dc) as Dir
      expect(s.dir).toBe(movedDir)
      expect(s.base).toBe(target.kind === 'blocked' ? -1 : (target as { cost: number }).cost)
      expect(target.kind).not.toBe('blocked')
      const turned = movedDir !== prev.dir
      expect(s.turn).toBe(turned ? TURN_PENALTY : 0)
      expect(s.fare).toBe(0)
      expect(s.wait).toBe(0)
    } else {
      // 电梯换乘：两端同组、朝向不变、固定 8 秒
      expect(s.kind).toBe('elevator')
      expect(dr === 0 && dc === 0).toBe(false) // 必须是不同电梯
      const from = cells[prev.r * cols + prev.c]
      expect(from.kind).toBe('elevator')
      expect(target.kind).toBe('elevator')
      expect((from as { group: number }).group).toBe((target as { group: number }).group)
      expect(s.group).toBe((target as { group: number }).group)
      expect(s.dir).toBe(prev.dir)
      expect(s.base).toBe(0)
      expect(s.turn).toBe(0)
      expect(s.fare).toBe(ELEVATOR_FARE + s.wait)
      if (s.wait > 0) {
        expect(firstWaitUsed.has(s.group!)).toBe(false)
        firstWaitUsed.add(s.group!)
        expect(s.wait).toBe((target as { wait: number }).wait)
      }
    }
  })
  expect(result.total).toBe(total)
  let turns = 0
  for (let i = 1; i < result.steps.length; i++) {
    if (result.steps[i].dir !== result.steps[i - 1].dir) turns++
  }
  expect(result.turns).toBe(turns)
}

/* ---------------- 手算用例 ---------------- */

describe('基础计费', () => {
  it('相邻正交移动按目标格耗时计费，初始朝向与首步行走方向一致时无转弯费', () => {
    // 1×3：[start 2][2][7]，朝东
    const g = grid(1, 3, [normal(2), normal(2), normal(7)])
    const r = solve(g, { startR: 0, startC: 0, goalR: 0, goalC: 2, startDir: 1 })
    expect(r.reachable).toBe(true)
    expect(r.total).toBe(9) // 2+7
    expect(r.turns).toBe(0)
    expect(coords(r)).toEqual([[0, 0], [0, 1], [0, 2]])
    expect(r.steps[1].base).toBe(2)
    expect(r.steps[2].base).toBe(7)
  })

  it('初始朝向与首步方向相反时加一次 5 秒转弯费', () => {
    const g = grid(1, 3, [normal(2), normal(2), normal(7)])
    const r = solve(g, { startR: 0, startC: 0, goalR: 0, goalC: 2, startDir: 3 }) // 朝西
    expect(r.total).toBe(14) // 5+2+7
    expect(r.turns).toBe(1)
  })

  it('连续变向逐次计费', () => {
    // 2×2 全 1 秒，起点左下朝西，先北后东：两次转弯 + 两步基础
    const g = grid(2, 2, [normal(1), normal(1), normal(1), normal(1)])
    const r = solve(g, { startR: 1, startC: 0, goalR: 0, goalC: 1, startDir: 3 })
    expect(r.total).toBe(12) // 5+1 + 5+1
    expect(r.turns).toBe(2)
  })
})

describe('坐标序列字典序', () => {
  it('总秒数与转弯数完全相同时，取逐项 (行,列) 更小者：先北后东', () => {
    // 2×2，左下→右上，朝西：两条路线均为 12 秒、2 转弯
    const g = grid(2, 2, [normal(1), normal(1), normal(1), normal(1)])
    const r = solve(g, { startR: 1, startC: 0, goalR: 0, goalC: 1, startDir: 3 })
    expect(coords(r)).toEqual([[1, 0], [0, 0], [0, 1]])
  })

  it('3×3 等耗时网格中，同级路线按行优先贴边走', () => {
    const g = grid(
      3,
      3,
      Array.from({ length: 9 }, () => normal(1)),
    )
    const r = solve(g, { startR: 2, startC: 0, goalR: 0, goalC: 2, startDir: 3 }) // 朝西
    // 先北上到第 1 行再东行，坐标序列最小
    expect(coords(r)).toEqual([
      [2, 0],
      [1, 0],
      [0, 0],
      [0, 1],
      [0, 2],
    ])
  })
})

describe('电梯规则', () => {
  it('同组任意两部电梯间固定 8 秒：可从最近成员直达最远成员，首次等待只计一次', () => {
    // 1×5：E1 . E1 . E1（E 基础 1 秒、等待 10；普通格 50 秒）
    // 起点就在电梯上，可一步直达任意另一部成员，直达最远 (0,4) 最优。
    const g = grid(
      1,
      5,
      [elev(1, 1, 10), normal(50), elev(1, 1, 10), normal(50), elev(1, 1, 10)],
    )
    const r = solve(g, { startR: 0, startC: 0, goalR: 0, goalC: 4, startDir: 1 })
    expect(r.reachable).toBe(true)
    // (0,0) 梯→(0,4)：8+10，一步直达，等待只此一次
    expect(r.total).toBe(18)
    expect(r.turns).toBe(0)
    expect(coords(r)).toEqual([[0, 0], [0, 4]])
    expect(r.steps[1]).toMatchObject({ kind: 'elevator', fare: 18, wait: 10, group: 1 })
    expect(r.steps[1].dir).toBe(1) // 换乘后朝向保持东
  })

  it('步行进入电梯格只收基础耗时、不触发等待；随后首次乘用才收 8+等待', () => {
    // 1×5：普通1 → E1(基础3,等待10) → 普通50 → 普通50 → E1
    const g = grid(
      1,
      5,
      [normal(1), elev(3, 1, 10), normal(50), normal(50), elev(3, 1, 10)],
    )
    const r = solve(g, { startR: 0, startC: 0, goalR: 0, goalC: 4, startDir: 1 })
    // 步行入梯 3；首乘 8+10=18 → 合计 21；全程步行需 1+3+50+50+3
    expect(r.total).toBe(21)
    expect(r.turns).toBe(0)
    expect(coords(r)).toEqual([[0, 0], [0, 1], [0, 4]])
    expect(r.steps[1]).toMatchObject({ kind: 'walk', base: 3, turn: 0, fare: 0, enteredGroup: 1 })
    expect(r.steps[2]).toMatchObject({ kind: 'elevator', base: 0, fare: 18, wait: 10, group: 1 })
  })

  it('电梯换乘后朝向不变，随后正交步行按原朝向判定转弯', () => {
    // 3×2：(0,0) 与 (2,0) 为 1 组电梯（等待 3），(1,0) 通行 99，其余 7
    // 朝南起：乘梯 (0,0)→(2,0) 为 11；向东到 (2,1) 基础 7 + 转弯 5 = 23
    const g = grid(3, 2, [
      elev(1, 1, 3), normal(7),
      normal(99), normal(7),
      elev(1, 1, 3), normal(7),
    ])
    const r = solve(g, { startR: 0, startC: 0, goalR: 2, goalC: 1, startDir: 2 })
    expect(r.reachable).toBe(true)
    expect(r.total).toBe(23)
    expect(r.turns).toBe(1)
    expect(coords(r)).toEqual([[0, 0], [2, 0], [2, 1]])
    expect(r.steps[1]).toMatchObject({ kind: 'elevator', dir: 2, fare: 11, wait: 3 })
    expect(r.steps[2]).toMatchObject({ kind: 'walk', base: 7, turn: 5, fare: 0 })
  })

  it('走入电梯格按其基础耗时步行计费，且不触发等待；之后乘用才收等待', () => {
    // 1×3：普通 4 → 电梯(基础3,等待10) → 普通 4；起点在普通格
    const g = grid(1, 3, [normal(4), elev(3, 1, 10), normal(4)])
    const r = solve(g, { startR: 0, startC: 0, goalR: 0, goalC: 2, startDir: 1 })
    expect(r.total).toBe(7) // 4+3，电梯组只有一部，无换乘可言
    expect(r.steps[1]).toMatchObject({ kind: 'walk', base: 3, enteredGroup: 1 })
    expect(r.steps[1].fare).toBe(0)
  })

  it('两个电梯组的首次等待分别各计一次', () => {
    // 1×9：E1(0) . . . E1(4)=E2? 不行——布成：
    // 列0 E1，列4 E1；列5 E2，列8 E2；中间普通格 99；电梯基础 1
    const cells: Cell[] = []
    for (let c = 0; c < 9; c++) {
      if (c === 0 || c === 4) cells.push(elev(1, 1, 6))
      else if (c === 5 || c === 8) cells.push(elev(1, 2, 7))
      else cells.push(normal(99))
    }
    const g = grid(1, 9, cells)
    const r = solve(g, { startR: 0, startC: 0, goalR: 0, goalC: 8, startDir: 1 })
    // 梯 0→4：8+6=14；步行进入列5：基础1；梯 5→8：8+7=15
    expect(r.total).toBe(30)
    expect(r.turns).toBe(0)
    expect(coords(r)).toEqual([[0, 0], [0, 4], [0, 5], [0, 8]])
    const paid = new Set<number>()
    for (const s of r.steps) if (s.kind === 'elevator') paid.add(s.group!)
    expect([...paid].sort()).toEqual([1, 2])
  })

  it('暴雨封闭后最近的无障碍通道不可用，必须改走电梯组', () => {
    // 2×3：中间列整列阻断；电梯 E1 在 (0,0) 与 (0,2)
    const g = grid(2, 3, [
      elev(2, 1, 4), blocked(), elev(2, 1, 4),
      normal(3), blocked(), normal(3),
    ])
    const r = solve(g, { startR: 1, startC: 0, goalR: 1, goalC: 2, startDir: 0 })
    expect(r.reachable).toBe(true)
    // 北上 (0,0)：2（初始即朝北，无转弯）；乘梯：8+4；南下 (1,2)：3 + 转弯5 = 22
    expect(r.total).toBe(22)
    expect(r.turns).toBe(1)
  })
})

describe('不可达与失败证据', () => {
  it('封闭后不可达：旧路线不返回，reachable=false', () => {
    // 3×1：中间阻断，上下分隔
    const g = grid(3, 1, [normal(1), blocked(), normal(1)])
    const r = solve(g, { startR: 0, startC: 0, goalR: 2, goalC: 0, startDir: 0 })
    expect(r.reachable).toBe(false)
    expect(r.steps).toEqual([])
    expect(r.total).toBe(0)
  })

  it('可达格数按正交连通统计：顶行 3 格', () => {
    // 3×3，中间整行阻断
    const g = grid(
      3,
      3,
      [
        normal(1), normal(1), normal(1),
        blocked(), blocked(), blocked(),
        normal(1), normal(1), normal(1),
      ],
    )
    const r = solve(g, { startR: 0, startC: 0, goalR: 2, goalC: 2, startDir: 0 })
    expect(r.reachable).toBe(false)
    expect(r.reachableCount).toBe(3)
    expect(floodReach(g, 2 * 3 + 2)).toBe(3)
    expect(r.reachSeen[2 * 3 + 2]).toBe(0)
  })

  it('失败证据区分三类：真正阻断格、起点可达开放格、另一片开放格', () => {
    // 3×3：中间一竖列 3 格淹水，把站厅分成左右各 3 格的两片开放区。
    // 起点在左片，终点在右片。阻断必须只数 3，不能把右片开放格算成淹水。
    const g = grid(
      3,
      3,
      [
        normal(1), blocked(), normal(1),
        normal(1), blocked(), normal(1),
        normal(1), blocked(), normal(1),
      ],
    )
    const r = solve(g, { startR: 1, startC: 0, goalR: 1, goalC: 2, startDir: 0 })
    expect(r.reachable).toBe(false)
    expect(r.blockedCount).toBe(3)
    expect(r.reachableCount).toBe(3) // 左片
    expect(g.cells.length - r.blockedCount - r.reachableCount).toBe(3) // 右片开放格
    expect(r.reachSeen[1 * 3 + 0]).toBe(1) // 起点可达
    expect(r.reachSeen[1 * 3 + 1]).toBe(0) // 阻断
    expect(r.reachSeen[1 * 3 + 2]).toBe(0) // 另一片开放格，不计入可达
  })

  it('同组电梯使被淹水隔开的格在连通统计中仍可达', () => {
    // 3×1：中间阻断，但首尾有同组电梯
    const g = grid(3, 1, [elev(1, 1, 5), blocked(), elev(1, 1, 5)])
    expect(floodReach(g, 0)).toBe(2)
    const r = solve(g, { startR: 0, startC: 0, goalR: 2, goalC: 0, startDir: 0 })
    expect(r.reachable).toBe(true)
    expect(r.total).toBe(13) // 8+5
  })
})

/* ---------------- 随机差分：求解器 vs 独立 SPFA ---------------- */

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

describe('随机差分（Dijkstra 对 SPFA oracle，并逐步重放账目）', () => {
  const cases: Array<{ g: Grid; sr: number; sc: number; gr: number; gc: number; dir: Dir }> = []
  const rand = rng(20260915)
  for (let t = 0; t < 250; t++) {
    const rows = 1 + Math.floor(rand() * 8) // 1..8
    const cols = 1 + Math.floor(rand() * 8)
    const groupCount = 1 + Math.floor(rand() * 3)
    const waits = Array.from({ length: groupCount }, () => 1 + Math.floor(rand() * 99))
    const cells: Cell[] = []
    for (let i = 0; i < rows * cols; i++) {
      const x = rand()
      if (x < 0.16) cells.push(blocked())
      else if (x < 0.34) {
        cells.push(elev(1 + Math.floor(rand() * 99), 1 + Math.floor(rand() * groupCount), 0))
      } else cells.push(normal(1 + Math.floor(rand() * 99)))
    }
    // 写入同组一致等待
    cells.forEach((cell) => {
      if (cell.kind === 'elevator') (cell as { wait: number }).wait = waits[cell.group - 1]
    })
    const g = grid(rows, cols, cells)
    const open: number[] = []
    cells.forEach((cell, p) => cell.kind !== 'blocked' && open.push(p))
    if (open.length < 2) continue
    const a = open[Math.floor(rand() * open.length)]
    let b = open[Math.floor(rand() * open.length)]
    if (b === a) b = open[(open.indexOf(a) + 1) % open.length]
    cases.push({
      g,
      sr: (a / cols) | 0,
      sc: a % cols,
      gr: (b / cols) | 0,
      gc: b % cols,
      dir: Math.floor(rand() * 4) as Dir,
    })
  }

  it('250 个随机网格：总秒数、转弯数、可达性与逐步账目中至少一项断言全覆盖', () => {
    expect(cases.length).toBeGreaterThan(200)
    let reachable = 0
    for (const c of cases) {
      const r = solve(c.g, {
        startR: c.sr,
        startC: c.sc,
        goalR: c.gr,
        goalC: c.gc,
        startDir: c.dir,
      })
      const o = spfaOracle(c.g, c.sr, c.sc, c.gr, c.gc, c.dir)
      expect(r.reachable).toBe(o.reachable)
      if (r.reachable) {
        reachable++
        expect(r.total).toBe(o.time)
        expect(r.turns).toBe(o.turns)
        replay(c.g, c.dir, r)
        // 起点终点坐标
        expect([r.steps[0].r, r.steps[0].c]).toEqual([c.sr, c.sc])
        const last = r.steps[r.steps.length - 1]
        expect([last.r, last.c]).toEqual([c.gr, c.gc])
      } else {
        expect(r.reachableCount).toBeGreaterThan(0)
        expect(r.reachableCount).toBeLessThanOrEqual(c.g.cells.length)
        expect(r.reachSeen[c.sr * c.g.cols + c.sc]).toBe(1)
        expect(r.reachSeen[c.gr * c.g.cols + c.gc]).toBe(0)
      }
    }
    // 保证差分样本里两类情形都出现过
    expect(reachable).toBeGreaterThan(100)
  })

  it('20×20 满网格规模上限可瞬时求解', () => {
    const cells: Cell[] = []
    for (let i = 0; i < 400; i++) {
      cells.push(normal(1 + (i % 99)))
    }
    const g = grid(20, 20, cells)
    const t0 = Date.now()
    const r = solve(g, { startR: 0, startC: 0, goalR: 19, goalC: 19, startDir: 2 })
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(r.reachable).toBe(true)
    expect(r.reachableCount).toBe(400)
  })
})

/* ---------------- 第三级字典序穷举 oracle（无电梯小网格） ---------------- */

describe('坐标序列字典序穷举交叉验证', () => {
  function bruteLex(
    g: Grid,
    sr: number, sc: number,
    gr: number, gc: number,
    sdir: Dir,
  ): Array<[number, number]> | null {
    const { rows, cols, cells } = g
    const startPos = sr * cols + sc
    const goalPos = gr * cols + gc
    let best: { time: number; turns: number; seq: Array<[number, number]> } | null = null
    const seq: Array<[number, number]> = [[sr, sc]]
    const seen = new Uint8Array(cells.length)
    seen[startPos] = 1

    const lexLess = (a: Array<[number, number]>, b: Array<[number, number]>): boolean => {
      const n = Math.min(a.length, b.length)
      for (let i = 0; i < n; i++) {
        if (a[i][0] !== b[i][0]) return a[i][0] < b[i][0]
        if (a[i][1] !== b[i][1]) return a[i][1] < b[i][1]
      }
      return a.length < b.length ? false : a.length > b.length // 前缀视为更大（+∞ 终结符）
    }

    const dfs = (pos: number, dir: Dir, time: number, turns: number): void => {
      if (pos === goalPos) {
        if (
          !best ||
          time < best.time ||
          (time === best.time && turns < best.turns) ||
          (time === best.time && turns === best.turns && lexLess(seq, best.seq))
        ) {
          best = { time, turns, seq: seq.map((p) => [p[0], p[1]] as [number, number]) }
        }
        return
      }
      const r = (pos / cols) | 0
      const c = pos % cols
      for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
        const [dr, dc] = DIR_DELTA[d]
        const nr = r + dr
        const nc = c + dc
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue
        const np = nr * cols + nc
        const t = cells[np]
        if (t.kind === 'blocked' || seen[np]) continue
        seen[np] = 1
        seq.push([nr, nc])
        dfs(np, d, time + t.cost + (d === dir ? 0 : TURN_PENALTY), turns + (d === dir ? 0 : 1))
        seq.pop()
        seen[np] = 0
      }
    }
    dfs(startPos, sdir, 0, 0)
    const winner = best as { time: number; turns: number; seq: Array<[number, number]> } | null
    return winner ? winner.seq : null
  }

  it('30 个随机 3×3 无电梯网格 × 多组起终点朝向：路线与穷举最优完全一致', () => {
    const rand = rng(424242)
    let checked = 0
    for (let t = 0; t < 30; t++) {
      const rows = 3
      const cols = 3
      const cells: Cell[] = Array.from({ length: 9 }, () =>
        rand() < 0.2 ? blocked() : normal(1 + Math.floor(rand() * 9)),
      )
      const g = grid(rows, cols, cells)
      const open = cells.map((c, p) => (c.kind === 'blocked' ? -1 : p)).filter((p) => p >= 0)
      if (open.length < 4) continue
      for (const [a, b] of [
        [open[0], open[open.length - 1]],
        [open[Math.floor(open.length / 2)], open[1 % open.length]],
      ] as Array<[number, number]>) {
        if (a === b) continue
        const sdir = (t % 4) as Dir
        const r = solve(g, {
          startR: (a / cols) | 0, startC: a % cols,
          goalR: (b / cols) | 0, goalC: b % cols,
          startDir: sdir,
        })
        const oracle = bruteLex(
          g,
          (a / cols) | 0, a % cols,
          (b / cols) | 0, b % cols,
          sdir,
        )
        if (oracle === null) {
          expect(r.reachable).toBe(false)
        } else {
          expect(r.reachable).toBe(true)
          expect(coords(r)).toEqual(oracle)
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(20)
  })
})
