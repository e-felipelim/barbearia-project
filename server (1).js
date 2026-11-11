'use strict';
/**
 * MVP Barbearia - agendamento + assinatura com creditos  (versao pronta para publicar)
 * Stack: Node 18+, Express, SQLite (better-sqlite3). Sem Redis, sem gateway de pagamento.
 * Pagamentos sao registrados manualmente pelo dono. WhatsApp via Evolution API (opcional).
 * Horarios guardados em UTC (ISO). Fuso de exibicao: America/Sao_Paulo (UTC-3).
 *
 * Variaveis de ambiente (todas opcionais, veja DEPLOY.txt):
 *   PORT, DB_FILE, ADMIN_EMAIL, ADMIN_PASSWORD, SEED_DEMO, DEMO_PASSWORD, BACKUP_KEY,
 *   EVOLUTION_URL, EVOLUTION_INSTANCE, EVOLUTION_API_KEY, WEBHOOK_SECRET
 */
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------- Configuracao de regras de negocio ----------
const CFG = {
  minAdvMin: 60,        // antecedencia minima para agendar (min)
  maxDays: 30,          // janela maxima de agendamento (dias)
  cancelHours: 4,       // cancelar/remarcar ate X horas antes
  feePct: 0.20,         // acrescimo por falta (20% do preco de tabela)
  faltasToleradas: 1,   // 1 falta tolerada por ciclo; da 2a em diante cobra taxa
  pauseMaxDays: 30,     // pausa maxima
  pausesPerYear: 2,     // premissa: 2 pausas por ano
  cycleDays: 30,
  slotStepMin: 30,
};
const PORT = process.env.PORT || 3000;
const DAY = 864e5;

// ---------- Banco de dados ----------
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'barbearia.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
console.log('Banco de dados em:', DB_FILE);

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, nome TEXT NOT NULL, telefone TEXT UNIQUE NOT NULL, email TEXT UNIQUE,
  senha_hash TEXT NOT NULL, papel TEXT NOT NULL CHECK(papel IN ('cliente','profissional','admin')),
  ativo INTEGER NOT NULL DEFAULT 1, data_nascimento TEXT, aceite_termos_em TEXT, opt_in_marketing INTEGER DEFAULT 0,
  criado_em TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expira_em TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS services(id INTEGER PRIMARY KEY, nome TEXT NOT NULL, duracao_min INTEGER NOT NULL, preco REAL NOT NULL, ativo INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS work_hours(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, dia_semana INTEGER NOT NULL, inicio TEXT NOT NULL, fim TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blocks(id INTEGER PRIMARY KEY, barber_id INTEGER, inicio TEXT NOT NULL, fim TEXT NOT NULL, tipo TEXT, motivo TEXT);
CREATE TABLE IF NOT EXISTS plans(id INTEGER PRIMARY KEY, nome TEXT NOT NULL, preco_mensal REAL NOT NULL, creditos INTEGER NOT NULL, ativo INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS subscriptions(
  id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL, plan_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ativa','pausada','inadimplente','cancelada','encerrada')),
  ciclo_inicio TEXT NOT NULL, ciclo_fim TEXT NOT NULL, proximo_vencimento TEXT NOT NULL,
  pausa_inicio TEXT, pausa_fim TEXT, criado_em TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS credit_ledger(
  id INTEGER PRIMARY KEY, subscription_id INTEGER NOT NULL, appointment_id INTEGER,
  tipo TEXT NOT NULL CHECK(tipo IN ('concessao','consumo','estorno','expiracao')),
  quantidade INTEGER NOT NULL, criado_em TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS appointments(
  id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL, barber_id INTEGER NOT NULL, service_id INTEGER NOT NULL,
  inicio TEXT NOT NULL, fim TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('agendado','confirmado','concluido','cancelado','falta','suspenso')),
  origem TEXT DEFAULT 'cliente', usou_credito INTEGER DEFAULT 0, subscription_id INTEGER, valor REAL DEFAULT 0, criado_em TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS transactions(
  id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL, subscription_id INTEGER, appointment_id INTEGER,
  tipo TEXT NOT NULL CHECK(tipo IN ('mensalidade','taxa_falta','avulso')), valor REAL NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pendente','pago','cancelado')), forma TEXT, pago_em TEXT,
  registrado_por INTEGER, criado_em TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY, user_id INTEGER, telefone TEXT NOT NULL, template TEXT, texto TEXT NOT NULL,
  agendada_para TEXT NOT NULL, enviada_em TEXT, status TEXT NOT NULL DEFAULT 'pendente', tentativas INTEGER DEFAULT 0,
  chave TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY, ator_id INTEGER, acao TEXT NOT NULL, entidade TEXT, entidade_id INTEGER, detalhe TEXT, criado_em TEXT NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ag_slot ON appointments(barber_id, inicio) WHERE status IN ('agendado','confirmado');
CREATE INDEX IF NOT EXISTS ix_ag_barber ON appointments(barber_id, inicio);
CREATE INDEX IF NOT EXISTS ix_ag_client ON appointments(client_id, inicio DESC);
CREATE INDEX IF NOT EXISTS ix_ag_status ON appointments(status, inicio);
CREATE INDEX IF NOT EXISTS ix_sub_status ON subscriptions(status, proximo_vencimento);
CREATE INDEX IF NOT EXISTS ix_notif ON notifications(status, agendada_para);
CREATE INDEX IF NOT EXISTS ix_tx_client ON transactions(client_id, status);
CREATE INDEX IF NOT EXISTS ix_ledger ON credit_ledger(subscription_id);
CREATE INDEX IF NOT EXISTS ix_audit ON audit_log(entidade, entidade_id, criado_em);
`);

// ---------- Helpers ----------
const nowIso = () => new Date().toISOString();
const fail = (status, erro) => { throw { status, erro }; };
const normPhone = (p) => { let d = String(p || '').replace(/\D/g, ''); if (d.length <= 11) d = '55' + d; return d; };
const spDate = (d) => new Date(new Date(d).getTime() - 3 * 3600e3).toISOString().slice(0, 10);
const toDate = (date, hm) => new Date(`${date}T${hm}:00-03:00`);
const toMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const fmt = (iso) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const brl = (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ',');

function audit(ator, acao, entidade, id, detalhe) {
  db.prepare('INSERT INTO audit_log(ator_id,acao,entidade,entidade_id,detalhe,criado_em) VALUES(?,?,?,?,?,?)')
    .run(ator || null, acao, entidade, id || null, detalhe ? JSON.stringify(detalhe) : null, nowIso());
}
function enqueue(userId, template, texto, chave = null, quando = nowIso()) {
  const u = db.prepare('SELECT telefone FROM users WHERE id=?').get(userId);
  if (!u) return;
  db.prepare('INSERT OR IGNORE INTO notifications(user_id,telefone,template,texto,agendada_para,chave) VALUES(?,?,?,?,?,?)')
    .run(userId, u.telefone, template, texto, quando, chave);
}
const saldo = (subId) => db.prepare('SELECT COALESCE(SUM(quantidade),0) s FROM credit_ledger WHERE subscription_id=?').get(subId).s;
const ledger = (subId, apptId, tipo, q) =>
  db.prepare('INSERT INTO credit_ledger(subscription_id,appointment_id,tipo,quantidade,criado_em) VALUES(?,?,?,?,?)').run(subId, apptId, tipo, q, nowIso());
const currentSub = (clientId) =>
  db.prepare("SELECT * FROM subscriptions WHERE client_id=? AND status!='encerrada' ORDER BY id DESC LIMIT 1").get(clientId);

// ---------- Seed (so roda na primeira inicializacao, com banco vazio) ----------
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@barbearia.com';
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  let adminPass = process.env.ADMIN_PASSWORD;
  if (!adminPass) {
    adminPass = crypto.randomBytes(9).toString('base64url');
    console.log('==========================================================');
    console.log(' ADMIN_PASSWORD nao definida. Senha gerada para o dono:');
    console.log('   login: ' + ADMIN_EMAIL + '   senha: ' + adminPass);
    console.log(' Anote agora e defina ADMIN_PASSWORD para fixar a senha.');
    console.log('==========================================================');
  }
  const ins = db.prepare('INSERT INTO users(nome,telefone,email,senha_hash,papel,aceite_termos_em,criado_em) VALUES(?,?,?,?,?,?,?)');
  ins.run('Dono', normPhone(process.env.ADMIN_PHONE || '11999990000'), ADMIN_EMAIL, bcrypt.hashSync(adminPass, 10), 'admin', nowIso(), nowIso());

  const sv = db.prepare('INSERT INTO services(nome,duracao_min,preco) VALUES(?,?,?)');
  sv.run('Corte', 30, 40); sv.run('Barba', 30, 30); sv.run('Corte + Barba', 60, 65);
  const pl = db.prepare('INSERT INTO plans(nome,preco_mensal,creditos) VALUES(?,?,?)');
  pl.run('Clube 4 cortes', 120, 4); pl.run('Clube 2 cortes', 70, 2);

  if (process.env.SEED_DEMO === 'true') {
    const demoPass = process.env.DEMO_PASSWORD || '123456';
    const wh = db.prepare('INSERT INTO work_hours(user_id,dia_semana,inicio,fim) VALUES(?,?,?,?)');
    [['Joao Barbeiro', '11977770001', 'joao@barbearia.com'], ['Pedro Barbeiro', '11977770002', 'pedro@barbearia.com']].forEach((b) => {
      const id = ins.run(b[0], normPhone(b[1]), b[2], bcrypt.hashSync(demoPass, 10), 'profissional', nowIso(), nowIso()).lastInsertRowid;
      for (let d = 1; d <= 6; d++) { wh.run(id, d, '09:00', '12:00'); wh.run(id, d, '13:00', '19:00'); }
    });
    ins.run('Cliente Teste', normPhone('11988887777'), 'cliente@teste.com', bcrypt.hashSync(demoPass, 10), 'cliente', nowIso(), nowIso());
    console.log('Usuarios de demonstracao criados (joao@, pedro@barbearia.com e cliente@teste.com).');
  }
  console.log('Banco inicializado.');
}
// Se ADMIN_PASSWORD estiver definida, ela sempre vale (trocar a variavel troca a senha)
if (process.env.ADMIN_PASSWORD) {
  const a = db.prepare("SELECT id,senha_hash FROM users WHERE papel='admin' ORDER BY id LIMIT 1").get();
  if (a && !bcrypt.compareSync(process.env.ADMIN_PASSWORD, a.senha_hash)) {
    db.prepare('UPDATE users SET senha_hash=? WHERE id=?').run(bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10), a.id);
    console.log('Senha do admin atualizada a partir de ADMIN_PASSWORD.');
  }
}

// ---------- Slots disponiveis ----------
function computeSlots(barberId, svc, date, ignoreRules = false) {
  const nowD = new Date();
  if (!ignoreRules && toDate(date, '00:00') > new Date(nowD.getTime() + CFG.maxDays * DAY)) return [];
  const dow = new Date(date + 'T12:00:00-03:00').getUTCDay();
  const wh = db.prepare('SELECT inicio,fim FROM work_hours WHERE user_id=? AND dia_semana=?').all(barberId, dow);
  const dayStart = toDate(date, '00:00'), dayEnd = new Date(dayStart.getTime() + DAY);
  const busy = db.prepare("SELECT inicio,fim FROM appointments WHERE barber_id=? AND status IN ('agendado','confirmado') AND inicio<? AND fim>?")
    .all(barberId, dayEnd.toISOString(), dayStart.toISOString());
  const blocks = db.prepare('SELECT inicio,fim FROM blocks WHERE (barber_id IS NULL OR barber_id=?) AND inicio<? AND fim>?')
    .all(barberId, dayEnd.toISOString(), dayStart.toISOString());
  const occ = [...busy, ...blocks].map((x) => [new Date(x.inicio).getTime(), new Date(x.fim).getTime()]);
  const minStart = ignoreRules ? 0 : nowD.getTime() + CFG.minAdvMin * 60000;
  const out = [];
  for (const w of wh) {
    let t = toDate(date, w.inicio).getTime();
    const end = toDate(date, w.fim).getTime();
    while (t + svc.duracao_min * 60000 <= end) {
      const e = t + svc.duracao_min * 60000;
      if (t >= minStart && !occ.some(([a, b]) => t < b && e > a)) out.push(new Date(t).toISOString());
      t += CFG.slotStepMin * 60000;
    }
  }
  return out;
}

// ---------- Agendar (transacao atomica; better-sqlite3 e sincrono => sem corrida) ----------
const book = db.transaction((clientId, barberId, serviceId, inicioIso, origem) => {
  const svc = db.prepare('SELECT * FROM services WHERE id=? AND ativo=1').get(serviceId);
  if (!svc) fail(404, 'Servico nao encontrado');
  const barber = db.prepare("SELECT * FROM users WHERE id=? AND papel='profissional' AND ativo=1").get(barberId);
  if (!barber) fail(404, 'Profissional nao encontrado');
  const client = db.prepare("SELECT * FROM users WHERE id=? AND papel='cliente' AND ativo=1").get(clientId);
  if (!client) fail(404, 'Cliente nao encontrado');
  const ini = new Date(inicioIso);
  if (isNaN(ini)) fail(400, 'Horario invalido');
  const iniIso = ini.toISOString();
  const fim = new Date(ini.getTime() + svc.duracao_min * 60000);

  const rules = origem === 'cliente';
  if (!computeSlots(barberId, svc, spDate(ini), !rules).includes(iniIso)) fail(409, 'Horario indisponivel');

  const sub = currentSub(clientId);
  if (sub && sub.status === 'inadimplente') fail(403, 'Assinatura inadimplente: regularize o pagamento para agendar');
  if (sub && sub.status === 'pausada') fail(403, 'Assinatura pausada: retome para agendar');
  let usouCredito = 0, valor = svc.preco, subId = null;
  if (sub && ['ativa', 'cancelada'].includes(sub.status) && new Date(sub.ciclo_fim) >= ini && saldo(sub.id) > 0) {
    usouCredito = 1; valor = 0; subId = sub.id;
  }
  let id;
  try {
    id = db.prepare(`INSERT INTO appointments(client_id,barber_id,service_id,inicio,fim,status,origem,usou_credito,subscription_id,valor,criado_em)
      VALUES(?,?,?,?,?,'agendado',?,?,?,?,?)`).run(clientId, barberId, serviceId, iniIso, fim.toISOString(), origem, usouCredito, subId, valor, nowIso()).lastInsertRowid;
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) fail(409, 'Horario acabou de ser ocupado');
    throw e;
  }
  if (usouCredito) ledger(subId, id, 'consumo', -1);
  audit(clientId, 'agendamento.criar', 'appointment', id, { barberId, serviceId, inicio: iniIso, usouCredito });
  enqueue(clientId, 'confirmacao', `Ola ${client.nome.split(' ')[0]}! Agendamento confirmado: ${svc.nome} com ${barber.nome} em ${fmt(iniIso)}.` +
    (usouCredito ? ' (1 credito utilizado)' : ''));
  return id;
});

const cancelAppt = db.transaction((id, actor, force) => {
  const a = db.prepare('SELECT * FROM appointments WHERE id=?').get(id);
  if (!a) fail(404, 'Agendamento nao encontrado');
  if (!['agendado', 'confirmado', 'suspenso'].includes(a.status)) fail(400, 'Agendamento nao pode ser cancelado');
  if (!force && a.status !== 'suspenso' && new Date(a.inicio) - Date.now() < CFG.cancelHours * 3600e3)
    fail(400, `Cancelamento permitido ate ${CFG.cancelHours}h antes do horario`);
  db.prepare("UPDATE appointments SET status='cancelado' WHERE id=?").run(id);
  if (a.usou_credito && a.subscription_id) ledger(a.subscription_id, id, 'estorno', 1);
  audit(actor.id, 'agendamento.cancelar', 'appointment', id, { force: !!force });
  enqueue(a.client_id, 'cancelamento', `Seu agendamento de ${fmt(a.inicio)} foi cancelado.` + (a.usou_credito ? ' Seu credito foi devolvido.' : ''));
  return a;
});

// ---------- Assinaturas ----------
function reactivateSuspended(clientId) {
  const list = db.prepare("SELECT * FROM appointments WHERE client_id=? AND status='suspenso' AND inicio>? ORDER BY inicio").all(clientId, nowIso());
  const sub = currentSub(clientId);
  for (const a of list) {
    const conflict = db.prepare("SELECT 1 FROM appointments WHERE barber_id=? AND status IN ('agendado','confirmado') AND inicio<? AND fim>?").get(a.barber_id, a.fim, a.inicio);
    let ok = !conflict;
    if (ok && a.usou_credito) {
      ok = sub && saldo(sub.id) > 0 && new Date(sub.ciclo_fim) >= new Date(a.inicio);
      if (ok) { ledger(sub.id, a.id, 'consumo', -1); db.prepare('UPDATE appointments SET subscription_id=? WHERE id=?').run(sub.id, a.id); }
    }
    db.prepare('UPDATE appointments SET status=? WHERE id=?').run(ok ? 'agendado' : 'cancelado', a.id);
  }
}

const createSub = db.transaction((clientId, planId, forma, actor) => {
  const plan = db.prepare('SELECT * FROM plans WHERE id=? AND ativo=1').get(planId);
  if (!plan) fail(404, 'Plano nao encontrado');
  if (currentSub(clientId)) fail(409, 'Cliente ja possui assinatura vigente');
  const ini = new Date(), fim = new Date(ini.getTime() + CFG.cycleDays * DAY);
  const id = db.prepare("INSERT INTO subscriptions(client_id,plan_id,status,ciclo_inicio,ciclo_fim,proximo_vencimento,criado_em) VALUES(?,?,'ativa',?,?,?,?)")
    .run(clientId, planId, ini.toISOString(), fim.toISOString(), fim.toISOString(), nowIso()).lastInsertRowid;
  ledger(id, null, 'concessao', plan.creditos);
  db.prepare("INSERT INTO transactions(client_id,subscription_id,tipo,valor,status,forma,pago_em,registrado_por,criado_em) VALUES(?,?,'mensalidade',?,'pago',?,?,?,?)")
    .run(clientId, id, plan.preco_mensal, forma || 'pix', nowIso(), actor.id, nowIso());
  audit(actor.id, 'assinatura.criar', 'subscription', id, { planId, clientId });
  enqueue(clientId, 'assinatura', `Assinatura ${plan.nome} ativada! Voce tem ${plan.creditos} creditos ate ${fmt(fim)}.`);
  return id;
});

const renewSub = db.transaction((subId, forma, actor) => {
  const s = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(subId);
  if (!s) fail(404, 'Assinatura nao encontrada');
  if (!['ativa', 'inadimplente'].includes(s.status)) fail(400, 'Assinatura nao pode ser renovada neste status');
  const plan = db.prepare('SELECT * FROM plans WHERE id=?').get(s.plan_id);
  let ini;
  if (s.status === 'inadimplente') ini = new Date();
  else {
    if (new Date(s.ciclo_fim) - Date.now() > 3 * DAY) fail(400, 'Renovacao antecipada so nos 3 ultimos dias do ciclo');
    ini = new Date(s.ciclo_fim);
  }
  const fim = new Date(ini.getTime() + CFG.cycleDays * DAY);
  const left = saldo(subId);
  if (left > 0) ledger(subId, null, 'expiracao', -left); // creditos nao acumulam
  ledger(subId, null, 'concessao', plan.creditos);
  db.prepare("UPDATE subscriptions SET status='ativa',ciclo_inicio=?,ciclo_fim=?,proximo_vencimento=? WHERE id=?").run(ini.toISOString(), fim.toISOString(), fim.toISOString(), subId);
  db.prepare("INSERT INTO transactions(client_id,subscription_id,tipo,valor,status,forma,pago_em,registrado_por,criado_em) VALUES(?,?,'mensalidade',?,'pago',?,?,?,?)")
    .run(s.client_id, subId, plan.preco_mensal, forma || 'pix', nowIso(), actor.id, nowIso());
  reactivateSuspended(s.client_id);
  audit(actor.id, 'assinatura.renovar', 'subscription', subId, { forma, estado_anterior: s.status });
  enqueue(s.client_id, 'renovacao', `Pagamento confirmado! Assinatura renovada com ${plan.creditos} creditos ate ${fmt(fim)}.`);
});

const pauseSub = db.transaction((subId, actor) => {
  const s = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(subId);
  if (!s) fail(404, 'Assinatura nao encontrada');
  if (s.status !== 'ativa') fail(400, 'So e possivel pausar assinatura ativa');
  const year = new Date().getFullYear() + '-01-01';
  const n = db.prepare("SELECT COUNT(*) n FROM audit_log WHERE acao='assinatura.pausar' AND entidade_id=? AND criado_em>=?").get(subId, year).n;
  if (n >= CFG.pausesPerYear) fail(400, `Limite de ${CFG.pausesPerYear} pausas por ano atingido`);
  const futuros = db.prepare("SELECT id FROM appointments WHERE client_id=? AND status IN ('agendado','confirmado') AND inicio>?").all(s.client_id, nowIso());
  futuros.forEach((a) => cancelAppt(a.id, actor, true)); // credito devolvido e congelado
  const fim = new Date(Date.now() + CFG.pauseMaxDays * DAY);
  db.prepare("UPDATE subscriptions SET status='pausada',pausa_inicio=?,pausa_fim=? WHERE id=?").run(nowIso(), fim.toISOString(), subId);
  audit(actor.id, 'assinatura.pausar', 'subscription', subId, { ate: fim.toISOString(), cancelados: futuros.length });
  enqueue(s.client_id, 'pausa', `Assinatura pausada ate ${fmt(fim)}. Seus agendamentos futuros foram cancelados e os creditos devolvidos.`);
});

const resumeSub = db.transaction((subId, actor) => {
  const s = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(subId);
  if (!s || s.status !== 'pausada') fail(400, 'Assinatura nao esta pausada');
  const dur = Date.now() - new Date(s.pausa_inicio).getTime();
  const fim = new Date(new Date(s.ciclo_fim).getTime() + dur).toISOString(); // ciclo estendido
  db.prepare("UPDATE subscriptions SET status='ativa',ciclo_fim=?,proximo_vencimento=?,pausa_inicio=NULL,pausa_fim=NULL WHERE id=?").run(fim, fim, subId);
  audit(actor ? actor.id : null, 'assinatura.retomar', 'subscription', subId, { novo_fim: fim });
  enqueue(s.client_id, 'retomada', `Assinatura retomada! Novo vencimento: ${fmt(fim)}.`);
});

function setDelinquent(s) {
  db.transaction(() => {
    db.prepare("UPDATE subscriptions SET status='inadimplente' WHERE id=?").run(s.id);
    db.prepare("UPDATE appointments SET status='suspenso' WHERE client_id=? AND status IN ('agendado','confirmado') AND inicio>?").run(s.client_id, nowIso());
    audit(null, 'assinatura.inadimplente', 'subscription', s.id, null);
    enqueue(s.client_id, 'cobranca_d0', 'Sua mensalidade venceu e o acesso ao agendamento foi bloqueado. Regularize o pagamento para voltar a agendar.', `d0:${s.id}:${s.proximo_vencimento}`);
  })();
}

// ---------- WhatsApp (Evolution API) ----------
async function sendWhats(phone, text) {
  if (!process.env.EVOLUTION_URL) { console.log(`[WHATSAPP simulado] -> ${phone}: ${text}`); return 'simulada'; }
  const base = process.env.EVOLUTION_URL.replace(/\/+$/, '');
  const r = await fetch(`${base}/message/sendText/${process.env.EVOLUTION_INSTANCE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: process.env.EVOLUTION_API_KEY || '' },
    body: JSON.stringify({ number: phone, text }),
  });
  if (!r.ok) throw new Error('Evolution HTTP ' + r.status);
  return 'enviada';
}
let sending = false;
async function processQueue() {
  if (sending) return; sending = true;
  try {
    const rows = db.prepare("SELECT * FROM notifications WHERE status='pendente' AND agendada_para<=? AND tentativas<3 ORDER BY id LIMIT 20").all(nowIso());
    for (const n of rows) {
      try {
        const st = await sendWhats(n.telefone, n.texto);
        db.prepare('UPDATE notifications SET status=?,enviada_em=?,tentativas=tentativas+1 WHERE id=?').run(st, nowIso(), n.id);
      } catch (e) {
        db.prepare("UPDATE notifications SET tentativas=tentativas+1,status=CASE WHEN tentativas+1>=3 THEN 'falha' ELSE 'pendente' END WHERE id=?").run(n.id);
        console.error('Falha ao enviar notificacao', n.id, e.message);
      }
      if (process.env.EVOLUTION_URL) await new Promise((r) => setTimeout(r, 1500 + Math.random() * 2500)); // intervalo aleatorio anti-ban
    }
  } finally { sending = false; }
}

// ---------- Cron interno (a cada 60s). Idempotente: usa chave unica nas notificacoes ----------
function tick() {
  try {
    const n = nowIso();
    db.prepare('DELETE FROM sessions WHERE expira_em<?').run(n);
    db.prepare("SELECT id FROM subscriptions WHERE status='pausada' AND pausa_fim<=?").all(n).forEach((s) => resumeSub(s.id, null));
    db.prepare("SELECT * FROM subscriptions WHERE status='ativa' AND proximo_vencimento<?").all(n).forEach(setDelinquent);
    db.prepare("UPDATE subscriptions SET status='encerrada' WHERE status='cancelada' AND ciclo_fim<?").run(n);
    // Cobranca D-3 e D+3
    db.prepare("SELECT * FROM subscriptions WHERE status='ativa' AND proximo_vencimento BETWEEN ? AND ?").all(n, new Date(Date.now() + 3 * DAY).toISOString())
      .forEach((s) => enqueue(s.client_id, 'cobranca_d3', `Sua mensalidade vence em ${fmt(s.proximo_vencimento)}. Combine o pagamento com a barbearia para manter seus creditos.`, `dm3:${s.id}:${s.proximo_vencimento}`));
    db.prepare("SELECT * FROM subscriptions WHERE status='inadimplente' AND proximo_vencimento<?").all(new Date(Date.now() - 3 * DAY).toISOString())
      .forEach((s) => enqueue(s.client_id, 'cobranca_d3p', 'Sua assinatura segue em atraso. Regularize para voltar a agendar com creditos.', `dp3:${s.id}:${s.proximo_vencimento}`));
    // Lembretes 24h e 2h (so se o agendamento foi criado com antecedencia maior que a janela)
    const appts = db.prepare("SELECT a.*,s.nome servico FROM appointments a JOIN services s ON s.id=a.service_id WHERE a.status IN ('agendado','confirmado') AND a.inicio>? AND a.inicio<=?")
      .all(n, new Date(Date.now() + 24 * 3600e3).toISOString());
    for (const a of appts) {
      const ms = new Date(a.inicio) - Date.now(), antec = new Date(a.inicio) - new Date(a.criado_em);
      if (ms <= 24 * 3600e3 && antec > 24 * 3600e3)
        enqueue(a.client_id, 'lembrete_24h', `Lembrete: ${a.servico} amanha, ${fmt(a.inicio)}. Responda 1 para CONFIRMAR ou 2 para CANCELAR.`, `l24:${a.id}`);
      if (ms <= 2 * 3600e3 && antec > 2 * 3600e3)
        enqueue(a.client_id, 'lembrete_2h', `Lembrete: seu horario (${a.servico}) e hoje as ${fmt(a.inicio).slice(-5)}. Te esperamos!`, `l2:${a.id}`);
    }
    processQueue();
  } catch (e) { console.error('Erro no cron', e); }
}
const cronTimer = setInterval(tick, 60000);
setTimeout(tick, 2000);

// ---------- App HTTP ----------
const app = express();
app.set('trust proxy', 1); // atras do proxy do Render/Railway: IP real para o rate limit
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '100kb' }));

// Health check (usado pela hospedagem e por monitores de uptime)
app.get('/healthz', (req, res) => {
  try { db.prepare('SELECT 1').get(); res.json({ ok: true, hora: nowIso() }); }
  catch (e) { res.status(500).json({ ok: false }); }
});

// Backup do banco (so funciona se BACKUP_KEY estiver definida): /backup?key=SUA_CHAVE
app.get('/backup', async (req, res) => {
  const k = process.env.BACKUP_KEY;
  if (!k || req.query.key !== k) return res.sendStatus(404);
  const tmp = path.join(os.tmpdir(), `backup-${Date.now()}.db`);
  try {
    await db.backup(tmp);
    res.download(tmp, `barbearia-backup-${nowIso().slice(0, 10)}.db`, () => fs.unlink(tmp, () => {}));
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Falha no backup' }); }
});

app.use(express.static(path.join(__dirname, 'public')));

function auth(roles) {
  return (req, res, next) => {
    const t = (req.headers.authorization || '').replace('Bearer ', '');
    const u = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expira_em>? AND u.ativo=1').get(t, nowIso());
    if (!u) return res.status(401).json({ erro: 'Sessao invalida' });
    if (roles && !roles.includes(u.papel)) return res.status(403).json({ erro: 'Sem permissao' });
    req.user = u; next();
  };
}
const publicUser = (u) => ({ id: u.id, nome: u.nome, telefone: u.telefone, email: u.email, papel: u.papel });
function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id,expira_em) VALUES(?,?,?)').run(token, userId, new Date(Date.now() + 14 * DAY).toISOString());
  return token;
}
const loginAttempts = new Map(); // rate limit simples
function rateLimit(key) {
  const now = Date.now(); const arr = (loginAttempts.get(key) || []).filter((t) => now - t < 15 * 60000);
  if (arr.length >= 10) fail(429, 'Muitas tentativas. Aguarde 15 minutos.');
  arr.push(now); loginAttempts.set(key, arr);
}

// --- Autenticacao
app.post('/api/auth/register', (req, res) => {
  const { nome, telefone, email, senha, aceite_termos, opt_in, data_nascimento } = req.body || {};
  if (!nome || !telefone || !senha || senha.length < 6) fail(400, 'Informe nome, telefone e senha (min. 6 caracteres)');
  if (!aceite_termos) fail(400, 'E necessario aceitar os termos (inclui regra de faltas)');
  const tel = normPhone(telefone);
  if (db.prepare('SELECT 1 FROM users WHERE telefone=? OR (email IS NOT NULL AND email=?)').get(tel, email || null)) fail(409, 'Telefone ou e-mail ja cadastrado');
  const id = db.prepare("INSERT INTO users(nome,telefone,email,senha_hash,papel,aceite_termos_em,opt_in_marketing,data_nascimento,criado_em) VALUES(?,?,?,?,'cliente',?,?,?,?)")
    .run(nome.trim(), tel, email || null, bcrypt.hashSync(senha, 10), nowIso(), opt_in ? 1 : 0, data_nascimento || null, nowIso()).lastInsertRowid;
  audit(id, 'cliente.cadastro', 'user', id, null);
  res.json({ token: newSession(id) });
});
app.post('/api/auth/login', (req, res) => {
  const { login, senha } = req.body || {};
  rateLimit(req.ip + ':' + (login || ''));
  const u = db.prepare('SELECT * FROM users WHERE (email=? OR telefone=?) AND ativo=1').get(login || '', normPhone(login));
  if (!u || !bcrypt.compareSync(senha || '', u.senha_hash)) fail(401, 'Login ou senha invalidos');
  res.json({ token: newSession(u.id), user: publicUser(u) });
});
app.post('/api/auth/logout', auth(), (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token=?').run((req.headers.authorization || '').replace('Bearer ', '')); res.json({ ok: true });
});

function subView(s) {
  if (!s) return null;
  const p = db.prepare('SELECT * FROM plans WHERE id=?').get(s.plan_id);
  return { ...s, plano: p.nome, preco_mensal: p.preco_mensal, creditos_plano: p.creditos, saldo: saldo(s.id) };
}
app.get('/api/me', auth(), (req, res) => {
  const u = req.user;
  const out = { user: publicUser(u) };
  if (u.papel === 'cliente') {
    out.assinatura = subView(currentSub(u.id));
    out.pendencias = db.prepare("SELECT * FROM transactions WHERE client_id=? AND status='pendente' ORDER BY id DESC").all(u.id);
  }
  res.json(out);
});

// --- Catalogo
app.get('/api/services', auth(), (req, res) => res.json(db.prepare('SELECT * FROM services WHERE ativo=1 ORDER BY nome').all()));
app.get('/api/barbers', auth(), (req, res) => res.json(db.prepare("SELECT id,nome FROM users WHERE papel='profissional' AND ativo=1 ORDER BY nome").all()));
app.get('/api/plans', auth(), (req, res) => res.json(db.prepare('SELECT * FROM plans WHERE ativo=1 ORDER BY preco_mensal').all()));
app.get('/api/slots', auth(), (req, res) => {
  const { barber_id, service_id, date } = req.query;
  if (!isDate(date)) fail(400, 'Data invalida');
  const svc = db.prepare('SELECT * FROM services WHERE id=? AND ativo=1').get(service_id);
  if (!svc) fail(404, 'Servico nao encontrado');
  res.json(computeSlots(Number(barber_id), svc, date, req.user.papel === 'admin' && req.query.admin === '1'));
});

// --- Agendamentos
const APPT_SELECT = `SELECT a.*,s.nome servico,c.nome cliente,c.telefone cliente_telefone,b.nome barbeiro
  FROM appointments a JOIN services s ON s.id=a.service_id JOIN users c ON c.id=a.client_id JOIN users b ON b.id=a.barber_id`;
app.get('/api/appointments', auth(), (req, res) => {
  const u = req.user;
  if (u.papel === 'cliente') return res.json(db.prepare(APPT_SELECT + ' WHERE a.client_id=? ORDER BY a.inicio DESC LIMIT 50').all(u.id));
  const { date } = req.query;
  if (!isDate(date)) fail(400, 'Data invalida');
  const a = toDate(date, '00:00').toISOString(), b = new Date(toDate(date, '00:00').getTime() + DAY).toISOString();
  const rows = u.papel === 'profissional'
    ? db.prepare(APPT_SELECT + ' WHERE a.inicio>=? AND a.inicio<? AND a.barber_id=? ORDER BY a.inicio').all(a, b, u.id)
    : db.prepare(APPT_SELECT + ' WHERE a.inicio>=? AND a.inicio<? ORDER BY a.inicio').all(a, b);
  res.json(rows);
});
app.post('/api/appointments', auth(), (req, res) => {
  const { barber_id, service_id, inicio, client_id } = req.body || {};
  const u = req.user;
  let cid = u.id, origem = 'cliente';
  if (u.papel !== 'cliente') { if (u.papel !== 'admin') fail(403, 'Sem permissao'); cid = Number(client_id); origem = 'admin'; }
  const id = book(cid, Number(barber_id), Number(service_id), inicio, origem);
  res.json({ id });
});
app.post('/api/appointments/:id/cancel', auth(), (req, res) => {
  const a = db.prepare('SELECT * FROM appointments WHERE id=?').get(req.params.id);
  if (!a) fail(404, 'Agendamento nao encontrado');
  const u = req.user;
  if (u.papel === 'cliente' && a.client_id !== u.id) fail(403, 'Sem permissao');
  if (u.papel === 'profissional' && a.barber_id !== u.id) fail(403, 'Sem permissao');
  cancelAppt(a.id, u, u.papel !== 'cliente');
  res.json({ ok: true });
});
const setStatus = db.transaction((id, status, actor) => {
  const a = db.prepare('SELECT a.*,s.preco,s.nome servico FROM appointments a JOIN services s ON s.id=a.service_id WHERE a.id=?').get(id);
  if (!a) fail(404, 'Agendamento nao encontrado');
  if (actor.papel === 'profissional' && a.barber_id !== actor.id) fail(403, 'Sem permissao');
  if (!['agendado', 'confirmado'].includes(a.status)) fail(400, 'Status atual nao permite alteracao');
  db.prepare('UPDATE appointments SET status=? WHERE id=?').run(status, id);
  audit(actor.id, 'agendamento.' + status, 'appointment', id, null);
  let taxa = 0;
  if (status === 'concluido' && !a.usou_credito) {
    db.prepare("INSERT INTO transactions(client_id,appointment_id,tipo,valor,status,criado_em) VALUES(?,?,'avulso',?,'pendente',?)").run(a.client_id, id, a.preco, nowIso());
  }
  if (status === 'falta') {
    // O credito ja foi consumido no agendamento (e nao estornado). Conta faltas no ciclo atual (ou ultimos 30 dias).
    const sub = currentSub(a.client_id);
    const desde = sub ? sub.ciclo_inicio : new Date(Date.now() - 30 * DAY).toISOString();
    const n = db.prepare("SELECT COUNT(*) n FROM appointments WHERE client_id=? AND status='falta' AND inicio>=?").get(a.client_id, desde).n;
    if (n > CFG.faltasToleradas) {
      taxa = +(a.preco * CFG.feePct).toFixed(2);
      db.prepare("INSERT INTO transactions(client_id,subscription_id,appointment_id,tipo,valor,status,criado_em) VALUES(?,?,?,'taxa_falta',?,'pendente',?)")
        .run(a.client_id, sub ? sub.id : null, id, taxa, nowIso());
      audit(actor.id, 'taxa_falta.criar', 'appointment', id, { valor: taxa, faltas_no_ciclo: n });
    }
    enqueue(a.client_id, 'falta', taxa
      ? `Voce faltou ao horario de ${fmt(a.inicio)}. Foi aplicada taxa de ${brl(taxa)} (20% do servico), a ser paga no proximo atendimento.`
      : `Voce faltou ao horario de ${fmt(a.inicio)}. Esta falta foi tolerada; nas proximas havera acrescimo de 20%.`);
  }
  return taxa;
});
app.post('/api/appointments/:id/status', auth(['admin', 'profissional']), (req, res) => {
  const { status } = req.body || {};
  if (!['concluido', 'falta'].includes(status)) fail(400, 'Status invalido');
  res.json({ taxa: setStatus(Number(req.params.id), status, req.user) });
});

// --- Assinatura (cliente ou admin)
function subOwnerOrAdmin(req) {
  const s = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(req.params.id);
  if (!s) fail(404, 'Assinatura nao encontrada');
  if (req.user.papel === 'cliente' && s.client_id !== req.user.id) fail(403, 'Sem permissao');
  if (req.user.papel === 'profissional') fail(403, 'Sem permissao');
  return s;
}
app.post('/api/subscriptions/:id/pause', auth(), (req, res) => { const s = subOwnerOrAdmin(req); pauseSub(s.id, req.user); res.json({ ok: true }); });
app.post('/api/subscriptions/:id/resume', auth(), (req, res) => { const s = subOwnerOrAdmin(req); resumeSub(s.id, req.user); res.json({ ok: true }); });
app.post('/api/subscriptions/:id/cancel', auth(), (req, res) => {
  const s = subOwnerOrAdmin(req);
  if (!['ativa', 'pausada', 'inadimplente'].includes(s.status)) fail(400, 'Assinatura nao pode ser cancelada');
  const novo = s.status === 'inadimplente' ? 'encerrada' : 'cancelada'; // acesso ate o fim do ciclo pago, sem reembolso
  db.prepare('UPDATE subscriptions SET status=? WHERE id=?').run(novo, s.id);
  audit(req.user.id, 'assinatura.cancelar', 'subscription', s.id, { novo });
  res.json({ ok: true, status: novo });
});

// --- Admin
const admin = auth(['admin']);
app.post('/api/admin/subscriptions', admin, (req, res) => {
  const { client_id, plan_id, forma } = req.body || {};
  res.json({ id: createSub(Number(client_id), Number(plan_id), forma, req.user) });
});
app.post('/api/admin/subscriptions/:id/pay', admin, (req, res) => { renewSub(Number(req.params.id), (req.body || {}).forma, req.user); res.json({ ok: true }); });
app.get('/api/admin/clients', admin, (req, res) => {
  const rows = db.prepare("SELECT id,nome,telefone,email,criado_em FROM users WHERE papel='cliente' ORDER BY nome").all();
  res.json(rows.map((c) => ({
    ...c, assinatura: subView(currentSub(c.id)),
    pendente: db.prepare("SELECT COALESCE(SUM(valor),0) v FROM transactions WHERE client_id=? AND status='pendente'").get(c.id).v,
    faltas: db.prepare("SELECT COUNT(*) n FROM appointments WHERE client_id=? AND status='falta'").get(c.id).n,
    atendimentos: db.prepare("SELECT COUNT(*) n FROM appointments WHERE client_id=? AND status='concluido'").get(c.id).n,
  })));
});
app.get('/api/admin/transactions', admin, (req, res) => {
  const st = req.query.status || 'pendente';
  res.json(db.prepare('SELECT t.*,u.nome cliente FROM transactions t JOIN users u ON u.id=t.client_id WHERE t.status=? ORDER BY t.id DESC LIMIT 100').all(st));
});
app.post('/api/admin/transactions/:id/pay', admin, (req, res) => {
  const t = db.prepare('SELECT * FROM transactions WHERE id=?').get(req.params.id);
  if (!t || t.status !== 'pendente') fail(400, 'Transacao nao esta pendente');
  db.prepare("UPDATE transactions SET status='pago',forma=?,pago_em=?,registrado_por=? WHERE id=?").run((req.body || {}).forma || 'pix', nowIso(), req.user.id, t.id);
  audit(req.user.id, 'transacao.pagar', 'transaction', t.id, { valor: t.valor });
  res.json({ ok: true });
});
app.post('/api/admin/transactions/:id/cancel', admin, (req, res) => { // estorno/perdao de taxa
  const t = db.prepare('SELECT * FROM transactions WHERE id=?').get(req.params.id);
  if (!t || t.status !== 'pendente') fail(400, 'Transacao nao esta pendente');
  db.prepare("UPDATE transactions SET status='cancelado' WHERE id=?").run(t.id);
  audit(req.user.id, 'transacao.cancelar', 'transaction', t.id, { valor: t.valor });
  res.json({ ok: true });
});
app.post('/api/admin/services', admin, (req, res) => {
  const { id, nome, duracao_min, preco, ativo } = req.body || {};
  if (!nome || !(duracao_min > 0) || !(preco >= 0)) fail(400, 'Dados invalidos');
  if (id) db.prepare('UPDATE services SET nome=?,duracao_min=?,preco=?,ativo=? WHERE id=?').run(nome, duracao_min, preco, ativo === 0 ? 0 : 1, id);
  else db.prepare('INSERT INTO services(nome,duracao_min,preco) VALUES(?,?,?)').run(nome, duracao_min, preco);
  audit(req.user.id, 'servico.salvar', 'service', id, { nome, preco }); res.json({ ok: true });
});
app.post('/api/admin/plans', admin, (req, res) => {
  const { id, nome, preco_mensal, creditos, ativo } = req.body || {};
  if (!nome || !(preco_mensal >= 0) || !(creditos > 0)) fail(400, 'Dados invalidos');
  if (id) db.prepare('UPDATE plans SET nome=?,preco_mensal=?,creditos=?,ativo=? WHERE id=?').run(nome, preco_mensal, creditos, ativo === 0 ? 0 : 1, id);
  else db.prepare('INSERT INTO plans(nome,preco_mensal,creditos) VALUES(?,?,?)').run(nome, preco_mensal, creditos);
  audit(req.user.id, 'plano.salvar', 'plan', id, { nome, preco_mensal }); res.json({ ok: true });
});
app.post('/api/admin/barbers', admin, (req, res) => {
  const { nome, telefone, email, senha } = req.body || {};
  if (!nome || !telefone || !senha || senha.length < 6) fail(400, 'Dados invalidos');
  const tel = normPhone(telefone);
  if (db.prepare('SELECT 1 FROM users WHERE telefone=? OR (email IS NOT NULL AND email=?)').get(tel, email || null)) fail(409, 'Telefone ou e-mail ja cadastrado');
  const id = db.prepare("INSERT INTO users(nome,telefone,email,senha_hash,papel,aceite_termos_em,criado_em) VALUES(?,?,?,?,'profissional',?,?)")
    .run(nome, tel, email || null, bcrypt.hashSync(senha, 10), nowIso(), nowIso()).lastInsertRowid;
  const wh = db.prepare('INSERT INTO work_hours(user_id,dia_semana,inicio,fim) VALUES(?,?,?,?)');
  for (let d = 1; d <= 6; d++) { wh.run(id, d, '09:00', '12:00'); wh.run(id, d, '13:00', '19:00'); }
  audit(req.user.id, 'profissional.criar', 'user', id, { nome }); res.json({ id });
});
app.get('/api/admin/blocks', admin, (req, res) => res.json(db.prepare('SELECT b.*,u.nome barbeiro FROM blocks b LEFT JOIN users u ON u.id=b.barber_id WHERE b.fim>? ORDER BY b.inicio').all(nowIso())));
app.post('/api/admin/blocks', admin, (req, res) => {
  const { barber_id, inicio, fim, tipo, motivo } = req.body || {};
  const a = new Date(inicio), b = new Date(fim);
  if (isNaN(a) || isNaN(b) || b <= a) fail(400, 'Periodo invalido');
  const bid = barber_id ? Number(barber_id) : null;
  const id = db.prepare('INSERT INTO blocks(barber_id,inicio,fim,tipo,motivo) VALUES(?,?,?,?,?)').run(bid, a.toISOString(), b.toISOString(), tipo || 'pessoal', motivo || null).lastInsertRowid;
  // agendamentos ja existentes no periodo bloqueado: o cliente e avisado para escolher novo horario
  // (CORRIGIDO: parametros numerados ?1/?2/?3 em vez de misturar ? com ?1)
  const afetados = db.prepare("SELECT a.*,s.nome servico FROM appointments a JOIN services s ON s.id=a.service_id WHERE a.status IN ('agendado','confirmado') AND a.inicio<?1 AND a.fim>?2 AND (?3 IS NULL OR a.barber_id=?3)")
    .all(b.toISOString(), a.toISOString(), bid);
  afetados.forEach((x) => enqueue(x.client_id, 'conflito_bloqueio', `Precisamos reagendar seu horario de ${fmt(x.inicio)} (${x.servico}). Acesse o app e escolha um novo horario (cancelamento sem perda de credito).`, `blk:${id}:${x.id}`));
  audit(req.user.id, 'bloqueio.criar', 'block', id, { afetados: afetados.map((x) => x.id) });
  res.json({ id, afetados: afetados.length });
});
app.delete('/api/admin/blocks/:id', admin, (req, res) => { db.prepare('DELETE FROM blocks WHERE id=?').run(req.params.id); audit(req.user.id, 'bloqueio.remover', 'block', Number(req.params.id), null); res.json({ ok: true }); });
app.get('/api/admin/audit', admin, (req, res) => res.json(db.prepare('SELECT l.*,u.nome ator FROM audit_log l LEFT JOIN users u ON u.id=l.ator_id ORDER BY l.id DESC LIMIT 50').all()));
app.get('/api/admin/notifications', admin, (req, res) => res.json(db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 50').all()));

app.get('/api/admin/dashboard', admin, (req, res) => {
  const from = new Date(Date.now() - 30 * DAY), fromIso = from.toISOString();
  const cnt = (st) => db.prepare('SELECT COUNT(*) n FROM appointments WHERE status=? AND inicio>=? AND inicio<=?').get(st, fromIso, nowIso()).n;
  const concl = cnt('concluido'), falta = cnt('falta');
  const cancel = db.prepare("SELECT COUNT(*) n FROM appointments WHERE status='cancelado' AND inicio>=? AND inicio<=?").get(fromIso, nowIso()).n;
  // taxa de ocupacao = minutos reservados / minutos de expediente (ultimos 30 dias)
  let cap = 0;
  const barbers = db.prepare("SELECT id FROM users WHERE papel='profissional' AND ativo=1").all();
  for (let i = 0; i < 30; i++) {
    const d = new Date(from.getTime() + i * DAY), dow = new Date(spDate(d) + 'T12:00:00-03:00').getUTCDay();
    for (const b of barbers) for (const w of db.prepare('SELECT inicio,fim FROM work_hours WHERE user_id=? AND dia_semana=?').all(b.id, dow)) cap += toMin(w.fim) - toMin(w.inicio);
  }
  const booked = db.prepare("SELECT COALESCE(SUM((julianday(fim)-julianday(inicio))*1440),0) m FROM appointments WHERE status IN ('concluido','falta','agendado','confirmado') AND inicio>=? AND inicio<=?").get(fromIso, nowIso()).m;
  const ativas = db.prepare("SELECT s.*,p.preco_mensal FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.status IN ('ativa','pausada')").all();
  const mrr = ativas.filter((s) => s.status === 'ativa').reduce((a, s) => a + s.preco_mensal, 0);
  const canc30 = db.prepare("SELECT COUNT(*) n FROM audit_log WHERE acao='assinatura.cancelar' AND criado_em>=?").get(fromIso).n;
  const churn = ativas.length + canc30 ? canc30 / (ativas.length + canc30) : 0;
  const ticket = ativas.length ? mrr / ativas.length : 0;
  const receita = db.prepare("SELECT COALESCE(SUM(valor),0) v FROM transactions WHERE status='pago' AND pago_em>=?").get(fromIso).v;
  const pend = db.prepare("SELECT COALESCE(SUM(valor),0) v FROM transactions WHERE status='pendente'").get().v;
  res.json({
    periodo: 'ultimos 30 dias', atendimentos: concl, faltas: falta, cancelados: cancel,
    taxa_no_show: concl + falta ? falta / (concl + falta) : 0,
    taxa_ocupacao: cap ? Math.min(1, booked / cap) : 0,
    assinaturas_ativas: ativas.filter((s) => s.status === 'ativa').length,
    inadimplentes: db.prepare("SELECT COUNT(*) n FROM subscriptions WHERE status='inadimplente'").get().n,
    mrr, churn, ltv: churn > 0 ? ticket / churn : null, receita_recebida: receita, pendente_receber: pend,
  });
});

// --- Webhook do WhatsApp (Evolution API): 1 = confirma, 2 = cancela
function handleReply(phoneRaw, text) {
  const phone = normPhone(phoneRaw);
  const u = db.prepare("SELECT * FROM users WHERE telefone=? AND papel='cliente'").get(phone);
  if (!u) return;
  const a = db.prepare("SELECT * FROM appointments WHERE client_id=? AND status IN ('agendado','confirmado') AND inicio>? ORDER BY inicio LIMIT 1").get(u.id, nowIso());
  const t = text.trim();
  if (!a || !['1', '2'].includes(t)) return;
  if (t === '1') {
    db.prepare("UPDATE appointments SET status='confirmado' WHERE id=?").run(a.id);
    audit(u.id, 'agendamento.confirmar_whatsapp', 'appointment', a.id, null);
    enqueue(u.id, 'resp_confirma', `Presenca confirmada para ${fmt(a.inicio)}. Ate la!`);
  } else {
    try { cancelAppt(a.id, u, false); }
    catch (e) { enqueue(u.id, 'resp_cancela_negada', `Nao foi possivel cancelar: ${e.erro || 'erro'}.`); }
  }
}
app.post('/api/webhooks/whatsapp', (req, res) => {
  if (process.env.WEBHOOK_SECRET && req.query.secret !== process.env.WEBHOOK_SECRET) return res.sendStatus(401);
  const d = (req.body && req.body.data) || req.body || {};
  if (d.key && d.key.fromMe) return res.sendStatus(200);
  const jid = (d.key && d.key.remoteJid) || d.phone || '';
  const text = (d.message && (d.message.conversation || (d.message.extendedTextMessage || {}).text)) || d.text || '';
  try { handleReply(String(jid).split('@')[0], String(text)); } catch (e) { console.error(e); }
  res.sendStatus(200);
});

app.use('/api', (req, res) => res.status(404).json({ erro: 'Rota nao encontrada' }));
app.use((err, req, res, next) => { // eslint-disable-line
  if (err && err.erro) return res.status(err.status || 400).json({ erro: err.erro });
  console.error(err);
  res.status(500).json({ erro: 'Erro interno' });
});

const server = app.listen(PORT, '0.0.0.0', () => console.log(`Barbearia MVP rodando na porta ${PORT}`));

// Encerramento limpo (deploys e reinicios nao corrompem o SQLite)
function shutdown() {
  console.log('Encerrando...');
  clearInterval(cronTimer);
  server.close(() => { try { db.close(); } catch (e) { /* ignore */ } process.exit(0); });
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
