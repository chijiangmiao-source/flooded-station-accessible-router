import { RawCell, FieldError } from '../validation'
import { DIR_NAME, Dir } from '../types'

interface CellEditorProps {
  cell: RawCell | null
  pos: number | null
  cols: number
  errors: FieldError[]
  onChange: (patch: Partial<RawCell>) => void
}

export function CellEditor({ cell, pos, cols, errors, onChange }: CellEditorProps) {
  if (!cell || pos === null) {
    return <p className="muted">在网格上点选一格后，可在此编辑其类型与参数。</p>
  }
  const r = ((pos / cols) | 0) + 1
  const c = (pos % cols) + 1
  const errOf = (f: FieldError['field']) => errors.find((e) => e.pos === pos && e.field === f)

  return (
    <div className="field-grid" data-pos={pos}>
      <label>位置</label>
      <div>
        第 {r} 行 · 第 {c} 列
      </div>

      <label>格子类型</label>
      <div className="toolbar" style={{ margin: 0 }}>
        <button
          type="button"
          className={cell.kind === 'normal' ? 'active' : ''}
          onClick={() => onChange({ kind: 'normal' })}
        >
          通行格
        </button>
        <button
          type="button"
          className={cell.kind === 'elevator' ? 'active' : ''}
          onClick={() => onChange({ kind: 'elevator' })}
        >
          电梯格
        </button>
        <button
          type="button"
          className={cell.kind === 'blocked' ? 'active' : ''}
          onClick={() => onChange({ kind: 'blocked' })}
        >
          阻断（淹水）
        </button>
      </div>

      {cell.kind !== 'blocked' && (
        <>
          <label htmlFor="cell-cost">基础耗时(秒)</label>
          <div>
            <input
              id="cell-cost"
              data-field="cost"
              className={errOf('cost') ? 'invalid' : ''}
              type="text"
              inputMode="numeric"
              value={cell.cost}
              onChange={(e) => onChange({ cost: e.target.value })}
            />
            <span className="muted"> 进入此格的通行耗时，1–99</span>
            {errOf('cost') && (
              <div className="field-err" data-field-err="cost">{errOf('cost')!.message}</div>
            )}
          </div>
        </>
      )}

      {cell.kind === 'elevator' && (
        <>
          <label htmlFor="cell-group">电梯组号</label>
          <div>
            <input
              id="cell-group"
              data-field="group"
              className={errOf('group') ? 'invalid' : ''}
              type="text"
              inputMode="numeric"
              value={cell.group}
              onChange={(e) => onChange({ group: e.target.value })}
            />
            <span className="muted"> 1–9；同组电梯可互相乘用</span>
            {errOf('group') && (
              <div className="field-err" data-field-err="group">{errOf('group')!.message}</div>
            )}
          </div>

          <label htmlFor="cell-wait">首次等待(秒)</label>
          <div>
            <input
              id="cell-wait"
              data-field="wait"
              className={errOf('wait') ? 'invalid' : ''}
              type="text"
              inputMode="numeric"
              value={cell.wait}
              onChange={(e) => onChange({ wait: e.target.value })}
            />
            <span className="muted"> 1–99；该组首次乘用只收一次，同组须一致</span>
            {errOf('wait') && (
              <div className="field-err" data-field-err="wait">{errOf('wait')!.message}</div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

interface DirPickerProps {
  dir: Dir
  onChange: (d: Dir) => void
}

export function DirPicker({ dir, onChange }: DirPickerProps) {
  return (
    <div className="dir-buttons" role="radiogroup" aria-label="初始朝向">
      {([0, 1, 2, 3] as Dir[]).map((d) => (
        <button
          key={d}
          type="button"
          role="radio"
          aria-checked={dir === d}
          className={dir === d ? 'active' : ''}
          data-dir={d}
          onClick={() => onChange(d)}
        >
          {DIR_NAME[d]}
        </button>
      ))}
    </div>
  )
}
