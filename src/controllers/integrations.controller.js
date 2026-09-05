const pool = require('../db/pool');
const { fetchSheetValues } = require('../utils/googleSheets');

async function getConfigRow() {
  const { rows } = await pool.query('SELECT * FROM sheet_config WHERE id = 1');
  return rows[0] || null;
}

// RF-15 — o Administrador consulta qual planilha e qual intervalo estão
// configurados.
async function getSheetConfig(req, res, next) {
  try {
    const config = await getConfigRow();
    return res.json({
      sheetId: config?.sheet_id || null,
      sheetRange: config?.sheet_range || 'A:Z',
      updatedAt: config?.updated_at || null,
    });
  } catch (err) {
    return next(err);
  }
}

// RF-15 — o Administrador configura qual planilha e qual intervalo de
// dados são consumidos.
async function updateSheetConfig(req, res, next) {
  try {
    const { sheetId, sheetRange } = req.body;
    if (!sheetId || String(sheetId).trim() === '') {
      return res.status(400).json({ error: 'Informe o ID da planilha.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO sheet_config (id, sheet_id, sheet_range, updated_by, updated_at)
       VALUES (1, $1, $2, $3, now())
       ON CONFLICT (id) DO UPDATE SET
         sheet_id = EXCLUDED.sheet_id,
         sheet_range = EXCLUDED.sheet_range,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING *`,
      [sheetId.trim(), sheetRange?.trim() || 'A:Z', req.user.sub]
    );

    return res.json({
      sheetId: rows[0].sheet_id,
      sheetRange: rows[0].sheet_range,
      updatedAt: rows[0].updated_at,
    });
  } catch (err) {
    return next(err);
  }
}

// RF-14 — prova de conceito de leitura: lê a planilha configurada e
// devolve as linhas cruas, sem gravar nada (a sincronização periódica é
// o Módulo G, na Sprint 06).
async function previewSheet(req, res, next) {
  try {
    const config = await getConfigRow();
    if (!config?.sheet_id) {
      return res.status(400).json({ error: 'Nenhuma planilha configurada. Configure em PUT /api/integrations/sheets/config.' });
    }

    const result = await fetchSheetValues(config.sheet_id, config.sheet_range);
    return res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

module.exports = { getSheetConfig, updateSheetConfig, previewSheet };
