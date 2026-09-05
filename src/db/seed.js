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

// RF-04 — contatos de exemplo para exercitar o broadcast em ambiente local.
// O cadastro real de opt-in pelo próprio WhatsApp (RF-10) chega no Módulo D,
// na Sprint 04 — até lá, esta é a única forma de povoar a lista de envio.
async function upsertContact({ phone, name }) {
  await pool.query(
    `INSERT INTO contacts (phone, name, opt_in)
     VALUES ($1, $2, true)
     ON CONFLICT (phone) DO NOTHING`,
    [phone, name]
  );
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

  await upsertContact({ phone: '+5511999990001', name: 'Aluno de teste 1' });
  await upsertContact({ phone: '+5511999990002', name: 'Responsável de teste 2' });
  console.log('Contatos de teste prontos (RF-04).');

  await pool.end();
}

seed().catch((err) => {
  console.error('Falha ao popular usuários:', err);
  process.exit(1);
});
