import { describe, expect, it } from 'vitest'
import {
  MAX_COST,
  MAX_DIM,
  MAX_GROUP,
  MAX_WAIT,
  checkEndpoints,
  defaultCell,
  makeRawDoc,
  validateDoc,
} from './validation'

describe('validateDoc', () => {
  it('合法的通行格/电梯格文档通过', () => {
    const doc = makeRawDoc(3, 3)
    doc.cells[4] = { kind: 'elevator', cost: '12', group: '2', wait: '30' }
    const { grid, errors } = validateDoc(doc)
    expect(errors).toEqual([])
    expect(grid).not.toBeNull()
    expect(grid!.cells[4]).toEqual({ kind: 'elevator', cost: 12, group: 2, wait: 30 })
  })

  it('阻断格无需 cost/group/wait', () => {
    const doc = makeRawDoc(2, 2)
    doc.cells[0] = { kind: 'blocked', cost: 'x', group: '', wait: '' }
    const { errors } = validateDoc(doc)
    expect(errors).toEqual([])
  })

  it('耗时 0、100、小数、非数字、负数均非法并定位到格与 cost 字段', () => {
    for (const bad of ['0', String(MAX_COST + 1), '1.5', 'abc', '-3', '  ', '12秒']) {
      const doc = makeRawDoc(2, 2)
      doc.cells[2] = { ...defaultCell(), cost: bad }
      const { grid, errors } = validateDoc(doc)
      expect(grid).toBeNull()
      const e = errors.find((x) => x.pos === 2 && x.field === 'cost')
      expect(e, `cost=${bad} 应报错`).toBeDefined()
      expect(e!.r).toBe(1)
      expect(e!.c).toBe(0)
    }
  })

  it('电梯组号越界、首次等待越界分别定位', () => {
    const doc = makeRawDoc(2, 2)
    doc.cells[0] = { kind: 'elevator', cost: '5', group: '0', wait: '3' }
    doc.cells[3] = { kind: 'elevator', cost: '5', group: String(MAX_GROUP + 1), wait: String(MAX_WAIT + 1) }
    const { errors } = validateDoc(doc)
    expect(errors.some((e) => e.pos === 0 && e.field === 'group')).toBe(true)
    expect(errors.some((e) => e.pos === 3 && e.field === 'group')).toBe(true)
    expect(errors.some((e) => e.pos === 3 && e.field === 'wait')).toBe(true)
  })

  it('同组电梯首次等待不一致时，定位到后一格的 wait 字段', () => {
    const doc = makeRawDoc(1, 4)
    doc.cells[1] = { kind: 'elevator', cost: '2', group: '1', wait: '10' }
    doc.cells[3] = { kind: 'elevator', cost: '2', group: '1', wait: '11' }
    const { errors } = validateDoc(doc)
    const e = errors.find((x) => x.field === 'wait')
    expect(e).toBeDefined()
    expect(e!.pos).toBe(3)
  })

  it(`尺寸 0、${MAX_DIM + 1}、非整数均定位到尺寸字段`, () => {
    for (const [rows, cols, field] of [
      ['0', '3', 'rows'],
      ['3', '21', 'cols'],
      ['x', '3', 'rows'],
    ] as const) {
      const doc = makeRawDoc(2, 2)
      doc.rows = rows
      doc.cols = cols
      const { errors } = validateDoc(doc)
      expect(errors.some((e) => e.pos === -1 && e.field === field)).toBe(true)
    }
  })

  it('MAX_DIM 边界 20×20 合法', () => {
    const doc = makeRawDoc(MAX_DIM, MAX_DIM)
    expect(validateDoc(doc).errors).toEqual([])
  })
})

describe('checkEndpoints', () => {
  const doc = makeRawDoc(2, 2)
  doc.cells[3] = { ...defaultCell(), kind: 'blocked' }
  const grid = validateDoc(doc).grid!

  it('未选择、落在阻断格、重合均给出反馈', () => {
    expect(checkEndpoints(grid, null, null).map((i) => i.kind)).toContain('start')
    expect(
      checkEndpoints(grid, { r: 1, c: 1 }, { r: 0, c: 0 }).some((i) => i.kind === 'start'),
    ).toBe(true)
    expect(
      checkEndpoints(grid, { r: 0, c: 0 }, { r: 0, c: 0 }).some((i) => i.kind === 'goal'),
    ).toBe(true)
  })

  it('正常起终点无反馈', () => {
    expect(checkEndpoints(grid, { r: 0, c: 0 }, { r: 0, c: 1 })).toEqual([])
  })
})
