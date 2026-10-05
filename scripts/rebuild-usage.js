'use strict';

/*
 * 派生占用表 annual_usage 的全量重建脚本（既有数据可重建派生结果）。
 *
 *   node scripts/rebuild-usage.js            # 重建全部展品
 *   node scripts/rebuild-usage.js 3 5        # 只重建指定展品
 *
 * - 一次调用选中的全部展品在“按展品 id 升序键锁 + 行锁 + 单一事务”内重建：
 *   先删除各展品旧的派生行，再用与线上完全相同的统一剂量口径（computeOccupancy 按年计算）
 *   逐行写入；同时把分级预警阈值行的 last_used_lxh / last_level 同步为最新值
 *   （仅同步边沿判定基线，不补发任何历史事件）。
 * - 任一展品不存在、任一步骤或任一年份失败：单一事务整体回滚并报错退出——
 *   所有选中展品（含先前已处理展品）的派生占用与预警最近状态都保持调用前值，
 *   绝不返回/保留部分展品已改或新旧占用混杂的状态。错误已在 stderr 明确记录，
 *   修正源数据后直接重跑本脚本即可（重建幂等，未发生任何改动时重试无副作用）。
 * - 与同展品的日常占用变更经同一展品键锁串行，不会并发写入互相覆盖。
 */

const { pool, withExhibitsTransaction } = require('../src/db');
const { initializeDatabase } = require('../src/init');
const { rebuildExhibitsUsage } = require('../src/usage');

async function main() {
  const argIds = process.argv.slice(2).map(Number);
  const badArgs = argIds.filter((id) => !Number.isInteger(id) || id <= 0);
  if (badArgs.length > 0) {
    throw new Error(`展品 id 参数必须为正整数，收到：${badArgs.join('、')}`);
  }
  await initializeDatabase();

  let exhibitIds;
  if (argIds.length > 0) {
    exhibitIds = [...new Set(argIds)].sort((a, b) => a - b);
    const ph = exhibitIds.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await pool.query(
      `SELECT id FROM exhibits WHERE id IN (${ph}) ORDER BY id`, exhibitIds);
    if (rows.length !== exhibitIds.length) {
      const found = new Set(rows.map((r) => Number(r.id)));
      const missing = exhibitIds.filter((id) => !found.has(id));
      throw new Error(`展品不存在：${missing.join('、')}（本次未改动任何展品，可修正 id 后重试）`);
    }
  } else {
    const { rows } = await pool.query('SELECT id FROM exhibits ORDER BY id');
    exhibitIds = rows.map((r) => Number(r.id));
  }

  // 全部选中展品在同一事务（按 id 升序键锁 + 行锁）内原子重建。
  const rebuilt = await withExhibitsTransaction(exhibitIds, (client) =>
    rebuildExhibitsUsage(client, exhibitIds));

  let totalYears = 0;
  for (const { exhibitId, years } of rebuilt) {
    totalYears += years.length;
    console.log(`[rebuild-usage] 展品 #${exhibitId}：重建 ${years.length} 个自然年（${years.join(', ') || '无'}）`);
  }
  console.log(`[rebuild-usage] 完成：${rebuilt.length} 件展品，${totalYears} 个年度占用行（整组同一事务原子生效）`);
  await pool.end();
}

main().catch((err) => {
  console.error('[rebuild-usage] 重建失败：本次操作的全部展品均已回滚，annual_usage 与预警最近状态保持操作前值:', err);
  console.error('[rebuild-usage] 修正源数据后可直接重新执行本命令（重建幂等，可安全重试）。');
  process.exit(1);
});
