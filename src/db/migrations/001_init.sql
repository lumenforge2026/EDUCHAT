-- EduBot — Sprint 02 — Pilar 1: modelagem relacional inicial
-- Tabelas base: users, opportunities, logs (conforme retro, slide 11)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(150) NOT NULL,
  email         VARCHAR(150) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          VARCHAR(30) NOT NULL CHECK (role IN ('administrador', 'equipe_escola')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RF-01 a RF-03 — Módulo A: Gestão de Oportunidades
CREATE TABLE IF NOT EXISTS opportunities (
  id              SERIAL PRIMARY KEY,
  title           VARCHAR(200) NOT NULL,
  description     TEXT NOT NULL,
  target_audience VARCHAR(150) NOT NULL,
  deadline        DATE NOT NULL,
  link            TEXT,
  attachment_name TEXT,
  is_draft        BOOLEAN NOT NULL DEFAULT false,
  dispatched_at   TIMESTAMPTZ,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RF-21 / RNF-07 — log de acessos e de disparos (auditoria)
CREATE TABLE IF NOT EXISTS logs (
  id              SERIAL PRIMARY KEY,
  type            VARCHAR(30) NOT NULL CHECK (type IN ('acesso', 'disparo')),
  user_id         UUID REFERENCES users(id),
  opportunity_id  INTEGER REFERENCES opportunities(id),
  detail          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_opportunities_deadline ON opportunities(deadline);
CREATE INDEX IF NOT EXISTS idx_logs_type ON logs(type);
