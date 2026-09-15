import { RawCell } from '../validation'

export interface BoardProps {
  cells: RawCell[]
  rows: number
  cols: number
  selected: number | null
  start: { r: number; c: number } | null
  goal: { r: number; c: number } | null
  badFields: ReadonlyMap<number, Set<string>>
  routeIndex: ReadonlyMap<number, number> // 格 -> 路线步序号
  rideDest: ReadonlySet<number> // 乘电梯到达的格
  reachSeen: Uint8Array | null // 不可达时的可达性证据着色
  onCellClick: (pos: number) => void
}

export function Board(props: BoardProps) {
  const {
    cells, rows, cols, selected, start, goal, badFields,
    routeIndex, rideDest, reachSeen, onCellClick,
  } = props

  const startPos = start ? start.r * cols + start.c : -1
  const goalPos = goal ? goal.r * cols + goal.c : -1

  return (
    <div className="board-scroll">
      <div
        className="board"
        style={{ gridTemplateColumns: `repeat(${cols}, 40px)` }}
        role="grid"
        aria-label="车站网格"
        data-rows={rows}
        data-cols={cols}
      >
        {cells.map((cell, pos) => {
          const r = (pos / cols) | 0
          const c = pos % cols
          const bad = badFields.get(pos)
          const classes = ['cell']
          classes.push(cell.kind)
          if (selected === pos) classes.push('selected')
          if (reachSeen && reachSeen[pos]) classes.push('reachable')
          if (bad?.has('cost')) classes.push('cell-bad-cost')
          if (bad?.has('group')) classes.push('cell-bad-group')
          if (bad?.has('wait')) classes.push('cell-bad-wait')

          const stepNo = routeIndex.get(pos)

          return (
            <button
              key={pos}
              type="button"
              className={classes.join(' ')}
              role="gridcell"
              aria-label={`第${r + 1}行第${c + 1}列`}
              data-pos={pos}
              data-r={r}
              data-c={c}
              data-kind={cell.kind}
              data-reachable={reachSeen ? (reachSeen[pos] ? 1 : 0) : undefined}
              data-step={stepNo !== undefined ? stepNo : undefined}
              onClick={() => onCellClick(pos)}
            >
              {pos === startPos && <span className="marker">起</span>}
              {pos === goalPos && <span className="marker goal">终</span>}
              {cell.kind === 'blocked' ? (
                <>
                  <span className="big">淹</span>
                  <span className="small">
                    {r + 1},{c + 1}
                  </span>
                </>
              ) : cell.kind === 'elevator' ? (
                <>
                  <span className="big">{cell.cost || '—'}</span>
                  <span className="small">
                    梯{cell.group || '?'}·等{cell.wait || '?'}
                  </span>
                </>
              ) : (
                <>
                  <span className="big">{cell.cost || '—'}</span>
                  <span className="small">
                    {r + 1},{c + 1}
                  </span>
                </>
              )}
              {stepNo !== undefined && (
                <span
                  className={`step-badge${rideDest.has(pos) ? ' elevator-ride' : ''}`}
                  title={rideDest.has(pos) ? '乘电梯到达' : `路线第 ${stepNo} 步`}
                >
                  {rideDest.has(pos) ? `梯${stepNo}` : stepNo}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
