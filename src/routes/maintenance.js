'use strict';

/*
 * 维护接口（仅保管员）：
 *   POST /api/maintenance/rebuild-usage  全量重建年度占用派生表 annual_usage。
 * 一次操作选中的全部展品在“按展品 id 升序键锁 + 行锁 + 单一事务”内完成：
 * 先删各展品旧派生行，再用线上同一统一剂量口径逐年写回，并同步预警阈值最近状态
 * （不补发任何预警事件）。任一展品或任一年份失败，单一事务整体回滚——
 * 所有选中展品（含先前已处理展品）的 annual_usage 与预警最近状态均保持操作前值，
 * 返回 { error } 说明失败原因，绝不留下部分展品已改/新旧占用混杂的结果。
 * 与同展品日常占用变更经同一展品键锁串行，不会并发写入互相覆盖。
 * body 可选 { exhibitIds: [..] } 只重建指定展品；不传（或 {}）则重建全部展品。
 */

const express = require('express');
const { query, withExhibitsTransaction } = require('../db');
const { requireRole, requireAuth } = require('../auth');
const { rebuildExhibitsUsage } = require('../usage');

const router = express.Router();

router.use(requireAuth);

router.post('/rebuild-usage', requireRole('conservator'), async (req, res, next) => {
  try {
    let exhibitIds = null;
    if (req.body && Array.isArray(req.body.exhibitIds)) {
      exhibitIds = req.body.exhibitIds.map(Number);
      if (exhibitIds.some((id) => !Number.isInteger(id) || id <= 0)) {
        return res.status(400).json({ error: 'exhibitIds 必须为正整数数组' });
      }
      if (exhibitIds.length === 0) {
        return res.status(400).json({ error: 'exhibitIds 至少包含一件展品' });
      }
    }

    let ids;
    if (exhibitIds) {
      ids = [...new Set(exhibitIds)].sort((a, b) => a - b);
      const ph = ids.map((_, i) => `$${i + 1}`).join(',');
      const { rows } = await query(
        `SELECT id FROM exhibits WHERE id IN (${ph}) ORDER BY id`, ids);
      if (rows.length !== ids.length) {
        const found = new Set(rows.map((r) => Number(r.id)));
        const missing = ids.filter((id) => !found.has(id));
        return res.status(400).json({ error: `展品不存在：${missing.join('、')}` });
      }
    } else {
      ids = (await query('SELECT id FROM exhibits ORDER BY id')).rows.map((r) => Number(r.id));
    }

    // 全部选中展品在同一个事务（按 id 升序键锁 + 行锁）内原子重建：
    // 任一展品/年份失败则整体回滚，已处理展品的派生占用与预警基线也一并还原。
    const rebuilt = await withExhibitsTransaction(ids, (client) =>
      rebuildExhibitsUsage(client, ids));

    res.json({
      ok: true,
      exhibitCount: rebuilt.length,
      yearCount: rebuilt.reduce((s, r) => s + r.years.length, 0),
      exhibits: rebuilt.map((r) => ({ exhibitId: r.exhibitId, yearCount: r.years.length, years: r.years })),
    });
  } catch (err) {
    next(err);
  }
});

// 未知维护路径 404（而非落到静态页）。
router.use((req, res) => {
  res.status(404).json({ error: `未知维护接口：${req.method} ${req.path}` });
});

module.exports = router;
