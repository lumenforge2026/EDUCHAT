const { Pool } = require('pg');

// RNF-08 — o Postgres gerenciado do Render (e da maioria dos provedores em
// nuvem) exige SSL em conexões externas. PGSSL=true habilita isso sem
// afetar o ambiente local (Docker/instalação própria), que continua sem
// SSL por padrão.
const ssl = process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false;

// DATABASE_URL (Internal/External Database URL do Render) tem prioridade
// quando definida — evita ter que quebrar a URL em host/porta/usuário/senha
// na mão. Sem ela, cai nas variáveis PG* de sempre (uso local).
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl })
  : new Pool({
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT) || 5432,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
      ssl,
    });

module.exports = pool;
