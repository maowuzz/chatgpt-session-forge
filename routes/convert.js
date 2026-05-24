/**
 * Session 转换路由
 * 将 ChatGPT session 转换为 CPA / sub2api 格式
 */

const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const config = require('../config');
const converter = require('../services/converter-service');

const DATA_FILE = path.resolve(__dirname, '..', config.dataFile);

/**
 * POST /api/convert/cpa - 转换为 CPA 格式
 */
router.post('/convert/cpa', (req, res) => {
  try {
    const { sessions } = req.body;
    if (!sessions) {
      return res.status(400).json({ success: false, error: '缺少 sessions 数据' });
    }

    const parsed = typeof sessions === 'string'
      ? converter.parseSessionInput(sessions)
      : sessions.map(s => converter.extractSessionInfo(s));

    const cpaResult = converter.toCPA(parsed);

    res.json({
      success: true,
      format: 'cpa',
      data: cpaResult,
      count: cpaResult.length,
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/convert/sub2api - 转换为 sub2api 格式
 */
router.post('/convert/sub2api', (req, res) => {
  try {
    const { sessions } = req.body;
    if (!sessions) {
      return res.status(400).json({ success: false, error: '缺少 sessions 数据' });
    }

    const parsed = typeof sessions === 'string'
      ? converter.parseSessionInput(sessions)
      : sessions.map(s => converter.extractSessionInfo(s));

    const sub2Result = converter.toSub2API(parsed);

    res.json({
      success: true,
      format: 'sub2api',
      data: sub2Result,
      count: sub2Result.accounts.length,
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/convert/from-accounts - 从已登录成功的账号中提取并转换
 */
router.post('/convert/from-accounts', (req, res) => {
  try {
    const { format = 'cpa', accountIds } = req.body;

    const accounts = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8') || '[]');
    const idSet = Array.isArray(accountIds) && accountIds.length > 0
      ? new Set(accountIds)
      : null;
    const sessions = accounts
      .filter(a => (!idSet || idSet.has(a.id)) && a.status === 'success' && a.session)
      .map(a => a.session);

    if (sessions.length === 0) {
      return res.json({ success: false, error: '没有已登录成功的账号' });
    }

    const parsed = sessions.map(s => converter.extractSessionInfo(s));

    let result;
    if (format === 'sub2api') {
      result = converter.toSub2API(parsed);
    } else {
      result = converter.toCPA(parsed);
    }

    res.json({
      success: true,
      format,
      data: result,
      count: format === 'sub2api' ? result.accounts.length : result.length,
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
