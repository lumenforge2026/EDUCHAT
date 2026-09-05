const express = require('express');
const { getSheetConfig, updateSheetConfig, previewSheet } = require('../controllers/integrations.controller');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireRole('administrador', 'equipe_escola'));

router.get('/sheets/config', getSheetConfig);
router.put('/sheets/config', requireRole('administrador'), updateSheetConfig);
router.get('/sheets/preview', previewSheet);

module.exports = router;
