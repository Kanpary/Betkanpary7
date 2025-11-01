// db.js
import pkg from 'pg';
const { Pool } = pkg;

// Cria o pool de conexões usando a DATABASE_URL do Render
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Necessário no Render para aceitar o certificado SSL
  },
});

// Função para inicializar as tabelas
export async function init() {
  await pool.query(`
    create table if not exists users (
      id uuid primary key,
      email text unique,
      created_at timestamptz default now()
    );

    create table if not exists wallets (
      user_id uuid primary key references users(id),
      balance numeric(20,2) default 0,
      hold numeric(20,2) default 0
    );

    create table if not exists payments (
      id text primary key,
      type text check (type in ('payment','payout')),
      user_id uuid references users(id),
      amount numeric(20,2),
      currency text,
      status text,
      raw jsonb,
      created_at timestamptz default now()
    );

    create table if not exists rounds (
      id uuid primary key,
      user_id uuid references users(id),
      bet_amount numeric(20,2),
      bet_type text,
      bet_value text,
      result int,
      color text,
      payout numeric(20,2),
      server_seed_hash text,
      client_seed text,
      nonce text,
      created_at timestamptz default now()
    );

    create table if not exists audits (
      id uuid primary key,
      event text,
      payload jsonb,
      created_at timestamptz default now()
    );
  `);
}
