import { DIR_NAME, SolveResult } from '../types'

interface RoutePanelProps {
  result: SolveResult
  totalCells: number
}

export function RoutePanel({ result, totalCells }: RoutePanelProps) {
  if (!result.reachable) {
    // 拓扑可达但受连续推行上限约束失败：另一套证据口径
    const staminaFail = result.pushLimit !== null && result.minOver > 0
    if (staminaFail) {
      return (
        <div className="notice-bad" data-testid="result" data-reachable="false">
          <strong>
            超出连续推行上限：{result.pushLimit} 秒上限下不存在从起点到终点的可行路线。
          </strong>
          <div className="muted" style={{ marginTop: 8, color: '#e6b3b2' }}>
            旧路线已立即清空。受限证据（连通关系不变：正交相邻＋同组电梯）：
            <ul style={{ margin: '6px 0 0' }}>
              <li>
                网格总格数：<b data-testid="total-cells">{totalCells}</b>
              </li>
              <li>
                真正阻断（淹水封闭）格数：
                <b data-testid="blocked-count" style={{ color: '#ff9d9b' }}>
                  {result.blockedCount}
                </b>
              </li>
              <li>
                推行上限约束下从起点实际到达格数：
                <b data-testid="reach-count" style={{ color: '#ff9d9b', fontSize: 16 }}>
                  {result.reachableCount}
                </b>
                （蓝色描边；其余格因耐力约束无法推行到达）
              </li>
              <li>
                所有被拒动作中的最小超限秒数：
                <b data-testid="min-over" style={{ color: '#ff9d9b', fontSize: 16 }}>
                  {result.minOver}
                </b>
                （即某步连续推行将累计至 {result.pushLimit! + result.minOver} 秒，
                超出 {result.pushLimit} 秒上限 {result.minOver} 秒）
              </li>
            </ul>
          </div>
        </div>
      )
    }
    return (
      <div className="notice-bad" data-testid="result" data-reachable="false">
        <strong>不可达：封闭后不存在从起点到终点的路线。</strong>
        <div className="muted" style={{ marginTop: 8, color: '#e6b3b2' }}>
          旧路线已立即清空。失败证据（与求解器同一连通关系：正交相邻＋同组电梯）：
          <ul style={{ margin: '6px 0 0' }}>
            <li>
              网格总格数：<b data-testid="total-cells">{totalCells}</b>
            </li>
            <li>
              真正阻断（淹水封闭）格数：
              <b data-testid="blocked-count" style={{ color: '#ff9d9b' }}>
                {result.blockedCount}
              </b>
            </li>
            <li>
              从起点可达格数：
              <b data-testid="reach-count" style={{ color: '#ff9d9b', fontSize: 16 }}>
                {result.reachableCount}
              </b>
            </li>
            <li>
              与起点不连通的其它开放片区格数：
              <b data-testid="other-open-count">
                {totalCells - result.blockedCount - result.reachableCount}
              </b>
              （这些格没有淹水，只是被阻断格隔开——终点位于其中，不在蓝色描边的可达集合内，可逐格核对）
            </li>
          </ul>
        </div>
      </div>
    )
  }

  // 沿路线累计“已付费电梯组集合”，用于逐行展示状态第三要素
  const paidSets: string[] = []
  const paid = new Set<number>()
  for (const s of result.steps) {
    if (s.kind === 'elevator' && s.group !== undefined) paid.add(s.group)
    paidSets.push(paid.size ? [...paid].sort((a, b) => a - b).join(',') : '—')
  }

  return (
    <div className="notice-ok" data-testid="result" data-reachable="true">
      <strong>复核通过：已求得字典序最优路线。</strong>
      <div className="summary-row" style={{ marginTop: 8 }}>
        <span className="metric">
          总秒数：
          <b data-testid="total">{result.total}</b>
        </span>
        <span className="metric">
          转弯数：
          <b data-testid="turns" style={{ color: 'var(--accent)' }}>{result.turns}</b>
        </span>
        <span className="metric">
          步数：
          <b style={{ color: 'var(--ok)' }}>{result.steps.length - 1}</b>
        </span>
        {result.pushLimit !== null && (
          <span className="metric">
            连续推行上限：
            <b data-testid="push-limit" style={{ color: 'var(--warn)' }}>
              {result.pushLimit}
            </b>
          </span>
        )}
      </div>

      <div className="board-scroll" style={{ marginTop: 8 }}>
        <table className="steps" data-testid="steps-table">
          <thead>
            <tr>
              <th className="coord">步</th>
              <th className="coord">行</th>
              <th className="coord">列</th>
              <th className="coord">动作</th>
              <th className="coord">朝向</th>
              <th>基础耗时</th>
              <th>转弯费</th>
              <th>电梯费(含首等)</th>
              <th>本步合计</th>
              <th>累计秒数</th>
              {result.pushLimit !== null && <th>推行累计</th>}
              <th className="coord">已付费组</th>
            </tr>
          </thead>
          <tbody>
            {result.steps.map((s, i) => {
              let action = '步行'
              if (i === 0) action = '起点'
              else if (s.kind === 'elevator')
                action = s.wait > 0 ? `乘${s.group}组(首乘等待${s.wait})` : `乘${s.group}组`
              else if (s.enteredGroup !== undefined) action = `步行进入${s.enteredGroup}组电梯`
              return (
                <tr
                  key={i}
                  className={s.kind === 'elevator' ? 'ride-elevator' : ''}
                  data-step-row={i}
                >
                  <td className="coord">{i}</td>
                  <td className="coord">{s.r + 1}</td>
                  <td className="coord">{s.c + 1}</td>
                  <td className="coord">{action}</td>
                  <td className="coord">{DIR_NAME[s.dir]}</td>
                  <td>{s.base}</td>
                  <td>{s.turn}</td>
                  <td>
                    {s.fare}
                    {s.wait > 0 ? <span className="muted">（等待{s.wait}）</span> : null}
                  </td>
                  <td>{s.stepCost}</td>
                  <td>
                    <b data-testid={i === result.steps.length - 1 ? 'final-total' : undefined}>
                      {s.total}
                    </b>
                  </td>
                  {result.pushLimit !== null && (
                    <td data-push={s.push}>
                      <b>{s.push}</b>
                      {s.kind === 'elevator' ? (
                        <span className="muted">（乘梯清零）</span>
                      ) : s.enteredGroup !== undefined ? (
                        <span className="muted">（入梯不计）</span>
                      ) : null}
                    </td>
                  )}
                  <td className="coord">{paidSets[i]}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ margin: '8px 0 0' }}>
        优化次序：总秒数 → 转弯数 → 从起点逐项比较 (行号, 列号) 坐标序列。
        转弯费每次 5 秒；电梯换乘固定 8 秒、朝向不变；同组首次等待只计一次。
        {result.pushLimit !== null &&
          ` 连续推行上限 ${result.pushLimit} 秒：正交移动计入目标格耗时与转弯费，步行入梯不计，乘梯到达后清零。`}
      </p>
    </div>
  )
}
