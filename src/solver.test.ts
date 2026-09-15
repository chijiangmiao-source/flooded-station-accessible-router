import { describe, expect, it } from 'vitest'
import { floodReach, floodReachSet, solve } from './solver'
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

/** 独立重放求解器给出的逐步路线，校验账目、朝向、电梯规则与推行累计。 */
function replay(
  g: Grid,
  startDir: Dir,
  result: ReturnType<typeof solve>,
  limit: number | null = null,
): void {
  const { cols, cells } = g
  expect(result.steps.length).toBeGreaterThan(0)
  const firstWaitUsed = new Set<number>()
  let total = 0
  let push = 0
  result.steps.forEach((s, i) => {
    total += s.stepCost
    expect(s.total).toBe(total)
    if (i === 0) {
      expect(s.kind).toBe('start')
      expect(s.stepCost).toBe(0)
      expect(s.dir).toBe(startDir)
      expect(s.push).toBe(0)
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
      // 推行账目：步行进入电梯格不计入；进入普通格累加基础耗时与转弯费
      if (target.kind !== 'elevator') push += s.base + s.turn
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
      // 乘梯到达后连续推行清零（8 秒换乘费与首次等待均不计入）
      push = 0
    }
    expect(s.push).toBe(push)
    if (limit !== null) expect(s.push).toBeLessThanOrEqual(limit)
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

/* ---------------- 连续推行上限：手算用例 ---------------- */

describe('连续推行上限（手算）', () => {
  it('直线走廊：上限恰好覆盖时成功，差 1 秒时失败并报最小超限', () => {
    const g = grid(1, 4, [normal(1), normal(1), normal(1), normal(1)])
    const ok = solve(g, { startR: 0, startC: 0, goalR: 0, goalC: 3, startDir: 1, pushLimit: 3 })
    expect(ok.reachable).toBe(true)
    expect(ok.total).toBe(3)
    expect(ok.pushLimit).toBe(3)
    expect(ok.minOver).toBe(0)
    expect(ok.steps.map((s) => s.push)).toEqual([0, 1, 2, 3])
    replay(g, 1, ok, 3)

    const no = solve(g, { startR: 0, startC: 0, goalR: 0, goalC: 3, startDir: 1, pushLimit: 2 })
    expect(no.reachable).toBe(false)
    expect(no.steps).toEqual([]) // 旧路线清除
    expect(no.pushLimit).toBe(2)
    expect(no.minOver).toBe(1) // 最后一步推行将达 3 秒，超 2 秒上限 1 秒
    expect(no.reachableCount).toBe(3) // 约束下到达 (0,0)(0,1)(0,2)
    expect([...no.reachSeen]).toEqual([1, 1, 1, 0])
  })

  it('转弯费计入连续推行耗时', () => {
    const g = grid(2, 2, [normal(1), normal(1), normal(1), normal(1)])
    const ok = solve(g, { startR: 1, startC: 0, goalR: 0, goalC: 1, startDir: 3, pushLimit: 12 })
    expect(ok.reachable).toBe(true)
    expect(ok.total).toBe(12)
    expect(ok.steps.map((s) => s.push)).toEqual([0, 6, 12]) // 每步 5 转弯 + 1 基础

    const no = solve(g, { startR: 1, startC: 0, goalR: 0, goalC: 1, startDir: 3, pushLimit: 11 })
    expect(no.reachable).toBe(false)
    expect(no.minOver).toBe(1)
    // (1,0) (0,0) (1,1) 可推行到达，(0,1) 需 12 秒推行而不可达
    expect(no.reachableCount).toBe(3)
    expect(no.reachSeen[0 * 2 + 1]).toBe(0)
    expect(no.reachSeen[1 * 2 + 1]).toBe(1)
  })

  it('步行进入电梯格不计入推行耗时', () => {
    // 1×2：直接进入电梯格，1 秒上限也不约束
    const g2 = grid(1, 2, [normal(1), elev(5, 1, 10)])
    const r2 = solve(g2, { startR: 0, startC: 0, goalR: 0, goalC: 1, startDir: 1, pushLimit: 1 })
    expect(r2.reachable).toBe(true)
    expect(r2.total).toBe(5)
    expect(r2.steps[1]).toMatchObject({ kind: 'walk', enteredGroup: 1, push: 0 })

    // 1×3：穿过电梯格，只有末段普通格计入推行
    const g3 = grid(1, 3, [normal(4), elev(3, 1, 10), normal(4)])
    const ok = solve(g3, { startR: 0, startC: 0, goalR: 0, goalC: 2, startDir: 1, pushLimit: 4 })
    expect(ok.reachable).toBe(true)
    expect(ok.total).toBe(7)
    expect(ok.steps.map((s) => s.push)).toEqual([0, 0, 4])

    const no = solve(g3, { startR: 0, startC: 0, goalR: 0, goalC: 2, startDir: 1, pushLimit: 3 })
    expect(no.reachable).toBe(false)
    expect(no.minOver).toBe(1)
  })

  it('同组电梯换乘到达后清零；8 秒换乘费与首次等待均不计入推行', () => {
    // 1×7：推行 2 秒到电梯 → 乘梯 18 秒 → 再推行两段各 2 秒
    const g = grid(1, 7, [
      normal(1), normal(2), elev(1, 1, 10), normal(50), elev(1, 1, 10), normal(2), normal(2),
    ])
    const ok = solve(g, { startR: 0, startC: 0, goalR: 0, goalC: 6, startDir: 1, pushLimit: 4 })
    expect(ok.reachable).toBe(true)
    expect(ok.total).toBe(25) // 2 + 1(入梯基础耗时) + (8+10) + 2 + 2
    // 乘梯步 push 归零（而非 +18），证明换乘费与首次等待不计入且到达后清零
    expect(ok.steps.map((s) => s.push)).toEqual([0, 2, 2, 0, 2, 4])
    expect(ok.steps[3]).toMatchObject({ kind: 'elevator', fare: 18, wait: 10, push: 0 })
    replay(g, 1, ok, 4)

    // 上限 3：若不清零，全程推行 2+2+2=6 必失败；清零后仅末段 4 秒超 1 秒
    const no = solve(g, { startR: 0, startC: 0, goalR: 0, goalC: 6, startDir: 1, pushLimit: 3 })
    expect(no.reachable).toBe(false)
    expect(no.minOver).toBe(1)
  })

  it('拓扑不可达且开启上限时，仍报告拓扑可达证据（与关闭限制一致）', () => {
    const g = grid(3, 1, [normal(1), blocked(), normal(1)])
    const r = solve(g, { startR: 0, startC: 0, goalR: 2, goalC: 0, startDir: 0, pushLimit: 10 })
    expect(r.reachable).toBe(false)
    expect(r.reachableCount).toBe(1) // 拓扑可达集，而非约束到达集
    expect(r.reachSeen[0]).toBe(1)
    expect(r.minOver).toBe(0)
    expect(r.pushLimit).toBe(10)
  })

  it('暴雨示例场景：上限 11 秒恰好通过 46 秒路线，10 秒失败并报最小超限', () => {
    // 5×6：第 4 列整列阻断，1 组电梯在 (1,1)/(1,4)（0 基），首次等待 10
    const cells: Cell[] = []
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 6; c++) {
        if (c === 3) cells.push(blocked())
        else if ((r === 1 && c === 1) || (r === 1 && c === 4)) cells.push(elev(3, 1, 10))
        else cells.push(normal(3))
      }
    }
    const g = grid(5, 6, cells)
    const o = { startR: 4, startC: 0, goalR: 0, goalC: 5, startDir: 0 as Dir }
    const ok = solve(g, { ...o, pushLimit: 11 })
    expect(ok.reachable).toBe(true)
    expect(ok.total).toBe(46)
    expect(ok.turns).toBe(2)
    // 推行累计：入梯不计、乘梯清零、末步转弯费一并计入
    expect(ok.steps.map((s) => s.push)).toEqual([0, 3, 6, 9, 9, 0, 3, 11])
    replay(g, 0, ok, 11)

    const no = solve(g, { ...o, pushLimit: 10 })
    expect(no.reachable).toBe(false)
    expect(no.minOver).toBe(1) // 末步推行将达 11 秒，超 10 秒上限 1 秒
  })
})

/* ---------------- 推行资源帕累托支配与乘梯清零 ---------------- */

describe('推行资源帕累托支配与乘梯清零', () => {
  // 2×4：上路经电梯格（耗时 50 秒但推行不计），下路纯步行（省时但推行累积高）。
  // 两路均未乘梯（已付费组同为 ∅），在终点形成竞争标签：
  //   上路 time 52 / push 2；下路 time 20 / push 20 —— 互不支配，前沿必须共存。
  const g = (): Grid =>
    grid(2, 4, [
      normal(1), elev(50, 1, 10), normal(1), normal(1),
      normal(1), normal(1), normal(1), normal(1),
    ])
  const opt = { startR: 0, startC: 0, goalR: 0, goalC: 3, startDir: 1 as Dir }

  it('上限 20：省时高推行路线可行，选 20 秒下路', () => {
    const r = solve(g(), { ...opt, pushLimit: 20 })
    expect(r.reachable).toBe(true)
    expect(r.total).toBe(20)
    expect(coords(r)).toEqual([
      [0, 0], [1, 0], [1, 1], [1, 2], [1, 3], [0, 3],
    ])
    replay(g(), 1, r, 20)
  })

  it('上限 10：高推行路线被拒，帕累托前沿中的 52 秒低推行路线仍可用', () => {
    const r = solve(g(), { ...opt, pushLimit: 10 })
    expect(r.reachable).toBe(true)
    expect(r.total).toBe(52)
    expect(coords(r)).toEqual([
      [0, 0], [0, 1], [0, 2], [0, 3],
    ])
    expect(r.steps.map((s) => s.push)).toEqual([0, 0, 1, 2]) // 步行入梯不计
    replay(g(), 1, r, 10)
  })

  it('上限 1：两条竞争路线都被拒，失败并报最小超限 1 秒', () => {
    const r = solve(g(), { ...opt, pushLimit: 1 })
    expect(r.reachable).toBe(false)
    expect(r.minOver).toBe(1)
    expect(r.reachableCount).toBe(3) // (0,0) (0,1) (0,2)
  })

  it('乘梯清零抹平到达电梯前的推行差异', () => {
    // 1×6：起点即电梯；步行推行峰 8，乘梯 13 秒但到达后重新从 0 累计
    const g6 = grid(1, 6, [
      elev(1, 1, 5), normal(1), normal(1), elev(1, 1, 5), normal(3), normal(3),
    ])
    const o6 = { startR: 0, startC: 0, goalR: 0, goalC: 5, startDir: 1 as Dir }
    const walkFirst = solve(g6, { ...o6, pushLimit: 8 })
    expect(walkFirst.reachable).toBe(true)
    expect(walkFirst.total).toBe(9) // 步行 1+1+1+3+3
    const rideOnly = solve(g6, { ...o6, pushLimit: 6 })
    expect(rideOnly.reachable).toBe(true)
    expect(rideOnly.total).toBe(19) // (8+5)+3+3；乘梯后推行从 0 重新累计
    expect(rideOnly.steps.map((s) => s.push)).toEqual([0, 0, 3, 6])
    replay(g6, 1, rideOnly, 6)
  })
})

/* ---------------- 关闭限制时行为完全一致 ---------------- */

describe('关闭限制与未启用完全一致', () => {
  it('pushLimit 缺省/null 结果一致；上限不约束时三级裁决一致', () => {
    const rand = rng(777)
    let checked = 0
    for (let t = 0; t < 40; t++) {
      // 4×4 小网格，含电梯与阻断；单格 ≤9 秒，推行峰值远小于 999
      const groupCount = 1 + Math.floor(rand() * 2)
      const waits = Array.from({ length: groupCount }, () => 1 + Math.floor(rand() * 9))
      const cells: Cell[] = []
      for (let i = 0; i < 16; i++) {
        const x = rand()
        if (x < 0.15) cells.push(blocked())
        else if (x < 0.3) cells.push(elev(1 + Math.floor(rand() * 9), 1 + Math.floor(rand() * groupCount), 0))
        else cells.push(normal(1 + Math.floor(rand() * 9)))
      }
      cells.forEach((cell) => {
        if (cell.kind === 'elevator') (cell as { wait: number }).wait = waits[cell.group - 1]
      })
      const g = grid(4, 4, cells)
      const open: number[] = []
      cells.forEach((cell, p) => cell.kind !== 'blocked' && open.push(p))
      if (open.length < 2) continue
      const a = open[Math.floor(rand() * open.length)]
      let b = open[Math.floor(rand() * open.length)]
      if (b === a) b = open[(open.indexOf(a) + 1) % open.length]
      const dir = Math.floor(rand() * 4) as Dir
      const o = {
        startR: (a / 4) | 0, startC: a % 4,
        goalR: (b / 4) | 0, goalC: b % 4,
        startDir: dir,
      }
      const base = solve(g, o) // 缺省（未启用）
      const nul = solve(g, { ...o, pushLimit: null })
      const big = solve(g, { ...o, pushLimit: 999 }) // 上限不约束
      expect(nul.reachable).toBe(base.reachable)
      expect(nul.total).toBe(base.total)
      expect(nul.turns).toBe(base.turns)
      expect(coords(nul)).toEqual(coords(base))
      expect(nul.pushLimit).toBeNull()
      expect(big.reachable).toBe(base.reachable)
      expect(big.total).toBe(base.total)
      expect(big.turns).toBe(base.turns)
      expect(coords(big)).toEqual(coords(base))
      if (base.reachable) checked++
    }
    expect(checked).toBeGreaterThan(10)
  })
})

/* ---------------- 推行上限：小网格穷举差分 ---------------- */

interface PushBest {
  time: number
  turns: number
  seq: number[] // pos 序列
}

/**
 * 独立 oracle：在 (位置, 朝向, 已付费组, 推行耗时) 状态图上做队列
 * Bellman-Ford，标签直接保存完整坐标序列，按 (总秒数, 转弯数, 序列)
 * 三级字典序松弛。与标签树 A* 的实现完全独立。
 */
function pushOracle(
  g: Grid,
  startR: number,
  startC: number,
  goalR: number,
  goalC: number,
  startDir: Dir,
  limit: number,
): { reachable: boolean; time: number; turns: number; seq: number[]; reachSeen: Uint8Array } {
  const { rows, cols, cells } = g
  const N = cells.length
  const startPos = startR * cols + startC
  const goalPos = goalR * cols + goalC
  const reachSeen = new Uint8Array(N)
  const none = { reachable: false, time: 0, turns: 0, seq: [] as number[], reachSeen }
  if (cells[startPos].kind === 'blocked' || cells[goalPos].kind === 'blocked') return none

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
  const groups = [...members.keys()].sort((a, b) => a - b)
  const groupIndex = new Map(groups.map((gg, i) => [gg, i]))
  const masks = 1 << groups.length
  const span = limit + 1
  const id = (pos: number, dir: number, paid: number, push: number): number =>
    ((pos * 4 + dir) * masks + paid) * span + push
  const total = N * 4 * masks * span

  const best: (PushBest | null)[] = new Array(total).fill(null)
  const inQ = new Uint8Array(total)
  const queue: number[] = []

  const lexLess = (a: number[], b: number[]): boolean => {
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) return a[i] < b[i]
    }
    return a.length > b.length // 前缀视为更大（+∞ 终结符），与求解器约定一致
  }
  const better = (cand: PushBest, old: PushBest | null): boolean =>
    old === null ||
    cand.time < old.time ||
    (cand.time === old.time && cand.turns < old.turns) ||
    (cand.time === old.time && cand.turns === old.turns && lexLess(cand.seq, old.seq))

  const s0 = id(startPos, startDir, 0, 0)
  best[s0] = { time: 0, turns: 0, seq: [startPos] }
  queue.push(s0)
  inQ[s0] = 1
  reachSeen[startPos] = 1

  while (queue.length > 0) {
    const u = queue.shift()!
    inQ[u] = 0
    let x = u
    const push = x % span
    x = (x / span) | 0
    const paid = x % masks
    x = (x / masks) | 0
    const dir = x % 4
    x = (x / 4) | 0
    const pos = x
    const ub = best[u]!
    const r = (pos / cols) | 0
    const c = pos % cols

    // 正交移动：目标格耗时与转弯费计入推行；步行入电梯格不计
    for (let d = 0; d < 4; d++) {
      const [dr, dc] = DIR_DELTA[d]
      const nr = r + dr
      const nc = c + dc
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue
      const np = nr * cols + nc
      const t = cells[np]
      if (t.kind === 'blocked') continue
      const turned = d !== dir
      const stepPush = t.kind === 'elevator' ? 0 : t.cost + (turned ? TURN_PENALTY : 0)
      const npush = push + stepPush
      if (npush > limit) continue // 超限动作不得采用
      const v = id(np, d, paid, npush)
      const cand: PushBest = {
        time: ub.time + t.cost + (turned ? TURN_PENALTY : 0),
        turns: ub.turns + (turned ? 1 : 0),
        seq: [...ub.seq, np],
      }
      if (better(cand, best[v])) {
        best[v] = cand
        reachSeen[np] = 1
        if (!inQ[v]) {
          queue.push(v)
          inQ[v] = 1
        }
      }
    }

    // 电梯换乘：8 秒与首次等待不计推行，到达后清零
    const here = cells[pos]
    if (here.kind === 'elevator') {
      const gi = groupIndex.get(here.group)!
      const bit = 1 << gi
      const first = (paid & bit) === 0
      const wait = first ? waitOf.get(here.group)! : 0
      for (const np of members.get(here.group)!) {
        if (np === pos) continue
        const v = id(np, dir, paid | bit, 0)
        const cand: PushBest = {
          time: ub.time + ELEVATOR_FARE + wait,
          turns: ub.turns,
          seq: [...ub.seq, np],
        }
        if (better(cand, best[v])) {
          best[v] = cand
          reachSeen[np] = 1
          if (!inQ[v]) {
            queue.push(v)
            inQ[v] = 1
          }
        }
      }
    }
  }

  let win: PushBest | null = null
  for (let d = 0; d < 4; d++) {
    for (let paid = 0; paid < masks; paid++) {
      for (let push = 0; push <= limit; push++) {
        const b = best[id(goalPos, d, paid, push)]
        if (b && better(b, win)) win = b
      }
    }
  }
  if (!win) return none
  return { reachable: true, time: win.time, turns: win.turns, seq: win.seq, reachSeen }
}

describe('推行上限小网格穷举差分', () => {
  const cases: Array<{
    g: Grid
    sr: number
    sc: number
    gr: number
    gc: number
    dir: Dir
    limit: number
  }> = []
  const rand = rng(20260917)
  for (let t = 0; t < 150; t++) {
    const rows = 2 + Math.floor(rand() * 3) // 2..4
    const cols = 2 + Math.floor(rand() * 3)
    const groupCount = 1 + Math.floor(rand() * 2)
    const waits = Array.from({ length: groupCount }, () => 1 + Math.floor(rand() * 9))
    const cells: Cell[] = []
    for (let i = 0; i < rows * cols; i++) {
      const x = rand()
      if (x < 0.15) cells.push(blocked())
      else if (x < 0.32) {
        cells.push(elev(1 + Math.floor(rand() * 9), 1 + Math.floor(rand() * groupCount), 0))
      } else cells.push(normal(1 + Math.floor(rand() * 9)))
    }
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
      limit: 1 + Math.floor(rand() * 25), // 1..25 秒上限
    })
  }

  it('随机小网格 × 随机上限：可达性、三级裁决与约束到达集和穷举一致', () => {
    expect(cases.length).toBeGreaterThan(120)
    let okCount = 0
    let failCount = 0
    let staminaFail = 0
    for (const c of cases) {
      const r = solve(c.g, {
        startR: c.sr,
        startC: c.sc,
        goalR: c.gr,
        goalC: c.gc,
        startDir: c.dir,
        pushLimit: c.limit,
      })
      const o = pushOracle(c.g, c.sr, c.sc, c.gr, c.gc, c.dir, c.limit)
      expect(r.reachable).toBe(o.reachable)
      if (r.reachable) {
        okCount++
        expect(r.total).toBe(o.time)
        expect(r.turns).toBe(o.turns)
        expect(coords(r)).toEqual(o.seq.map((p) => [(p / c.g.cols) | 0, p % c.g.cols]))
        expect(r.pushLimit).toBe(c.limit)
        replay(c.g, c.dir, r, c.limit)
      } else {
        failCount++
        expect(r.steps).toEqual([])
        expect(r.pushLimit).toBe(c.limit)
        const goalPos = c.gr * c.g.cols + c.gc
        const topo = floodReachSet(c.g, c.sr * c.g.cols + c.sc)
        if (topo.seen[goalPos] === 0) {
          // 拓扑不可达：证据为拓扑可达集，无超限统计
          expect(r.minOver).toBe(0)
          expect(r.reachableCount).toBe(topo.count)
          expect([...r.reachSeen]).toEqual([...topo.seen])
        } else {
          // 拓扑可达但受限失败：证据为约束下到达集，与穷举逐格一致
          staminaFail++
          expect(r.minOver).toBeGreaterThan(0)
          let oc = 0
          for (let i = 0; i < c.g.cells.length; i++) {
            expect(r.reachSeen[i]).toBe(o.reachSeen[i])
            oc += o.reachSeen[i]
          }
          expect(r.reachableCount).toBe(oc)
        }
      }
    }
    // 三类情形都要充分出现
    expect(okCount).toBeGreaterThan(20)
    expect(failCount).toBeGreaterThan(20)
    expect(staminaFail).toBeGreaterThan(10)
  })
})
