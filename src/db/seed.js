// RF-20 — restrição de negócio: sem rota de sign-up público.
// Contas de acesso são criadas exclusivamente pelo Administrador via seed,
// para proteger dados escolares (ver Documento de Escopo, seção 5.7).
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./pool');

async function upsertUser({ name, email, password, role }) {
  const passwordHash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role`,
    [name, email, passwordHash, role]
  );
  console.log(`Usuário pronto: ${email} (${role})`);
}

async function seed() {
  await upsertUser({
    name: 'Coordenação Pedagógica',
    email: process.env.SEED_ADMIN_EMAIL || 'coordenacao@escola.edu.br',
    password: process.env.SEED_ADMIN_PASSWORD || 'EduBot@2026',
    role: 'administrador',
  });

  await upsertUser({
    name: 'Equipe da Escola',
    email: process.env.SEED_EQUIPE_EMAIL || 'equipe@escola.edu.br',
    password: process.env.SEED_EQUIPE_PASSWORD || 'EduBot@2026',
    role: 'equipe_escola',
  });

  await pool.end();
}

seed().catch((err) => {
  console.error('Falha ao popular usuários:', err);
  process.exit(1);
});
