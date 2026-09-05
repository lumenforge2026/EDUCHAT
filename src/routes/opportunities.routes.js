const express = require('express');
const { create, list, getById, update, dispatch } = require('../controllers/opportunities.controller');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireRole('administrador', 'equipe_escola'));

router.get('/', list);
router.get('/:id', getById);
router.post('/', create);
router.put('/:id', update);
router.patch('/:id/dispatch', dispatch);

module.exports = router;
