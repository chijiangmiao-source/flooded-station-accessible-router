import { useMemo, useState } from 'react'
import { Board } from './components/Board'
import { CellEditor, DirPicker } from './components/CellEditor'
import { RoutePanel } from './components/RoutePanel'
import { floodScenario, plainScenario, Scenario } from './presets'
import { useSolver } from './useSolver'
import {
  FieldError,
  MAX_COST,
  MAX_DIM,
  MAX_PUSH_LIMIT,
  MIN_DIM,
  MIN_PUSH_LIMIT,
  RawCell,
  RawDoc,
  checkEndpoints,
  defaultCell,
  parsePushLimit,
  validateDoc,
} from './validation'
import { Dir } from './types'

type PickMode = 'start' | 'goal' | null

interface Endpoints {
  start: { r: number; c: number } | null
  goal: { r: number; c: number } | null
  dir: Dir
}

export default function App() {
  const initial = useMemo(() => floodScenario(), [])
  const [doc, setDoc] = useState<RawDoc>(initial.doc)
  const [endpoints, setEndpoints] = useState<Endpoints>({
    start: initial.start,
    goal: initial.goal,
    dir: initial.dir,
  })
  const [selected, setSelected] = useState<number | null>(null)
  const [pickMode, setPickMode] = useState<PickMode>(null)
  // 连续推行上限：手动轮椅乘客的耐力约束；关闭时不限制
  const [pushLimitEnabled, setPushLimitEnabled] = useState(false)
  const [pushLimitRaw, setPushLimitRaw] = useState('60')
  // 求解在 Web Worker 中进行；任何编辑调用 clear() 让旧路线立即消失
  const { busy, result, run, clear } = useSolver()

  const validated = useMemo(() => validateDoc(doc), [doc])

  /** 任何会改变问题的编辑都必须让旧路线立即消失（并作废迟到的 Worker 结果）。 */
  const invalidate = (): void => clear()

  // 上限输入非法（开启但非 1–999 整数）时禁止求解
  const pushLimit = pushLimitEnabled ? parsePushLimit(pushLimitRaw) : null
  const pushLimitInvalid = pushLimitEnabled && pushLimit === null

  const badFields = useMemo(() => {
    const m = new Map<number, Set<string>>()
    for (const e of validated.errors) {
      if (e.pos < 0) continue
      const s = m.get(e.pos) ?? new Set<string>()
      s.add(e.field)
      m.set(e.pos, s)
    }
    return m
  }, [validated.errors])

  const dimErrors = useMemo(
    () => validated.errors.filter((e) => e.pos === -1),
    [validated.errors],
  )

  const changeRowsCols = (field: 'rows' | 'cols', raw: string): void => {
    if (!/^\d{0,2}$/.test(raw)) return
    invalidate()
    setDoc((prev) => {
      const nextRows = field === 'rows' ? raw : prev.rows
      const nextCols = field === 'cols' ? raw : prev.cols
      const r = parseInt(nextRows, 10)
      const c = parseInt(nextCols, 10)
      if (!Number.isFinite(r) || !Number.isFinite(c) || r < MIN_DIM || c < MIN_DIM) {
        return { ...prev, rows: nextRows, cols: nextCols }
      }
      if (r > MAX_DIM || c > MAX_DIM) return { ...prev, rows: nextRows, cols: nextCols }
      // 尽量保留左上角重叠区域
      const oldCols = parseInt(prev.cols, 10) || 0
      const oldCells = prev.cells
      const cells: RawCell[] = []
      for (let i = 0; i < r * c; i++) {
        const rr = (i / c) | 0
        const cc = i % c
        const oldPos = Number.isFinite(oldCols) && oldCols > 0 ? rr * oldCols + cc : -1
        cells.push(oldPos >= 0 && oldPos < oldCells.length ? oldCells[oldPos] : defaultCell())
      }
      setEndpoints((ep) => ({
        ...ep,
        start: ep.start && ep.start.r < r && ep.start.c < c ? ep.start : null,
        goal: ep.goal && ep.goal.r < r && ep.goal.c < c ? ep.goal : null,
      }))
      return { rows: nextRows, cols: nextCols, cells }
    })
  }

  const onCellClick = (pos: number): void => {
    if (pickMode === 'start' || pickMode === 'goal') {
      const cols = parseInt(doc.cols, 10)
      if (!Number.isFinite(cols)) return
      const r = (pos / cols) | 0
      const c = pos % cols
      invalidate()
      setEndpoints((ep) => ({
        ...ep,
        ...(pickMode === 'start'
          ? { start: { r, c }, goal: ep.goal && ep.goal.r === r && ep.goal.c === c ? null : ep.goal }
          : { goal: { r, c }, start: ep.start && ep.start.r === r && ep.start.c === c ? null : ep.start }),
      }))
      setPickMode(null)
      return
    }
    setSelected(pos)
  }

  const editSelected = (patch: Partial<RawCell>): void => {
    if (selected === null) return
    invalidate()
    setDoc((prev) => {
      const cells = prev.cells.slice()
      cells[selected] = { ...cells[selected], ...patch }
      return { ...prev, cells }
    })
    // 把起终点所在格改成阻断时，起终点标记仍保留，由求解前校验拦下并定位提示
  }

  const loadScenario = (s: Scenario): void => {
    setDoc(s.doc)
    setEndpoints({ start: s.start, goal: s.goal, dir: s.dir })
    setSelected(null)
    setPickMode(null)
    invalidate()
  }

  const endpointIssues = useMemo(
    () => (validated.grid ? checkEndpoints(validated.grid, endpoints.start, endpoints.goal) : []),
    [validated.grid, endpoints.start, endpoints.goal],
  )

  const runSolve = (): void => {
    if (!validated.grid) return // 字段非法时不求解
    if (endpointIssues.length > 0) return
    if (pushLimitInvalid) return // 上限输入非法时不求解
    const { start, goal, dir } = endpoints
    run(validated.grid, {
      startR: start!.r,
      startC: start!.c,
      goalR: goal!.r,
      goalC: goal!.c,
      startDir: dir,
      pushLimit,
    })
  }

  const clearResult = (): void => clear()

  // 路线覆盖（用于棋盘角标）
  const routeIndex = useMemo(() => {
    const m = new Map<number, number>()
    if (result?.reachable) {
      result.steps.forEach((s, i) => m.set(s.r * (parseInt(doc.cols, 10) || 0) + s.c, i))
    }
    return m
  }, [result, doc.cols])

  const rideDest = useMemo(() => {
    const set = new Set<number>()
    if (result?.reachable) {
      const cols = parseInt(doc.cols, 10) || 0
      result.steps.forEach((s) => {
        if (s.kind === 'elevator') set.add(s.r * cols + s.c)
      })
    }
    return set
  }, [result, doc.cols])

  const hasFieldErrors = validated.errors.length > 0

  return (
    <div className="app">
      <h1>车站无障碍通道 · 暴雨倒灌复核器</h1>
      <p className="subtitle">
        纯浏览器运行（TypeScript + React + Vite），无在线服务、无业务后端。
        目标：总秒数 → 转弯数 → 坐标序列字典序，逐级取最小。
      </p>

      {hasFieldErrors && (
        <div className="error-box" data-testid="field-errors">
          <strong>存在非法字段，结果已清空；修正后重新求解：</strong>
          <ul>
            {validated.errors.map((e: FieldError, i) => (
              <li key={i} data-error-field={e.field}>
                {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="layout">
        <div>
          <div className="panel">
            <h2>站厅网格（最多 {MAX_DIM}×{MAX_DIM}，至多 {MAX_COST} 秒/格）</h2>
            <div className="dim-row">
              <label htmlFor="rows-input">行数</label>
              <input
                id="rows-input"
                data-field="rows"
                className={dimErrors.some((e) => e.field === 'rows') ? 'invalid' : ''}
                type="text"
                inputMode="numeric"
                value={doc.rows}
                onChange={(e) => changeRowsCols('rows', e.target.value)}
              />
              <label htmlFor="cols-input">列数</label>
              <input
                id="cols-input"
                data-field="cols"
                className={dimErrors.some((e) => e.field === 'cols') ? 'invalid' : ''}
                type="text"
                inputMode="numeric"
                value={doc.cols}
                onChange={(e) => changeRowsCols('cols', e.target.value)}
              />
              <span className="muted">1–{MAX_DIM}</span>
            </div>

            <div className="toolbar">
              <button
                type="button"
                className={pickMode === 'start' ? 'active' : ''}
                data-action="pick-start"
                onClick={() => setPickMode(pickMode === 'start' ? null : 'start')}
              >
                {pickMode === 'start' ? '请在网格点选起点…' : '点选起点'}
              </button>
              <button
                type="button"
                className={pickMode === 'goal' ? 'active' : ''}
                data-action="pick-goal"
                onClick={() => setPickMode(pickMode === 'goal' ? null : 'goal')}
              >
                {pickMode === 'goal' ? '请在网格点选终点…' : '点选终点'}
              </button>
              <button type="button" data-action="solve" onClick={runSolve} disabled={busy}>
                {busy ? '计算中…（仍可编辑）' : '求解 / 复核'}
              </button>
              <button type="button" data-action="clear" onClick={clearResult} disabled={busy}>
                清空结果
              </button>
              <button type="button" onClick={() => loadScenario(floodScenario())}>
                载入暴雨示例
              </button>
              <button type="button" onClick={() => loadScenario(plainScenario())}>
                载入纯步行示例
              </button>
            </div>

            <div className="dim-row">
              <span>初始朝向：</span>
              <DirPicker
                dir={endpoints.dir}
                onChange={(d) => {
                  invalidate()
                  setEndpoints((ep) => ({ ...ep, dir: d }))
                }}
              />
            </div>

            <Board
              cells={doc.cells}
              rows={parseInt(doc.rows, 10) || 0}
              cols={parseInt(doc.cols, 10) || 0}
              selected={selected}
              start={endpoints.start}
              goal={endpoints.goal}
              badFields={badFields}
              routeIndex={routeIndex}
              rideDest={rideDest}
              reachSeen={result && !result.reachable ? result.reachSeen : null}
              onCellClick={onCellClick}
            />
            <div className="legend">
              <span className="lg-normal">通行格（数字为进入耗时）</span>
              <span className="lg-elevator">电梯格（组号·首次等待）</span>
              <span className="lg-blocked">阻断（淹水封闭）</span>
              <span className="lg-reach">不可达时的可达集合</span>
              <span className="lg-path">角标数字＝路线步序</span>
            </div>
          </div>
        </div>

        <div>
          <div className="panel">
            <h2>格编辑</h2>
            <CellEditor
              cell={selected === null ? null : doc.cells[selected]}
              pos={selected}
              cols={parseInt(doc.cols, 10) || 1}
              errors={validated.errors}
              onChange={editSelected}
            />
          </div>

          <div className="panel">
            <h2>求解条件</h2>
            <div className="field-grid">
              <label>起点</label>
              <div data-testid="start-label">
                {endpoints.start
                  ? `第 ${endpoints.start.r + 1} 行第 ${endpoints.start.c + 1} 列`
                  : '未选择'}
              </div>
              <label>终点</label>
              <div data-testid="goal-label">
                {endpoints.goal
                  ? `第 ${endpoints.goal.r + 1} 行第 ${endpoints.goal.c + 1} 列`
                  : '未选择'}
              </div>
              <label>初始朝向</label>
              <DirPicker
                dir={endpoints.dir}
                onChange={(d) => {
                  invalidate()
                  setEndpoints((ep) => ({ ...ep, dir: d }))
                }}
              />
              <label>连续推行上限</label>
              <div>
                <label className="check-row">
                  <input
                    type="checkbox"
                    data-testid="push-limit-toggle"
                    checked={pushLimitEnabled}
                    onChange={(e) => {
                      invalidate()
                      setPushLimitEnabled(e.target.checked)
                    }}
                  />
                  限制连续推行（手动轮椅）
                </label>
                <input
                  id="push-limit-input"
                  data-testid="push-limit-input"
                  type="text"
                  inputMode="numeric"
                  style={{ width: 64, marginLeft: 8 }}
                  className={pushLimitInvalid ? 'invalid' : ''}
                  disabled={!pushLimitEnabled}
                  value={pushLimitRaw}
                  onChange={(e) => {
                    if (!/^\d{0,3}$/.test(e.target.value)) return
                    invalidate()
                    setPushLimitRaw(e.target.value)
                  }}
                />
                <span className="muted">
                  {' '}
                  秒（{MIN_PUSH_LIMIT}–{MAX_PUSH_LIMIT}）；超过上限的推行动作不予采用，乘梯后清零
                </span>
                {pushLimitInvalid && (
                  <div className="field-err" data-testid="push-limit-error">
                    连续推行上限须为 {MIN_PUSH_LIMIT}–{MAX_PUSH_LIMIT} 的整数秒，或关闭限制
                  </div>
                )}
              </div>
            </div>
            {endpointIssues.length > 0 && (
              <div className="notice-warn" data-testid="endpoint-warn" style={{ marginTop: 10 }}>
                {endpointIssues.map((iss, i) => (
                  <div key={i} data-issue={iss.kind}>
                    {iss.message}
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              data-action="solve-2"
              onClick={runSolve}
              disabled={hasFieldErrors || endpointIssues.length > 0 || pushLimitInvalid}
              style={{ marginTop: 12, width: '100%' }}
            >
              求解 / 复核
            </button>
            {hasFieldErrors && (
              <p className="muted" style={{ marginTop: 8 }}>
                存在非法字段时禁止求解，请先修正（见顶部定位清单与红色格）。
              </p>
            )}
          </div>

          {result !== undefined && (
            <div className="panel">
              <h2>复核结果</h2>
              <RoutePanel result={result} totalCells={doc.cells.length} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
