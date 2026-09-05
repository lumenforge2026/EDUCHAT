const { parse } = require('csv-parse/sync');

// RF-15 — parseia o CSV exportado da planilha (Google Sheets: Arquivo >
// Fazer download > Valores separados por vírgula) em linhas de texto, no
// mesmo formato (array de arrays) devolvido pela API do Google Sheets.
function parseCsvBuffer(buffer) {
  try {
    return parse(buffer, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
    });
  } catch (err) {
    throw Object.assign(new Error(`Não foi possível ler o arquivo CSV: ${err.message}`), { status: 400 });
  }
}

module.exports = { parseCsvBuffer };
