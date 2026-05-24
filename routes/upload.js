/**
 * 已登录 Session 在线上传路由。
 */

const router = require('express').Router();
const uploadService = require('../services/session-upload-service');

router.post('/upload/sub2api', async (req, res) => {
  try {
    const result = await uploadService.uploadToSub2Api(req.body || {});
    res.json({
      success: true,
      target: 'sub2api',
      ...result,
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/upload/cpa', async (req, res) => {
  try {
    const result = await uploadService.uploadToCpa(req.body || {});
    res.json({
      success: true,
      target: 'cpa',
      ...result,
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
