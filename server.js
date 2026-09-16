const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

// ===== REINOS DE AÇO V10 — CONTAS, POSTGRESQL E RECUPERAÇÃO POR WHATSAPP =====
const crypto = require('crypto');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const RECOVERY_SECRET = process.env.RECOVERY_SECRET || 'REINOS-DE-ACO-TROQUE-ESTE-SEGREDO';
const ADMIN_WHATSAPP = (process.env.ADMIN_WHATSAPP || '5544997270282').replace(/\D/g, '');
if (!DATABASE_URL) console.warn('⚠️ DATABASE_URL não configurada. Cadastros e contas precisam de PostgreSQL.');
if (!process.env.RECOVERY_SECRET) console.warn('⚠️ RECOVERY_SECRET não configurado. Defina um segredo forte no Render.');
const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10
}) : null;

const AUTH_SESSION_DAYS = 30;
const RESET_MINUTES = 10;
const RESET_MAX_ATTEMPTS = 5;

function normalizePhone(v) {
  let s = String(v ?? '').replace(/\D/g, '');
  if (s.startsWith('00')) s = s.slice(2);
  if (s.length === 10 || s.length === 11) s = '55' + s;
  return s;
}
function validPhone(s) { return /^\d{11,15}$/.test(s); }
function validPassword(s) { return typeof s === 'string' && s.length >= 6 && s.length <= 128; }
function validNick(s) { return typeof s === 'string' && /^[\p{L}\p{N}_ .-]{3,20}$/u.test(s.trim()); }
function genId(prefix='RA') { return prefix + '-' + crypto.randomBytes(5).toString('hex').toUpperCase(); }
function randomCode() { return String(crypto.randomInt(100000, 1000000)); }
function sha256(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function recoveryCode(accountId) {
  const h = crypto.createHmac('sha256', RECOVERY_SECRET).update(String(accountId)).digest('hex').toUpperCase();
  return 'RA-' + h.slice(0, 4) + '-' + h.slice(4, 8) + '-' + h.slice(8, 12);
}
function whatsappUrlForRecovery(account) {
  const code = recoveryCode(account.id);
  const text = `Olá, quero recuperar minha conta do Reinos de Aço.%0A🆔 ID: ${encodeURIComponent(account.id)}%0A👤 Nick: ${encodeURIComponent(account.nick)}%0A🔐 Código de recuperação: ${encodeURIComponent(code)}`;
  return `https://wa.me/${ADMIN_WHATSAPP}?text=${text}`;
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  try {
    const [, salt, hex] = String(stored).split('$');
    if (!salt || !hex) return false;
    const got = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(got,'hex'), Buffer.from(hex,'hex'));
  } catch { return false; }
}
function authTokenFromRequest(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}
async function getSessionAccount(token) {
  if (!pool || !token) return null;
  const q = await pool.query(`SELECT a.id,a.nick,a.phone,a.verified,a.active_character_id FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>NOW()`, [sha256(token)]);
  return q.rows[0] || null;
}
async function createSession(accountId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,NOW()+($3 || ' days')::interval)`, [sha256(token), accountId, AUTH_SESSION_DAYS]);
  return token;
}
async function sendWhatsAppCode(phone, code) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const template = process.env.WHATSAPP_AUTH_TEMPLATE || 'reinos_codigo';
  const language = process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'pt_BR';
  if (!token || !phoneNumberId) throw new Error('WhatsApp Cloud API não configurada no Render.');
  const version = process.env.WHATSAPP_GRAPH_VERSION || 'v23.0';
  const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;
  // O template precisa estar aprovado na Meta. Ele deve receber o código como variável do corpo.
  const payload = {
    messaging_product: 'whatsapp', to: phone, type: 'template',
    template: { name: template, language: { code: language }, components: [
      { type: 'body', parameters: [{ type: 'text', text: code }] }
    ]}
  };
  const r = await fetch(url, { method:'POST', headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'}, body:JSON.stringify(payload) });
  const body = await r.text();
  if (!r.ok) throw new Error(`WhatsApp API ${r.status}: ${body.slice(0,500)}`);
  return true;
}
async function initDatabase() {
  if (!pool) return;
  try { await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`); } catch(e) { console.warn('pgcrypto:', e.message); }
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS account_id_seq START WITH 1;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id VARCHAR(32) PRIMARY KEY,
      phone VARCHAR(20) UNIQUE NOT NULL,
      nick VARCHAR(20) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      verified BOOLEAN NOT NULL DEFAULT FALSE,
      active_character_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS characters (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id VARCHAR(32) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name VARCHAR(20) NOT NULL,
      class_key VARCHAR(20) NOT NULL,
      color VARCHAR(7) NOT NULL DEFAULT '#39eaff',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_characters_account ON characters(account_id);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash CHAR(64) PRIMARY KEY,
      account_id VARCHAR(32) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS password_reset_codes (
      id BIGSERIAL PRIMARY KEY,
      account_id VARCHAR(32) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      code_hash CHAR(64) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_reset_account ON password_reset_codes(account_id, created_at DESC);
  `);
}
async function publicProfileById(id) {
  if (!pool) return null;
  const q = await pool.query(`SELECT id,nick,created_at,verified,active_character_id FROM accounts WHERE id=$1`, [id]);
  if (!q.rows[0]) return null;
  const a=q.rows[0];
  const c=await pool.query(`SELECT id,name,class_key,color,created_at FROM characters WHERE account_id=$1 ORDER BY created_at ASC`,[id]);
  return {id:a.id,nick:a.nick,verified:a.verified,createdAt:a.created_at,online:!!getSocketIdByUserId(a.id),characters:c.rows.map(x=>({id:x.id,name:x.name,classe:x.class_key,color:x.color,createdAt:x.created_at}))};
}
async function publicProfilesSearch(query) {
  if (!pool) return [];
  const s=String(query||'').trim(); if(!s) return [];
  const q=await pool.query(`SELECT id,nick,created_at,verified FROM accounts WHERE id=$1 OR nick ILIKE $2 ORDER BY nick LIMIT 10`,[s,s+'%']);
  const out=[]; for(const a of q.rows){ const p=await publicProfileById(a.id); if(p) out.push(p); } return out;
}
async function getCharacter(accountId, charId) {
  if (!pool || !charId) return null;
  const q=await pool.query(`SELECT id,name,class_key,color FROM characters WHERE id=$1 AND account_id=$2`,[charId,accountId]);
  return q.rows[0] || null;
}
async function getCharacters(accountId) {
  if (!pool) return [];
  const q=await pool.query(`SELECT id,name,class_key,color,created_at FROM characters WHERE account_id=$1 ORDER BY created_at ASC`,[accountId]);
  return q.rows;
}


const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: true, credentials: false, methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'] }
});

// CORS para GitHub Pages, arquivo local (origin "null") e outros clientes do jogo.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '100kb' }));

function requireDatabase(res) {
  if (!pool) {
    res.status(503).json({ error: 'Banco de dados não configurado. No Render, conecte um PostgreSQL e defina DATABASE_URL.' });
    return false;
  }
  return true;
}

async function accountResponse(account) {
  const chars = await getCharacters(account.id);
  return {
    id: account.id,
    nick: account.nick,
    phone: account.phone,
    verified: !!account.verified,
    activeCharacterId: account.active_character_id || null
  , characters: chars
  };
}

// ===== AUTENTICAÇÃO HTTP =====
app.post('/api/auth/register', async (req, res) => {
  if (!requireDatabase(res)) return;
  try {
    const nick = safeText(req.body?.nick, 20).trim();
    const phone = normalizePhone(req.body?.phone);
    const password = String(req.body?.password || '');
    if (!validNick(nick)) return res.status(400).json({ error: 'Nick inválido. Use 3 a 20 caracteres.' });
    if (!validPhone(phone)) return res.status(400).json({ error: 'Número de WhatsApp inválido.' });
    if (!validPassword(password)) return res.status(400).json({ error: 'A senha precisa ter pelo menos 6 caracteres.' });

    const exists = await pool.query('SELECT id FROM accounts WHERE phone=$1 OR LOWER(nick)=LOWER($2) LIMIT 1', [phone, nick]);
    if (exists.rows[0]) return res.status(409).json({ error: 'Esse WhatsApp ou Nick já está cadastrado.' });

    let id;
    for (let i=0;i<5;i++) {
      const q = await pool.query("SELECT LPAD(nextval('account_id_seq')::text,6,'0') AS id");
      const candidate = q.rows[0].id;
      const used = await pool.query('SELECT 1 FROM accounts WHERE id=$1', [candidate]);
      if (!used.rows[0]) { id = candidate; break; }
    }
    if (!id) return res.status(500).json({ error: 'Não foi possível gerar o ID da conta.' });

    const q = await pool.query('INSERT INTO accounts(id,phone,nick,password_hash) VALUES($1,$2,$3,$4) RETURNING id,nick,phone,verified,active_character_id', [id,phone,nick,hashPassword(password)]);
    const account = q.rows[0];
    const token = await createSession(account.id);
    const recovery = recoveryCode(account.id);
    res.json({ token, account: await accountResponse(account), recoveryCode: recovery, whatsappUrl: whatsappUrlForRecovery(account) });
  } catch (e) {
    console.error('register:', e);
    if (e.code === '23505') return res.status(409).json({ error: 'WhatsApp ou Nick já cadastrado.' });
    res.status(500).json({ error: 'Erro ao criar conta.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  if (!requireDatabase(res)) return;
  try {
    const login = String(req.body?.login || '').trim();
    const password = String(req.body?.password || '');
    if (!login || !password) return res.status(400).json({ error: 'Informe o WhatsApp/Nick e a senha.' });
    const phone = normalizePhone(login);
    const q = await pool.query('SELECT id,nick,phone,verified,active_character_id,password_hash FROM accounts WHERE phone=$1 OR LOWER(nick)=LOWER($2) LIMIT 1', [phone, login]);
    const account = q.rows[0];
    if (!account || !verifyPassword(password, account.password_hash)) return res.status(401).json({ error: 'WhatsApp/Nick ou senha incorretos.' });
    const token = await createSession(account.id);
    res.json({ token, account: await accountResponse(account) });
  } catch (e) { console.error('login:',e); res.status(500).json({ error:'Erro ao entrar na conta.' }); }
});

app.get('/api/me', async (req, res) => {
  if (!requireDatabase(res)) return;
  try {
    const account = await getSessionAccount(authTokenFromRequest(req));
    if (!account) return res.status(401).json({ error:'Sessão inválida ou expirada.' });
    res.json({ account: await accountResponse(account), characters: await getCharacters(account.id) });
  } catch(e) { console.error('me:',e); res.status(500).json({error:'Erro ao carregar conta.'}); }
});

app.post('/api/auth/request-reset', async (req, res) => {
  if (!requireDatabase(res)) return;
  try {
    const phone = normalizePhone(req.body?.phone);
    if (!validPhone(phone)) return res.status(400).json({error:'Número de WhatsApp inválido.'});
    const q = await pool.query('SELECT id,nick,phone FROM accounts WHERE phone=$1 LIMIT 1',[phone]);
    if (!q.rows[0]) return res.status(404).json({error:'Não encontramos uma conta com esse WhatsApp.'});
    const account=q.rows[0];
    // Não envia automaticamente pela API. Apenas abre o WhatsApp do administrador
    // com a mensagem pronta, exatamente como o botão de compra de diamantes.
    res.json({message:'WhatsApp aberto com sua solicitação pronta. Envie a mensagem para continuar.', whatsappUrl:whatsappUrlForRecovery(account), id:account.id});
  } catch(e) { console.error('request-reset:',e); res.status(500).json({error:'Erro ao preparar a recuperação.'}); }
});

app.post('/api/auth/reset-password', async (req, res) => {
  if (!requireDatabase(res)) return;
  try {
    const phone = normalizePhone(req.body?.phone);
    const code = String(req.body?.code || '').trim().toUpperCase();
    const newPassword = String(req.body?.newPassword || '');
    if (!validPhone(phone) || !validPassword(newPassword)) return res.status(400).json({error:'Número ou nova senha inválidos.'});
    const q = await pool.query('SELECT id,nick,phone,verified,active_character_id FROM accounts WHERE phone=$1 LIMIT 1',[phone]);
    const account=q.rows[0];
    if (!account) return res.status(404).json({error:'Conta não encontrada.'});
    if (code !== recoveryCode(account.id)) return res.status(401).json({error:'Código de recuperação incorreto.'});
    await pool.query('UPDATE accounts SET password_hash=$1,updated_at=NOW() WHERE id=$2',[hashPassword(newPassword),account.id]);
    await pool.query('DELETE FROM sessions WHERE account_id=$1',[account.id]);
    const token=await createSession(account.id);
    res.json({message:'Senha alterada com sucesso.',token,account:await accountResponse(account)});
  } catch(e) { console.error('reset-password:',e); res.status(500).json({error:'Erro ao alterar a senha.'}); }
});

app.get('/api/profile', async (req,res)=>{
  if (!requireDatabase(res)) return;
  try { res.json({profiles:await publicProfilesSearch(req.query?.q)}); }
  catch(e){console.error('profile:',e);res.status(500).json({error:'Erro ao consultar perfil.'});}
});

app.post('/api/characters', async (req,res)=>{
  if (!requireDatabase(res)) return;
  try {
    const account=await getSessionAccount(authTokenFromRequest(req)); if(!account)return res.status(401).json({error:'Sessão inválida.'});
    const name=safeText(req.body?.name,20).trim(), classe=safeText(req.body?.classe,20), color=safeText(req.body?.color,7);
    const allowed=['guerreiro','mago','arqueiro','duelista'];
    if(!/^[\p{L}\p{N}_ .-]{2,20}$/u.test(name)||!allowed.includes(classe)||!/^#[0-9a-fA-F]{6}$/.test(color))return res.status(400).json({error:'Nome, classe ou cor inválidos.'});
    const count=await pool.query('SELECT COUNT(*)::int AS n FROM characters WHERE account_id=$1',[account.id]); if(count.rows[0].n>=8)return res.status(400).json({error:'Limite de 8 personagens por conta.'});
    const q=await pool.query('INSERT INTO characters(account_id,name,class_key,color) VALUES($1,$2,$3,$4) RETURNING id,name,class_key,color,created_at',[account.id,name,classe,color]);
    if(!account.active_character_id)await pool.query('UPDATE accounts SET active_character_id=$1 WHERE id=$2',[q.rows[0].id,account.id]);
    res.json({character:q.rows[0]});
  } catch(e){console.error('character create:',e);res.status(500).json({error:'Não foi possível criar o personagem.'});}
});

app.post('/api/characters/select', async (req,res)=>{
  if (!requireDatabase(res)) return;
  try { const account=await getSessionAccount(authTokenFromRequest(req)); if(!account)return res.status(401).json({error:'Sessão inválida.'}); const c=await getCharacter(account.id,req.body?.id); if(!c)return res.status(404).json({error:'Personagem não encontrado.'}); await pool.query('UPDATE accounts SET active_character_id=$1,updated_at=NOW() WHERE id=$2',[c.id,account.id]); res.json({character:c}); }
  catch(e){console.error('character select:',e);res.status(500).json({error:'Não foi possível selecionar o personagem.'});}
});

app.get('/', (req, res) => {
  res.send('Reinos de Aço - Servidor Multiplayer Online ⚔️');
});

const players = {};
const profiles = {};
const friends = {};       // friends[userId] = Set(userId)
const friendRequests = {}; // friendRequests[userId] = Set(userId)
const teams = {};         // teams[teamId] = team
const invites = {};       // invites[userId] = [{type,...}]
const rooms = {};          // rooms[roomId] = room

function safeText(value, max = 180) {
  return String(value ?? '').trim().slice(0, max);
}

function publicPlayer(socketId) {
  const p = players[socketId];
  if (!p) return null;

  return {
    id: p.id,
    userId: p.userId,
    x: Number(p.x) || 0,
    y: Number(p.y) || 0,
    classe: p.classe || 'guerreiro',
    facing: p.facing || 1,
    nome: p.nome || 'Guerreiro',
    name: p.nome || 'Guerreiro',
    local: p.local || 'lobby',
    status: p.status || 'online',
    teamId: p.teamId || null,
    characterId: p.characterId || null,
    color: p.characterColor || '#39eaff'
  };
}

function emitPlayers() {
  const result = {};
  for (const id of Object.keys(players)) {
    result[id] = publicPlayer(id);
  }
  io.emit('updatePlayers', result);
}

function getSocketIdByUserId(userId) {
  for (const id of Object.keys(players)) {
    if (players[id].userId === userId) return id;
  }
  return null;
}

function sendToUser(userId, event, data) {
  const socketId = getSocketIdByUserId(userId);
  if (socketId) io.to(socketId).emit(event, data);
}

function ensureUserData(userId, nome) {
  if (!profiles[userId]) {
    profiles[userId] = {
      id: userId,
      nome: nome || 'Guerreiro',
      createdAt: Date.now()
    };
  } else if (nome) {
    profiles[userId].nome = nome;
  }

  if (!friends[userId]) friends[userId] = new Set();
  if (!friendRequests[userId]) friendRequests[userId] = new Set();
  if (!invites[userId]) invites[userId] = [];
}

function friendsList(userId) {
  ensureUserData(userId);

  return [...friends[userId]].map(id => {
    const socketId = getSocketIdByUserId(id);
    const profile = profiles[id] || { id, nome: 'Guerreiro' };
    return {
      id,
      nome: profile.nome,
      online: !!socketId,
      socketId: socketId || null,
      player: socketId ? publicPlayer(socketId) : null
    };
  });
}

function sendSocialState(userId) {
  ensureUserData(userId);

  const requests = [...friendRequests[userId]].map(id => ({
    id,
    nome: profiles[id]?.nome || 'Guerreiro',
    online: !!getSocketIdByUserId(id)
  }));

  const myTeam = Object.values(teams).find(t => t.members.includes(userId)) || null;

  sendToUser(userId, 'socialState', {
    friends: friendsList(userId),
    requests,
    invites: invites[userId],
    team: myTeam ? {
      id: myTeam.id,
      nome: myTeam.nome,
      lider: myTeam.lider,
      members: myTeam.members.map(id => ({
        id,
        nome: profiles[id]?.nome || 'Guerreiro',
        online: !!getSocketIdByUserId(id)
      }))
    } : null
  });
}

function notifyFriendsOnline(userId) {
  ensureUserData(userId);
  for (const friendId of friends[userId]) {
    sendSocialState(friendId);
  }
}

function removeFromRoom(userId) {
  for (const roomId of Object.keys(rooms)) {
    const room = rooms[roomId];
    if (!room.players.includes(userId)) continue;

    room.players = room.players.filter(id => id !== userId);
    const sid = getSocketIdByUserId(userId);
    if (sid) io.sockets.sockets.get(sid)?.leave(roomId);
    if (room.players.length === 0) {
      delete rooms[roomId];
    } else {
      io.to(roomId).emit('roomUpdate', room);
    }
  }
}

io.use(async (socket, next) => {
  try {
    if (!pool) return next(new Error('Banco de dados não configurado.'));
    const token = String(socket.handshake.auth?.token || '');
    const account = await getSessionAccount(token);
    if (!account) return next(new Error('Sessão inválida.'));
    socket.data.account = account;
    next();
  } catch (e) { next(new Error('Falha na autenticação.')); }
});

io.on('connection', (socket) => {
  console.log('Novo guerreiro conectou:', socket.id);

  socket.on('join', async (data = {}) => {
    const account=socket.data.account;
    if(!account) return socket.emit('socialError',{message:'Faça login para jogar.'});
    const char=await getCharacter(account.id, data.characterId || account.active_character_id);
    const nome = safeText(char?.name || account.nick, 24) || account.nick || 'Guerreiro';
    const userId = account.id;

    // Se a mesma conta conectar novamente, substitui a conexão antiga.
    const oldSocketId = getSocketIdByUserId(userId);
    if (oldSocketId && oldSocketId !== socket.id) {
      delete players[oldSocketId];
    }

    ensureUserData(userId, nome);

    players[socket.id] = {
      id: socket.id,
      userId,
      x: Number(data.x) || 0,
      y: Number(data.y) || 0,
      classe: char?.class_key || data.classe || 'guerreiro',
      facing: data.facing || 1,
      nome,
      local: data.local || 'lobby',
      status: 'online',
      teamId: null,
      characterId: char?.id || null,
      characterColor: char?.color || '#39eaff'
    };

    socket.data.userId = userId;
    socket.emit('connectedInfo', {
      socketId: socket.id,
      userId,
      nome,
      characterId: char?.id || null,
      characterColor: char?.color || '#39eaff'
    });

    sendSocialState(userId);
    emitPlayers();
    notifyFriendsOnline(userId);

    console.log(`${nome} entrou online (${socket.id})`);
  });


  socket.on('profileLookup', async (data={})=>{
    try{ const q=safeText(data.query,40); const profiles=await publicProfilesSearch(q); socket.emit('profileLookupResult',{query:q,profiles}); }
    catch(e){ socket.emit('socialError',{message:'Erro ao consultar perfil.'}); }
  });

  socket.on('myCharacters', async ()=>{ try{socket.emit('myCharactersResult',{characters:await getCharacters(socket.data.account.id)});}catch(e){socket.emit('socialError',{message:'Erro ao carregar personagens.'});} });

  socket.on('createCharacter', async (data={})=>{
    try{
      const account=socket.data.account, name=safeText(data.name,20), classe=safeText(data.classe,20), color=safeText(data.color,7);
      const allowed=['guerreiro','mago','arqueiro','duelista'];
      if(!/^[\p{L}\p{N}_ .-]{2,20}$/u.test(name)||!allowed.includes(classe)||!/^#[0-9a-fA-F]{6}$/.test(color))return socket.emit('socialError',{message:'Nome, classe ou cor inválidos.'});
      const count=await pool.query('SELECT COUNT(*)::int AS n FROM characters WHERE account_id=$1',[account.id]); if(count.rows[0].n>=8)return socket.emit('socialError',{message:'Limite de 8 personagens por conta.'});
      const q=await pool.query('INSERT INTO characters(account_id,name,class_key,color) VALUES($1,$2,$3,$4) RETURNING id,name,class_key,color,created_at',[account.id,name,classe,color]);
      if(!account.active_character_id){await pool.query('UPDATE accounts SET active_character_id=$1 WHERE id=$2',[q.rows[0].id,account.id]);account.active_character_id=q.rows[0].id;}
      socket.emit('characterCreated',{character:q.rows[0]});
    }catch(e){console.error(e);socket.emit('socialError',{message:'Não foi possível criar o personagem.'});}
  });

  socket.on('selectCharacter', async (data={})=>{
    try{const account=socket.data.account,c=await getCharacter(account.id,data.id);if(!c)return socket.emit('socialError',{message:'Personagem não encontrado.'});await pool.query('UPDATE accounts SET active_character_id=$1 WHERE id=$2',[c.id,account.id]);account.active_character_id=c.id;socket.data.characterId=c.id;socket.emit('characterSelected',{character:c});}
    catch(e){socket.emit('socialError',{message:'Não foi possível selecionar o personagem.'});}
  });

  socket.on('move', (data = {}) => {
    const p = players[socket.id];
    if (!p) return;

    p.x = Number(data.x) || 0;
    p.y = Number(data.y) || 0;
    p.facing = data.facing || p.facing;
    if (data.local) p.local = safeText(data.local, 30);

    // Mantém o mesmo evento usado pelo jogo atual.
    emitPlayers();
  });

  socket.on('setLocation', (data = {}) => {
    const p = players[socket.id];
    if (!p) return;

    p.local = safeText(data.local, 30) || 'lobby';
    emitPlayers();
  });

  // =========================
  // CHAT
  // =========================
  socket.on('chatMessage', (data = {}) => {
    const p = players[socket.id];
    if (!p) return;

    const text = safeText(data.text, 180);
    if (!text) return;

    io.emit('chatMessage', {
      id: socket.id,
      userId: p.userId,
      nome: p.nome,
      classe: p.classe,
      text,
      local: p.local || 'lobby',
      time: Date.now()
    });
  });

  // =========================
  // AMIZADES
  // =========================
  socket.on('friendRequest', (data = {}) => {
    const from = players[socket.id];
    const targetId = safeText(data.userId, 80);
    if (!from || !targetId || targetId === from.userId) return;

    ensureUserData(from.userId, from.nome);
    ensureUserData(targetId);

    if (friends[from.userId].has(targetId)) {
      socket.emit('socialError', { message: 'Vocês já são amigos.' });
      return;
    }

    friendRequests[targetId].add(from.userId);

    sendToUser(targetId, 'friendRequestReceived', {
      id: from.userId,
      nome: from.nome,
      online: true
    });

    sendSocialState(targetId);
    sendSocialState(from.userId);
  });

  socket.on('friendRequestRespond', (data = {}) => {
    const me = players[socket.id];
    const fromId = safeText(data.userId, 80);
    const accept = !!data.accept;

    if (!me || !fromId) return;
    ensureUserData(me.userId);
    ensureUserData(fromId);

    friendRequests[me.userId].delete(fromId);

    if (accept) {
      friends[me.userId].add(fromId);
      friends[fromId].add(me.userId);

      sendToUser(fromId, 'friendAccepted', {
        id: me.userId,
        nome: me.nome
      });
    }

    sendSocialState(me.userId);
    sendSocialState(fromId);
  });

  socket.on('removeFriend', (data = {}) => {
    const me = players[socket.id];
    const otherId = safeText(data.userId, 80);
    if (!me || !otherId) return;

    friends[me.userId]?.delete(otherId);
    friends[otherId]?.delete(me.userId);

    sendSocialState(me.userId);
    sendSocialState(otherId);
  });

  // =========================
  // TIMES
  // =========================
  socket.on('createTeam', (data = {}) => {
    const p = players[socket.id];
    if (!p) return;

    const oldTeam = Object.values(teams).find(t => t.members.includes(p.userId));
    if (oldTeam) {
      socket.emit('socialError', { message: 'Você já está em um time.' });
      return;
    }

    const nome = safeText(data.nome, 28) || 'Time de Aço';
    const teamId = `team_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    teams[teamId] = {
      id: teamId,
      nome,
      lider: p.userId,
      members: [p.userId],
      createdAt: Date.now()
    };

    p.teamId = teamId;

    socket.emit('teamCreated', {
      id: teamId,
      nome
    });

    sendSocialState(p.userId);
    emitPlayers();
  });

  socket.on('teamInvite', (data = {}) => {
    const p = players[socket.id];
    const targetId = safeText(data.userId, 80);
    if (!p || !targetId) return;

    const team = Object.values(teams).find(t => t.members.includes(p.userId));
    if (!team || team.lider !== p.userId) {
      socket.emit('socialError', { message: 'Somente o líder pode convidar para o time.' });
      return;
    }

    if (team.members.length >= 6) {
      socket.emit('socialError', { message: 'O time já está cheio (máximo 6 jogadores).' });
      return;
    }

    ensureUserData(targetId);

    invites[targetId] = invites[targetId] || [];
    invites[targetId] = invites[targetId].filter(i => !(i.type === 'team' && i.teamId === team.id));
    invites[targetId].push({
      type: 'team',
      teamId: team.id,
      teamNome: team.nome,
      fromId: p.userId,
      fromNome: p.nome,
      createdAt: Date.now()
    });

    sendToUser(targetId, 'teamInviteReceived', invites[targetId][invites[targetId].length - 1]);
    sendSocialState(targetId);
  });

  socket.on('teamInviteRespond', (data = {}) => {
    const p = players[socket.id];
    const teamId = safeText(data.teamId, 100);
    const accept = !!data.accept;

    if (!p || !teamId) return;

    const team = teams[teamId];
    if (!team) {
      socket.emit('socialError', { message: 'Esse time não existe mais.' });
      return;
    }

    invites[p.userId] = (invites[p.userId] || []).filter(i =>
      !(i.type === 'team' && i.teamId === teamId)
    );

    if (accept) {
      const currentTeam = Object.values(teams).find(t => t.members.includes(p.userId));

      if (currentTeam) {
        socket.emit('socialError', { message: 'Você já está em um time.' });
      } else if (team.members.length >= 6) {
        socket.emit('socialError', { message: 'O time está cheio.' });
      } else {
        team.members.push(p.userId);
        p.teamId = teamId;
      }
    }

    sendSocialState(p.userId);
    for (const memberId of team.members) sendSocialState(memberId);
    emitPlayers();
  });

  socket.on('teamKick', (data = {}) => {
    const p = players[socket.id];
    const targetId = safeText(data.userId, 80);
    if (!p || !targetId || targetId === p.userId) return;

    const team = Object.values(teams).find(t => t.members.includes(p.userId));
    if (!team || team.lider !== p.userId) {
      socket.emit('socialError', { message: 'Somente o líder pode expulsar membros.' });
      return;
    }
    if (!team.members.includes(targetId)) return;

    team.members = team.members.filter(id => id !== targetId);
    const targetSocket = getSocketIdByUserId(targetId);
    if (targetSocket && players[targetSocket]) players[targetSocket].teamId = null;

    sendToUser(targetId, 'teamKicked', { teamId: team.id, teamNome: team.nome });
    sendSocialState(targetId);
    for (const memberId of team.members) sendSocialState(memberId);
    emitPlayers();
  });

  socket.on('leaveTeam', () => {
    const p = players[socket.id];
    if (!p) return;

    const team = Object.values(teams).find(t => t.members.includes(p.userId));
    if (!team) return;

    if (team.lider === p.userId) {
      // Passa a liderança para outro membro ou encerra o time.
      const remaining = team.members.filter(id => id !== p.userId);

      if (remaining.length === 0) {
        delete teams[team.id];
      } else {
        team.members = remaining;
        team.lider = remaining[0];
      }
    } else {
      team.members = team.members.filter(id => id !== p.userId);
    }

    p.teamId = null;

    sendSocialState(p.userId);
    if (teams[team.id]) {
      for (const memberId of teams[team.id].members) sendSocialState(memberId);
    }
    emitPlayers();
  });

  // =========================
  // CONVITES PARA MODOS
  // =========================
  socket.on('gameInvite', (data = {}) => {
    const p = players[socket.id];
    const targetId = safeText(data.userId, 80);
    const mode = safeText(data.mode, 30);

    const allowed = ['campaign', 'survival', 'arena1v1', 'arena2v2', 'arena3v3'];
    if (!p || !targetId || !allowed.includes(mode)) return;

    ensureUserData(targetId);

    const invite = {
      type: 'game',
      mode,
      fromId: p.userId,
      fromNome: p.nome,
      createdAt: Date.now()
    };

    invites[targetId] = invites[targetId] || [];
    invites[targetId].push(invite);

    sendToUser(targetId, 'gameInviteReceived', invite);
    sendSocialState(targetId);
  });

  socket.on('gameInviteRespond', (data = {}) => {
    const p = players[socket.id];
    if (!p) return;

    const fromId = safeText(data.fromId, 80);
    const mode = safeText(data.mode, 30);
    const accept = !!data.accept;

    if (accept) {
      const roomId = `room_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      rooms[roomId] = {
        id: roomId,
        mode,
        host: fromId,
        players: [fromId, p.userId],
        maxPlayers: mode === 'arena1v1' ? 2 :
                    mode === 'arena2v2' ? 4 :
                    mode === 'arena3v3' ? 6 : 4,
        status: 'waiting',
        createdAt: Date.now()
      };

      for (const userId of rooms[roomId].players) {
        const sid = getSocketIdByUserId(userId);
        if (sid) {
          io.sockets.sockets.get(sid)?.join(roomId);
          io.to(sid).emit('gameRoomCreated', rooms[roomId]);
        }
      }
    }

    invites[p.userId] = (invites[p.userId] || []).filter(i =>
      !(i.type === 'game' && i.fromId === fromId && i.mode === mode)
    );

    sendSocialState(p.userId);
  });

  // =========================
  // SALAS / X1 / 2v2 / 3v3
  // =========================
  socket.on('createRoom', (data = {}) => {
    const p = players[socket.id];
    if (!p) return;

    const mode = safeText(data.mode, 30);
    const allowed = ['arena1v1', 'arena2v2', 'arena3v3', 'campaign', 'survival'];
    if (!allowed.includes(mode)) return;

    const maxPlayers = {
      arena1v1: 2,
      arena2v2: 4,
      arena3v3: 6,
      campaign: 4,
      survival: 4
    }[mode];

    const roomId = `room_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const team = Object.values(teams).find(t => t.members.includes(p.userId));
    let roomPlayers = [p.userId];
    // Para 2v2/3v3/campanha/sobrevivência, o líder pode levar automaticamente
    // os companheiros online do próprio time, respeitando o limite da sala.
    if (data.useTeam && team) {
      const candidates = team.members.filter(id => id !== p.userId && getSocketIdByUserId(id));
      roomPlayers = roomPlayers.concat(candidates.slice(0, Math.max(0, maxPlayers - 1)));
    }

    rooms[roomId] = {
      id: roomId,
      mode,
      host: p.userId,
      players: roomPlayers,
      maxPlayers,
      status: roomPlayers.length >= maxPlayers ? 'ready' : 'waiting',
      createdAt: Date.now()
    };

    for (const userId of roomPlayers) {
      const sid = getSocketIdByUserId(userId);
      if (sid) {
        io.sockets.sockets.get(sid)?.join(roomId);
        io.to(sid).emit('gameRoomCreated', rooms[roomId]);
      }
    }
    io.to(roomId).emit('roomUpdate', rooms[roomId]);
    if (rooms[roomId].status === 'ready') io.to(roomId).emit('roomReady', rooms[roomId]);
  });

  socket.on('joinRoom', (data = {}) => {
    const p = players[socket.id];
    const roomId = safeText(data.roomId, 100);
    if (!p || !rooms[roomId]) return;

    const room = rooms[roomId];

    if (room.players.includes(p.userId)) {
      socket.join(roomId);
      socket.emit('roomUpdate', room);
      return;
    }

    if (room.players.length >= room.maxPlayers) {
      socket.emit('socialError', { message: 'Essa sala está cheia.' });
      return;
    }

    room.players.push(p.userId);
    socket.join(roomId);

    io.to(roomId).emit('roomUpdate', room);

    if (room.players.length >= room.maxPlayers) {
      room.status = 'ready';
      io.to(roomId).emit('roomReady', room);
    }
  });

  socket.on('leaveRoom', (data = {}) => {
    const p = players[socket.id];
    const roomId = safeText(data.roomId, 100);
    if (!p || !rooms[roomId]) return;

    const room = rooms[roomId];
    room.players = room.players.filter(id => id !== p.userId);
    socket.leave(roomId);

    if (room.players.length === 0) {
      delete rooms[roomId];
    } else {
      if (room.host === p.userId) room.host = room.players[0];
      io.to(roomId).emit('roomUpdate', room);
    }
  });

  socket.on('startRoom', (data = {}) => {
    const p = players[socket.id];
    const roomId = safeText(data.roomId, 100);
    if (!p || !rooms[roomId]) return;

    const room = rooms[roomId];
    if (room.host !== p.userId) return;
    if (['arena1v1','arena2v2','arena3v3'].includes(room.mode) && room.players.length < 2) {
      socket.emit('socialError', { message: 'Adicione pelo menos mais um jogador antes de iniciar.' });
      return;
    }

    room.status = 'started';
    io.to(roomId).emit('gameStart', room);
  });

  // =========================
  // DESCONEXÃO
  // =========================
  socket.on('disconnect', () => {
    const p = players[socket.id];

    if (p) {
      console.log('Guerreiro desconectou:', socket.id, p.nome);

      removeFromRoom(p.userId);
      if (profiles[p.userId]) profiles[p.userId].lastSeen = Date.now();
      delete players[socket.id];

      emitPlayers();
      notifyFriendsOnline(p.userId);
    } else {
      console.log('Guerreiro desconectou:', socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;

initDatabase().then(()=>{
  server.listen(PORT, () => {
    console.log(`Servidor Reinos de Aço V10 rodando na porta ${PORT}`);
  });
}).catch(err=>{
  console.error('❌ Falha ao iniciar banco:',err);
  process.exit(1);
});
