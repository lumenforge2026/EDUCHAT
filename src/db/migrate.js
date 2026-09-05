require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function migrate() {
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log(`Aplicando migration: ${file}`);
    await pool.query(sql);
  }

  console.log('Migrations aplicadas com sucesso.');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Falha ao aplicar migrations:', err);
  process.exit(1);
});
