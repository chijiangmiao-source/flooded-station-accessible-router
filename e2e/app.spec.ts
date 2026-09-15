import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test.describe('求解与费用展示', () => {
  test('暴雨示例：求得 46 秒、2 次转弯，并展示逐步明细', async ({ page }) => {
    await page.getByRole('button', { name: '求解 / 复核' }).first().click()
    const result = page.getByTestId('result')
    await expect(result).toBeVisible()
    await expect(result).toHaveAttribute('data-reachable', 'true')
    await expect(page.getByTestId('total')).toHaveText('46')
    await expect(page.getByTestId('turns')).toHaveText('2')
    await expect(page.getByTestId('final-total')).toHaveText('46')

    // 电梯换乘步：8 秒固定费 + 首次等待 10 秒 = 18，且不产生转弯
    const rideRow = page.locator('tr.ride-elevator')
    await expect(rideRow).toHaveCount(1)
    await expect(rideRow.locator('td').nth(7)).toHaveText('18（等待10）') // 电梯费列
    await expect(rideRow.locator('td').nth(6)).toHaveText('0') // 转弯费列
  })
})

test.describe('第三级字典序（总秒数与转弯数相同取坐标序列较小者）', () => {
  test('3×3 等耗时、初始朝西时，优先沿更小编号的北侧行进', async ({ page }) => {
    await page.getByRole('button', { name: '载入纯步行示例' }).click()
    // 初始朝向改为西
    await page.locator('button[data-dir="3"]').first().click()
    await page.getByRole('button', { name: '求解 / 复核' }).first().click()

    await expect(page.getByTestId('total')).toHaveText('14')
    await expect(page.getByTestId('turns')).toHaveText('2')
    // 期望路线：(3,1)→(2,1)→(1,1)→(1,2)→(1,3)，先一路向北再向东
    const rows = page.locator('table.steps tbody tr')
    await expect(rows).toHaveCount(5)
    const coord = (i: number) =>
      rows.nth(i).locator('td').evaluateAll((tds) => [tds[1].textContent, tds[2].textContent])
    expect(await coord(0)).toEqual(['3', '1'])
    expect(await coord(1)).toEqual(['2', '1'])
    expect(await coord(2)).toEqual(['1', '1'])
    expect(await coord(3)).toEqual(['1', '2'])
    expect(await coord(4)).toEqual(['1', '3'])
  })
})

test.describe('非法字段定位与清空', () => {
  test('耗时越界：定位到具体格，禁止求解并清空结果', async ({ page }) => {
    // 先正常求解一次
    await page.getByRole('button', { name: '求解 / 复核' }).first().click()
    await expect(page.getByTestId('result')).toBeVisible()

    // 选中左上角格，把耗时改成 100（越界）
    await page.locator('.cell[data-r="0"][data-c="0"]').click()
    await page.locator('#cell-cost').fill('100')

    const errBox = page.getByTestId('field-errors')
    await expect(errBox).toBeVisible()
    await expect(errBox).toContainText(/第 1 行第 1 列/)
    await expect(page.locator('.cell[data-r="0"][data-c="0"]')).toHaveClass(/cell-bad-cost/)

    // 结果立即消失，求解按钮禁用
    await expect(page.getByTestId('result')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '求解 / 复核' }).nth(1)).toBeDisabled()

    // 修正后可再次求解
    await page.locator('#cell-cost').fill('3')
    await expect(errBox).toHaveCount(0)
    await page.getByRole('button', { name: '求解 / 复核' }).first().click()
    await expect(page.getByTestId('result')).toHaveAttribute('data-reachable', 'true')
  })
})

test.describe('点选起终点与不可达证据', () => {
  test('点选模式下在网格重设终点', async ({ page }) => {
    await page.getByRole('button', { name: '点选终点' }).click()
    await page.locator('.cell[data-r="4"][data-c="5"]').click()
    await expect(page.getByTestId('goal-label')).toHaveText(/第 5 行第 6 列/)
  })

  test('封住两部电梯后左右两片断开：阻断格不把另一片开放区算成淹水', async ({ page }) => {
    // 暴雨示例：第 4 列整列淹水，仅靠 (2,2)/(2,5) 的 1 组电梯连通
    await page.locator('.cell[data-r="1"][data-c="1"]').click()
    await page.getByRole('button', { name: '阻断（淹水）' }).click()
    await page.locator('.cell[data-r="1"][data-c="4"]').click()
    await page.getByRole('button', { name: '阻断（淹水）' }).click()

    await page.getByRole('button', { name: '求解 / 复核' }).first().click()
    const result = page.getByTestId('result')
    await expect(result).toHaveAttribute('data-reachable', 'false')
    await expect(page.getByTestId('blocked-count')).toHaveText('7') // 原 5 淹水 + 2 电梯封闭
    await expect(page.getByTestId('reach-count')).toHaveText('14') // 起点所在左片开放格
    await expect(page.getByTestId('other-open-count')).toHaveText('9') // 右片开放格（非淹水）
    // 终点所在右片不着可达色
    const goalCell = page.locator('.cell[data-r="0"][data-c="5"]')
    await expect(goalCell).toHaveAttribute('data-reachable', '0')
  })
})

test.describe('连续推行上限', () => {
  test('受限成功：暴雨示例上限 11 秒仍得 46 秒路线，明细展示推行累计与乘梯清零', async ({ page }) => {
    await page.getByTestId('push-limit-toggle').check()
    await page.getByTestId('push-limit-input').fill('11')
    await page.getByRole('button', { name: '求解 / 复核' }).first().click()

    const result = page.getByTestId('result')
    await expect(result).toHaveAttribute('data-reachable', 'true')
    await expect(page.getByTestId('total')).toHaveText('46')
    await expect(page.getByTestId('turns')).toHaveText('2')
    await expect(page.getByTestId('push-limit')).toHaveText('11')
    await expect(page.locator('table.steps thead')).toContainText('推行累计')

    // 路线（1 基）：(5,1)→(4,1)→(3,1)→(2,1)→(2,2)梯→乘→(2,5)→(2,6)→(1,6)
    // 推行累计：3, 6, 9, 9(入梯不计), 0(乘梯清零), 3, 11(转弯5+耗时3)
    const rows = page.locator('table.steps tbody tr')
    await expect(rows).toHaveCount(8)
    const pushOf = (i: number) => rows.nth(i).locator('td').nth(10)
    await expect(pushOf(3)).toHaveText('9')
    await expect(pushOf(4)).toHaveText('9（入梯不计）')
    await expect(pushOf(5)).toHaveText('0（乘梯清零）')
    await expect(pushOf(6)).toHaveText('3')
    await expect(pushOf(7)).toHaveText('11')

    // 编辑上限立即作废分析结果
    await page.getByTestId('push-limit-input').fill('12')
    await expect(page.getByTestId('result')).toHaveCount(0)
  })

  test('耐力失败：上限 8 秒时纯步行 3×3 无解，报告最小超限并标出约束到达集', async ({ page }) => {
    await page.getByRole('button', { name: '载入纯步行示例' }).click()
    await page.getByTestId('push-limit-toggle').check()
    await page.getByTestId('push-limit-input').fill('8')
    await page.getByRole('button', { name: '求解 / 复核' }).first().click()

    const result = page.getByTestId('result')
    await expect(result).toHaveAttribute('data-reachable', 'false')
    await expect(result).toContainText('超出连续推行上限')
    await expect(page.getByTestId('min-over')).toHaveText('1') // 末步推行将达 9 秒，超 1 秒
    await expect(page.getByTestId('reach-count')).toHaveText('8') // 除终点外 8 格可推行到达
    // 终点 (1,3) 不在约束到达集内；(1,2) 在
    await expect(page.locator('.cell[data-r="0"][data-c="2"]')).toHaveAttribute('data-reachable', '0')
    await expect(page.locator('.cell[data-r="0"][data-c="1"]')).toHaveAttribute('data-reachable', '1')
    // 旧路线已清空：无步骤表
    await expect(page.locator('table.steps')).toHaveCount(0)
  })

  test('关闭限制后恢复原有无约束路线', async ({ page }) => {
    await page.getByRole('button', { name: '载入纯步行示例' }).click()
    // 先开限制：上限 8 秒失败
    await page.getByTestId('push-limit-toggle').check()
    await page.getByTestId('push-limit-input').fill('8')
    await page.getByRole('button', { name: '求解 / 复核' }).first().click()
    await expect(page.getByTestId('result')).toHaveAttribute('data-reachable', 'false')

    // 关闭限制：失败结果立即作废
    await page.getByTestId('push-limit-toggle').uncheck()
    await expect(page.getByTestId('result')).toHaveCount(0)

    // 重新求解：恢复 9 秒无约束路线，且不再展示推行累计列
    await page.getByRole('button', { name: '求解 / 复核' }).first().click()
    await expect(page.getByTestId('result')).toHaveAttribute('data-reachable', 'true')
    await expect(page.getByTestId('total')).toHaveText('9')
    await expect(page.getByTestId('turns')).toHaveText('1')
    await expect(page.locator('table.steps thead')).not.toContainText('推行累计')
  })
})
