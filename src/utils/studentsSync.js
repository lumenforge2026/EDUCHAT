const pool = require('../db/pool');
const { fetchSheetValues } = require('./googleSheets');

// RF-16 — layout esperado da planilha, a partir da linha configurada em
// sheet_config.sheet_range (ex.: "Alunos!A2:D"): Nome | Série | Frequência
// (%) | Situação. Sem cabeçalho nas linhas lidas — o cabeçalho fica fora
// do intervalo configurado.
function parseAttendance(raw) {
  if (raw === undefined || raw === null || raw === '') return 0;
  const normalized = String(raw).replace('%', '').replace(',', '.').trim();
  const value = Number.parseFloat(normalized);
  return Number.isNaN(value) ? 0 : value;
}

function parseSituation(raw) {
  const normalized = String(raw || '').trim().toLowerCase();
  if (normalized.startsWith('risco')) return 'Risco';
  if (normalized.startsWith('atenc') || normalized.startsWith('atenç')) return 'Atenção';
  return 'Regular';
}

async function upsertStudent(row) {
  const [name, grade, attendanceRaw, situationRaw] = row;
  if (!name || !grade) return false;

  await pool.query(
    `INSERT INTO students (name, grade, attendance, situation, school_year, synced_at)
     VALUES ($1, $2, $3, $4, EXTRACT(YEAR FROM now()), now())
     ON CONFLICT (name, grade, school_year) DO UPDATE SET
       attendance = EXCLUDED.attendance,
       situation = EXCLUDED.situation,
       synced_at = now()`,
    [String(name).trim(), String(grade).trim(), parseAttendance(attendanceRaw), parseSituation(situationRaw)]
  );
  return true;
}

// RF-16, RF-17 — lê a planilha configurada (Módulo F) e sincroniza a tabela
// students, registrando o resultado (sucesso/falha) em sync_runs.
async function syncStudentsFromSheet() {
  const { rows: configRows } = await pool.query('SELECT * FROM sheet_config WHERE id = 1');
  const config = configRows[0];

  if (!config?.sheet_id) {
    await pool.query(
      "INSERT INTO sync_runs (status, rows_synced, detail) VALUES ('falha', 0, $1)",
      ['Nenhuma planilha configurada (RF-15).']
    );
    return { status: 'falha', rowsSynced: 0, detail: 'Nenhuma planilha configurada (RF-15).' };
  }

  try {
    const { values } = await fetchSheetValues(config.sheet_id, config.sheet_range);
    let synced = 0;
    for (const row of values) {
      if (await upsertStudent(row)) synced += 1;
    }

    await pool.query(
      "INSERT INTO sync_runs (status, rows_synced, detail) VALUES ('sucesso', $1, $2)",
      [synced, `${synced} de ${values.length} linha(s) sincronizada(s).`]
    );
    return { status: 'sucesso', rowsSynced: synced };
  } catch (err) {
    await pool.query(
      "INSERT INTO sync_runs (status, rows_synced, detail) VALUES ('falha', 0, $1)",
      [err.message]
    );
    return { status: 'falha', rowsSynced: 0, detail: err.message };
  }
}

module.exports = { syncStudentsFromSheet };
