const express = require('express');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST','OPTIONS'] } });
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req,res,next)=>{ res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization'); res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,OPTIONS'); if(req.method==='OPTIONS')return res.sendStatus(204); next(); });

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.RECOVERY_SECRET || process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if(!DATABASE_URL) console.warn('⚠️ DATABASE_URL não configurado. As contas não poderão ser persistidas.');
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 }) : null;

const DEFAULT_PROGRESS = {
  playerClass:null, characterColor:'#39eaff', gold:0, diamantes:0, codigosUsados:[], activeQuest:null,
  questProgress:0, questTarget:0, questReward:0, questName:'', boosts:{xpTime:0}, xp:0, level:1,
  attributePoints:0, attributes:{strength:0,defense:0,vitality:0,agility:0}, weapons:[], equippedWeapon:null,
  hats:[], equippedHat:null, capes:[], equippedCape:null, skills:[], equippedSkill:null,
  unlockedMaps:['floresta'], achievements:[], totalKills:0, totalDeaths:0, bossesDefeated:[],
  premiumPass:false, elitePass:false
};
function safeText(v,max=180){return String(v??'').trim().slice(0,max)}
function normPhone(v){return String(v||'').replace(/\D/g,'').replace(/^55/,'')}
function normalizeNick(v){return safeText(v,20).replace(/\s+/g,' ')}
function cleanColor(v){const s=String(v||'').trim();return /^#[0-9a-fA-F]{6}$/.test(s)?s:'#39eaff'}
function cloneDefault(){return JSON.parse(JSON.stringify(DEFAULT_PROGRESS))}
function mergeProgress(base, incoming){
  const d=cloneDefault(); Object.assign(d, base||{}, incoming||{});
  d.attributes=Object.assign({}, DEFAULT_PROGRESS.attributes, base?.attributes||{}, incoming?.attributes||{});
  d.boosts=Object.assign({}, DEFAULT_PROGRESS.boosts, base?.boosts||{}, incoming?.boosts||{});
  for(const k of ['codigosUsados','weapons','hats','capes','skills','unlockedMaps','achievements','bossesDefeated']) if(!Array.isArray(d[k])) d[k]=[];
  d.gold=Math.max(0,Number(d.gold)||0); d.diamantes=Math.max(0,Number(d.diamantes)||0); d.xp=Math.max(0,Number(d.xp)||0); d.level=Math.max(1,Number(d.level)||1);
  return d;
}
function idRA(){return 'RA-'+crypto.randomBytes(4).toString('hex').toUpperCase()+'-'+crypto.randomBytes(4).toString('hex').toUpperCase()}
function signToken(account){return jwt.sign({sub:account.id},JWT_SECRET,{expiresIn:'365d'})}
function auth(req,res,next){
  try{const h=req.headers.authorization||'';const token=h.startsWith('Bearer ')?h.slice(7):'';if(!token)throw new Error('AUTH');const p=jwt.verify(token,JWT_SECRET);req.userId=p.sub;next()}catch(e){return res.status(401).json({error:'Sessão inválida ou expirada.'})}
}
async function q(text,params=[]){if(!pool)throw new Error('Banco de dados não configurado.');return pool.query(text,params)}

async function initDB(){
  if(!pool)return;
  await q(`CREATE TABLE IF NOT EXISTS accounts(
    id TEXT PRIMARY KEY, nick TEXT NOT NULL UNIQUE, phone TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    active_character_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS characters(
    id UUID PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL, class_key TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#39eaff', progress JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(account_id,name)
  )`);

  // MIGRAÇÃO DE BANCO: versões antigas podem ter criado a tabela characters
  // sem as colunas novas. Nunca apagamos a tabela nem os personagens existentes.
  await q(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS active_character_id TEXT`);
  await q(`ALTER TABLE characters ADD COLUMN IF NOT EXISTS progress JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await q(`ALTER TABLE characters ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await q(`ALTER TABLE characters ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await q(`UPDATE characters SET progress='{}'::jsonb WHERE progress IS NULL`);
  await q(`UPDATE characters SET updated_at=COALESCE(updated_at,created_at,NOW()) WHERE updated_at IS NULL`);
  await q(`CREATE TABLE IF NOT EXISTS friendships(user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, friend_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(user_id,friend_id))`);
  await q(`CREATE TABLE IF NOT EXISTS friend_requests(from_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, to_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(from_id,to_id))`);
  await q(`CREATE TABLE IF NOT EXISTS teams(id TEXT PRIMARY KEY, name TEXT NOT NULL, leader_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS team_members(team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(team_id,user_id))`);
  await q(`CREATE TABLE IF NOT EXISTS social_invites(id BIGSERIAL PRIMARY KEY, to_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, type TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS recovery_codes(phone TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, used BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await q(`CREATE INDEX IF NOT EXISTS characters_account_idx ON characters(account_id)`);
  console.log('✅ PostgreSQL conectado, tabelas verificadas e migrações aplicadas.');
}

function accountPublic(r){return {id:r.id,nick:r.nick,phone:r.phone,activeCharacterId:r.active_character_id||null,createdAt:r.created_at}}
function charPublic(r){return {id:r.id,name:r.name,class_key:r.class_key,classe:r.class_key,color:r.color,progress:mergeProgress(r.progress||{},{}),updatedAt:r.updated_at}}
async function getAccount(id){const a=(await q('SELECT * FROM accounts WHERE id=$1',[id])).rows[0];if(!a)return null;const cs=(await q('SELECT * FROM characters WHERE account_id=$1 ORDER BY created_at',[id])).rows;return {account:accountPublic(a),characters:cs.map(charPublic)}}

app.get('/',(req,res)=>res.send('Reinos de Aço V12 — servidor online ⚔️ PostgreSQL ativo'));
app.get('/api/health',async(req,res)=>{try{if(pool)await q('SELECT 1');res.json({ok:true,version:'V12-CORRIGIDO',database:!!pool,time:Date.now()})}catch(e){res.status(500).json({ok:false,error:e.message})}});

// ==================== PAINEL ADMIN ====================
function adminGuard(req,res,next){
  const configured=String(process.env.ADMIN_KEY||'').trim();
  const supplied=String(req.headers['x-admin-key']||req.query.key||'').trim();
  if(!configured) return res.status(503).json({ok:false,error:'ADMIN_KEY não configurada no Render.'});
  if(!supplied || supplied!==configured) return res.status(401).json({ok:false,error:'Chave administrativa inválida.'});
  next();
}

app.get('/api/admin/status',adminGuard,async(req,res)=>{
  try{
    if(pool) await q('SELECT 1');
    const count=Object.keys(players).length;
    res.json({ok:true,online:true,players:count,version:'V14.3',database:!!pool,time:Date.now(),uptime:Math.floor(process.uptime())});
  }catch(e){res.status(500).json({ok:false,online:false,players:Object.keys(players).length,error:e.message,time:Date.now()});}
});

app.post('/api/admin/restart',adminGuard,(req,res)=>{
  res.json({ok:true,message:'Servidor será reiniciado agora.'});
  setTimeout(()=>process.exit(0),350);
});

app.post('/api/auth/register',async(req,res)=>{try{
  const nick=normalizeNick(req.body.nick), phone=normPhone(req.body.phone), pass=String(req.body.password||'');
  if(nick.length<3)throw new Error('Nick precisa ter pelo menos 3 caracteres.');
  if(phone.length<10||phone.length>13)throw new Error('WhatsApp inválido.');
  if(pass.length<6)throw new Error('A senha precisa ter pelo menos 6 caracteres.');
  const exists=await q('SELECT id FROM accounts WHERE nick=$1 OR phone=$2',[nick,phone]);if(exists.rows.length)throw new Error('Nick ou WhatsApp já cadastrado.');
  const id=idRA(), hash=await bcrypt.hash(pass,12);const r=await q('INSERT INTO accounts(id,nick,phone,password_hash) VALUES($1,$2,$3,$4) RETURNING *',[id,nick,phone,hash]);
  res.json({ok:true,token:signToken(r.rows[0]),account:accountPublic(r.rows[0]),whatsappUrl:`https://wa.me/55${phone}?text=${encodeURIComponent('Sua conta Reinos de Aço foi criada. ID: '+id)}`});
}catch(e){console.error(e);res.status(400).json({error:e.message||'Não foi possível criar a conta.'})}});

app.post('/api/auth/login',async(req,res)=>{try{
  const login=safeText(req.body.login,80), key=login.replace(/\D/g,'');const pass=String(req.body.password||'');
  const r=await q('SELECT * FROM accounts WHERE LOWER(nick)=LOWER($1) OR phone=$2 LIMIT 1',[login,key]);const a=r.rows[0];if(!a||!(await bcrypt.compare(pass,a.password_hash)))return res.status(401).json({error:'Nick/WhatsApp ou senha incorretos.'});
  res.json({ok:true,token:signToken(a),account:accountPublic(a)});
}catch(e){res.status(500).json({error:'Erro ao entrar.'})}});

app.get('/api/me',auth,async(req,res)=>{try{const d=await getAccount(req.userId);if(!d)return res.status(404).json({error:'Conta não encontrada.'});res.json(d)}catch(e){res.status(500).json({error:e.message})}});

app.post('/api/characters',auth,async(req,res)=>{try{
  const name=normalizeNick(req.body.name), classe=safeText(req.body.classe,30)||'guerreiro', color=cleanColor(req.body.color);if(name.length<2)throw new Error('Nome do personagem inválido.');
  const count=(await q('SELECT COUNT(*)::int AS n FROM characters WHERE account_id=$1',[req.userId])).rows[0].n;if(count>=8)throw new Error('Sua conta já possui 8 personagens.');
  const progress=cloneDefault();progress.playerClass=classe;progress.characterColor=color;const characterId=crypto.randomUUID();const r=await q('INSERT INTO characters(id,account_id,name,class_key,color,progress) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[characterId,req.userId,name,classe,color,JSON.stringify(progress)]);const c=r.rows[0];
  const a=await q('SELECT active_character_id FROM accounts WHERE id=$1',[req.userId]);if(!a.rows[0].active_character_id)await q('UPDATE accounts SET active_character_id=$1,updated_at=NOW() WHERE id=$2',[c.id,req.userId]);
  res.json({ok:true,character:charPublic(c)});
}catch(e){console.error('❌ POST /api/characters:',e);res.status(400).json({error:e.message||'Não foi possível criar personagem.'})}});

app.post('/api/characters/select',auth,async(req,res)=>{try{const id=safeText(req.body.id,80);const r=await q('SELECT * FROM characters WHERE id::text=$1 AND account_id=$2',[id,req.userId]);if(!r.rows[0])return res.status(404).json({error:'Personagem não encontrado.'});await q('UPDATE accounts SET active_character_id=$1,updated_at=NOW() WHERE id=$2',[r.rows[0].id,req.userId]);res.json({ok:true,character:charPublic(r.rows[0])})}catch(e){res.status(400).json({error:e.message})}});

app.put('/api/characters/:id/progress',auth,async(req,res)=>{try{
  const id=safeText(req.params.id,80), r=await q('SELECT * FROM characters WHERE id::text=$1 AND account_id=$2',[id,req.userId]);if(!r.rows[0])return res.status(404).json({error:'Personagem não encontrado.'});
  const progress=mergeProgress(r.rows[0].progress||{},req.body.progress||{});progress.playerClass=r.rows[0].class_key;progress.characterColor=r.rows[0].color;
  const u=await q('UPDATE characters SET progress=$1,updated_at=NOW() WHERE id=$2 RETURNING *',[JSON.stringify(progress),r.rows[0].id]);res.json({ok:true,character:charPublic(u.rows[0])});
}catch(e){console.error(e);res.status(400).json({error:'Não foi possível salvar o progresso.'})}});

app.get('/api/profile',auth,async(req,res)=>{try{const query=safeText(req.query.q,80);if(!query)return res.json({profiles:[]});const qv=query.toLowerCase();const r=await q(`SELECT id,nick FROM accounts WHERE LOWER(nick) LIKE $1 OR LOWER(id)=LOWER($2) ORDER BY nick LIMIT 20`,['%'+qv+'%',query]);const out=[];for(const a of r.rows){const cs=(await q('SELECT id,name,class_key,color FROM characters WHERE account_id=$1 ORDER BY created_at',[a.id])).rows;out.push({id:a.id,nick:a.nick,online:!!getSocketIdByUserId(a.id),characters:cs.map(c=>({id:c.id,name:c.name,classe:c.class_key,color:c.color}))})}res.json({profiles:out})}catch(e){res.status(500).json({error:e.message})}});

app.post('/api/auth/request-reset',async(req,res)=>{try{
  const phone=normPhone(req.body.phone);const r=await q('SELECT id,nick FROM accounts WHERE phone=$1',[phone]);if(!r.rows[0])return res.json({ok:true,message:'Se o WhatsApp estiver cadastrado, a recuperação será enviada.'});
  const code=String(Math.floor(100000+Math.random()*900000));const hash=await bcrypt.hash(code,10);await q('DELETE FROM recovery_codes WHERE phone=$1 OR expires_at<NOW()',[phone]);await q('INSERT INTO recovery_codes(phone,code_hash,expires_at) VALUES($1,$2,NOW()+INTERVAL \'15 minutes\')',[phone,hash]);
  const msg=`Reinos de Aço — código de recuperação: ${code} (válido por 15 minutos). ID da conta: ${r.rows[0].id}`;res.json({ok:true,whatsappUrl:`https://wa.me/55${phone}?text=${encodeURIComponent(msg)}`,message:'Abra o WhatsApp para receber o código.'});
}catch(e){res.status(500).json({error:'Erro ao gerar recuperação.'})}});
app.post('/api/auth/reset-password',async(req,res)=>{try{
  const phone=normPhone(req.body.phone),code=safeText(req.body.code,20),pass=String(req.body.newPassword||'');if(pass.length<6)throw new Error('A nova senha precisa ter pelo menos 6 caracteres.');
  const r=await q('SELECT * FROM recovery_codes WHERE phone=$1 AND used=false AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1',[phone]);if(!r.rows[0]||!(await bcrypt.compare(code,r.rows[0].code_hash)))throw new Error('Código inválido ou expirado.');
  const a=(await q('UPDATE accounts SET password_hash=$1,updated_at=NOW() WHERE phone=$2 RETURNING *',[await bcrypt.hash(pass,12),phone])).rows[0];if(!a)throw new Error('Conta não encontrada.');await q('UPDATE recovery_codes SET used=true WHERE phone=$1',[phone]);res.json({ok:true,token:signToken(a),account:accountPublic(a)});
}catch(e){res.status(400).json({error:e.message})}});

// ---------- Multiplayer/social persistente ----------
const players={};const rooms={};
function getSocketIdByUserId(uid){for(const sid of Object.keys(players))if(players[sid].userId===uid)return sid;return null}
function sendToUser(uid,event,data){const sid=getSocketIdByUserId(uid);if(sid)io.to(sid).emit(event,data)}
function publicPlayer(sid){const p=players[sid];if(!p)return null;return {id:p.id,userId:p.userId,characterId:p.characterId,x:p.x,y:p.y,classe:p.classe,color:p.color,facing:p.facing,nome:p.nome,local:p.local,status:'online',teamId:p.teamId||null}}
async function socialState(uid){
  const fs=(await q(`SELECT a.id,a.nick FROM accounts a JOIN friendships f ON f.friend_id=a.id WHERE f.user_id=$1 ORDER BY a.nick`,[uid])).rows;
  const reqs=(await q(`SELECT a.id,a.nick FROM accounts a JOIN friend_requests r ON r.from_id=a.id WHERE r.to_id=$1 ORDER BY r.created_at`,[uid])).rows;
  const inv=(await q(`SELECT id,type,payload,created_at FROM social_invites WHERE to_id=$1 ORDER BY created_at DESC LIMIT 30`,[uid])).rows;
  const tm=(await q(`SELECT t.id,t.name,t.leader_id FROM teams t JOIN team_members m ON m.team_id=t.id WHERE m.user_id=$1 LIMIT 1`,[uid])).rows[0];let team=null;
  if(tm){const ms=(await q(`SELECT a.id,a.nick FROM accounts a JOIN team_members m ON m.user_id=a.id WHERE m.team_id=$1 ORDER BY m.joined_at`,[tm.id])).rows;team={id:tm.id,nome:tm.name,lider:tm.leader_id,members:ms.map(x=>({id:x.id,nome:x.nick,online:!!getSocketIdByUserId(x.id)}))}}
  return {friends:fs.map(x=>({id:x.id,nome:x.nick,online:!!getSocketIdByUserId(x.id),player:getSocketIdByUserId(x.id)?publicPlayer(getSocketIdByUserId(x.id)):null})),requests:reqs.map(x=>({id:x.id,nome:x.nick,online:!!getSocketIdByUserId(x.id)})),invites:inv.map(x=>Object.assign({id:x.id,type:x.type,createdAt:x.created_at},x.payload||{})),team}
}
async function sendSocialState(uid){try{sendToUser(uid,'socialState',await socialState(uid))}catch(e){console.error('socialState',e.message)}}
async function broadcastSocial(uid){const st=await socialState(uid);sendToUser(uid,'socialState',st)}
function emitPlayers(){const out={};for(const sid of Object.keys(players))out[sid]=publicPlayer(sid);io.emit('updatePlayers',out)}
function removeUserFromRooms(uid){for(const rid of Object.keys(rooms)){const r=rooms[rid];if(!r.players.includes(uid))continue;r.players=r.players.filter(x=>x!==uid);if(!r.players.length)delete rooms[rid];else{if(r.host===uid)r.host=r.players[0];io.to(rid).emit('roomUpdate',r)}}}

io.use((socket,next)=>{try{const token=socket.handshake.auth?.token||'';const p=jwt.verify(token,JWT_SECRET);socket.data.userId=p.sub;next()}catch(e){const er=new Error('AUTH_REQUIRED');er.data={code:'AUTH_REQUIRED'};next(er)}});
io.on('connection',socket=>{
  socket.on('join',async(data={})=>{try{
    const uid=socket.data.userId;const acc=await getAccount(uid);if(!acc)return;const old=getSocketIdByUserId(uid);if(old&&old!==socket.id){delete players[old]}
    const cid=safeText(data.characterId,80)||String(acc.account.activeCharacterId||'');const c=acc.characters.find(x=>String(x.id)===cid)||acc.characters[0];
    players[socket.id]={id:socket.id,userId:uid,characterId:c?.id||null,nome:c?.name||acc.account.nick,classe:c?.class_key||'guerreiro',color:c?.color||'#39eaff',x:Number(data.x)||1400,y:Number(data.y)||1400,facing:Number(data.facing)||0,local:safeText(data.local,30)||'lobby',teamId:null};
    const tm=(await q('SELECT team_id FROM team_members WHERE user_id=$1 LIMIT 1',[uid])).rows[0];if(tm)players[socket.id].teamId=tm.team_id;
    socket.emit('connectedInfo',{socketId:socket.id,userId:uid,nome:players[socket.id].nome});await sendSocialState(uid);emitPlayers();
  }catch(e){console.error('join',e)}});
  socket.on('move',(d={})=>{const p=players[socket.id];if(!p)return;p.x=Number(d.x)||p.x;p.y=Number(d.y)||p.y;p.facing=Number(d.facing)||p.facing;if(d.local)p.local=safeText(d.local,30);emitPlayers()});
  socket.on('setLocation',d=>{const p=players[socket.id];if(!p)return;p.local=safeText(d.local,30)||'lobby';emitPlayers()});
  socket.on('chatMessage',d=>{const p=players[socket.id];if(!p)return;const text=safeText(d.text,180);if(!text)return;io.emit('chatMessage',{id:socket.id,userId:p.userId,nome:p.nome,name:p.nome,classe:p.classe,text,local:p.local,time:Date.now()})});
  socket.on('profileLookup',async d=>{try{const r=await q(`SELECT id,nick FROM accounts WHERE LOWER(nick) LIKE $1 OR LOWER(id)=LOWER($2) ORDER BY nick LIMIT 20`,['%'+safeText(d.query,80).toLowerCase()+'%',safeText(d.query,80)]);const ps=[];for(const a of r.rows){const cs=(await q('SELECT id,name,class_key,color FROM characters WHERE account_id=$1 ORDER BY created_at',[a.id])).rows;ps.push({id:a.id,nick:a.nick,online:!!getSocketIdByUserId(a.id),characters:cs.map(c=>({id:c.id,name:c.name,classe:c.class_key,color:c.color}))})}socket.emit('profileLookupResult',{profiles:ps})}catch(e){socket.emit('socialError',{message:e.message})}});
  socket.on('getFriendRequests',()=>sendSocialState(socket.data.userId));
  socket.on('friendRequest',async d=>{try{const from=socket.data.userId,to=safeText(d.userId,80);if(!to||to===from)return;const a=await q('SELECT id,nick FROM accounts WHERE id=$1',[to]);if(!a.rows[0])return socket.emit('socialError',{message:'Jogador não encontrado.'});const already=await q('SELECT 1 FROM friendships WHERE user_id=$1 AND friend_id=$2',[from,to]);if(already.rows[0])return socket.emit('socialError',{message:'Vocês já são amigos.'});await q(`INSERT INTO friend_requests(from_id,to_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[from,to]);const me=await q('SELECT nick FROM accounts WHERE id=$1',[from]);sendToUser(to,'friendRequestReceived',{id:from,nome:me.rows[0].nick,online:true});await sendSocialState(to);await sendSocialState(from)}catch(e){socket.emit('socialError',{message:e.message})}});
  socket.on('friendRequestRespond',async d=>{try{const me=socket.data.userId,from=safeText(d.userId,80);const rq=await q('DELETE FROM friend_requests WHERE from_id=$1 AND to_id=$2 RETURNING *',[from,me]);if(!rq.rows[0])return;if(d.accept){await q('INSERT INTO friendships(user_id,friend_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[me,from]);await q('INSERT INTO friendships(user_id,friend_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[from,me]);sendToUser(from,'friendAccepted',{id:me})}await sendSocialState(me);await sendSocialState(from)}catch(e){socket.emit('socialError',{message:e.message})}});
  socket.on('removeFriend',async d=>{const me=socket.data.userId,o=safeText(d.userId,80);await q('DELETE FROM friendships WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)',[me,o]);await sendSocialState(me);await sendSocialState(o)});
  socket.on('createTeam',async d=>{try{const uid=socket.data.userId;const old=await q('SELECT team_id FROM team_members WHERE user_id=$1 LIMIT 1',[uid]);if(old.rows[0])return socket.emit('socialError',{message:'Você já está em um time.'});const name=safeText(d.nome,28)||'Time de Aço',id='team_'+Date.now()+'_'+crypto.randomBytes(3).toString('hex');await q('INSERT INTO teams(id,name,leader_id) VALUES($1,$2,$3)',[id,name,uid]);await q('INSERT INTO team_members(team_id,user_id) VALUES($1,$2)',[id,uid]);socket.emit('teamCreated',{id,nome:name});await sendSocialState(uid);emitPlayers()}catch(e){socket.emit('socialError',{message:e.message})}});
  socket.on('teamInvite',async d=>{try{const uid=socket.data.userId,to=safeText(d.userId,80);const tm=(await q('SELECT t.* FROM teams t JOIN team_members m ON m.team_id=t.id WHERE m.user_id=$1 AND t.leader_id=$1 LIMIT 1',[uid])).rows[0];if(!tm)return socket.emit('socialError',{message:'Somente o líder pode convidar.'});const n=(await q('SELECT COUNT(*)::int n FROM team_members WHERE team_id=$1',[tm.id])).rows[0].n;if(n>=6)return socket.emit('socialError',{message:'O time já está cheio.'});const me=(await q('SELECT nick FROM accounts WHERE id=$1',[uid])).rows[0];const inv={type:'team',teamId:tm.id,teamNome:tm.name,fromId:uid,fromNome:me.nick};await q('INSERT INTO social_invites(to_id,type,payload) VALUES($1,$2,$3)',[to,'team',JSON.stringify(inv)]);sendToUser(to,'teamInviteReceived',inv);await sendSocialState(to)}catch(e){socket.emit('socialError',{message:e.message})}});
  socket.on('teamInviteRespond',async d=>{try{const uid=socket.data.userId,tid=safeText(d.teamId,100);await q("DELETE FROM social_invites WHERE to_id=$1 AND type='team' AND payload->>'teamId'=$2",[uid,tid]);if(d.accept){const n=(await q('SELECT COUNT(*)::int n FROM team_members WHERE team_id=$1',[tid])).rows[0]?.n||0;if(n>=6)return socket.emit('socialError',{message:'O time está cheio.'});const old=await q('SELECT 1 FROM team_members WHERE user_id=$1 LIMIT 1',[uid]);if(old.rows[0])return socket.emit('socialError',{message:'Você já está em um time.'});await q('INSERT INTO team_members(team_id,user_id) VALUES($1,$2)',[tid,uid]);}const mem=(await q('SELECT user_id FROM team_members WHERE team_id=$1',[tid])).rows;for(const m of mem)await sendSocialState(m.user_id);emitPlayers()}catch(e){socket.emit('socialError',{message:e.message})}});
  socket.on('teamKick',async d=>{try{const uid=socket.data.userId,to=safeText(d.userId,80);const tm=(await q('SELECT t.* FROM teams t JOIN team_members m ON m.team_id=t.id WHERE m.user_id=$1 AND t.leader_id=$1 LIMIT 1',[uid])).rows[0];if(!tm)return;await q('DELETE FROM team_members WHERE team_id=$1 AND user_id=$2',[tm.id,to]);await sendSocialState(to);const mem=(await q('SELECT user_id FROM team_members WHERE team_id=$1',[tm.id])).rows;for(const m of mem)await sendSocialState(m.user_id);emitPlayers()}catch(e){}});
  socket.on('leaveTeam',async()=>{try{const uid=socket.data.userId;const tm=(await q('SELECT t.* FROM teams t JOIN team_members m ON m.team_id=t.id WHERE m.user_id=$1 LIMIT 1',[uid])).rows[0];if(!tm)return;await q('DELETE FROM team_members WHERE team_id=$1 AND user_id=$2',[tm.id,uid]);const rem=(await q('SELECT user_id FROM team_members WHERE team_id=$1 ORDER BY joined_at',[tm.id])).rows;if(tm.leader_id===uid){if(rem.length)await q('UPDATE teams SET leader_id=$1 WHERE id=$2',[rem[0].user_id,tm.id]);else await q('DELETE FROM teams WHERE id=$1',[tm.id])}await sendSocialState(uid);for(const m of rem)await sendSocialState(m.user_id);emitPlayers()}catch(e){}});
  socket.on('gameInvite',async d=>{try{const uid=socket.data.userId,to=safeText(d.userId,80),mode=safeText(d.mode,30);if(!['campaign','survival','arena1v1','arena2v2','arena3v3'].includes(mode))return;const me=(await q('SELECT nick FROM accounts WHERE id=$1',[uid])).rows[0];const inv={type:'game',mode,fromId:uid,fromNome:me.nick};await q('INSERT INTO social_invites(to_id,type,payload) VALUES($1,$2,$3)',[to,'game',JSON.stringify(inv)]);sendToUser(to,'gameInviteReceived',inv);await sendSocialState(to)}catch(e){}});
  socket.on('gameInviteRespond',async d=>{try{const uid=socket.data.userId,from=safeText(d.fromId,80),mode=safeText(d.mode,30);await q("DELETE FROM social_invites WHERE to_id=$1 AND type='game' AND payload->>'fromId'=$2 AND payload->>'mode'=$3",[uid,from,mode]);if(!d.accept)return;createRoomFor([from,uid],mode)}catch(e){socket.emit('socialError',{message:e.message})}});
  socket.on('createRoom',async d=>{const uid=socket.data.userId;const mode=safeText(d.mode,30);if(!['arena1v1','arena2v2','arena3v3','campaign','survival'].includes(mode))return;let ids=[uid];if(d.useTeam){const tm=(await q('SELECT team_id FROM team_members WHERE user_id=$1 LIMIT 1',[uid])).rows[0];if(tm)ids=(await q('SELECT user_id FROM team_members WHERE team_id=$1 ORDER BY joined_at',[tm.team_id])).rows.map(x=>x.user_id)}createRoomFor(ids,mode)});
  socket.on('joinRoom',d=>{const uid=socket.data.userId,r=rooms[safeText(d.roomId,100)];if(!r)return;if(!r.players.includes(uid)&&r.players.length<r.maxPlayers)r.players.push(uid);const sid=getSocketIdByUserId(uid);if(sid)io.sockets.sockets.get(sid)?.join(r.id);io.to(r.id).emit('roomUpdate',r);if(r.players.length>=r.maxPlayers){r.status='ready';io.to(r.id).emit('roomReady',r)}});
  socket.on('leaveRoom',d=>{const uid=socket.data.userId,r=rooms[safeText(d.roomId,100)];if(!r)return;r.players=r.players.filter(x=>x!==uid);socket.leave(r.id);if(!r.players.length)delete rooms[r.id];else{if(r.host===uid)r.host=r.players[0];io.to(r.id).emit('roomUpdate',r)}});
  socket.on('startRoom',d=>{const uid=socket.data.userId,r=rooms[safeText(d.roomId,100)];if(!r||r.host!==uid)return;r.status='started';io.to(r.id).emit('gameStart',r)});
  socket.on('disconnect',()=>{const p=players[socket.id];if(p){removeUserFromRooms(p.userId);delete players[socket.id];emitPlayers();for(const f of [] ){} }});
});
async function createRoomFor(ids,mode){const max={arena1v1:2,arena2v2:4,arena3v3:6,campaign:4,survival:4}[mode]||4;const playersIds=[...new Set(ids)].filter(x=>getSocketIdByUserId(x)).slice(0,max);if(!playersIds.length)return;const id='room_'+Date.now()+'_'+crypto.randomBytes(3).toString('hex');rooms[id]={id,mode,host:playersIds[0],players:playersIds,maxPlayers:max,status:playersIds.length>=max?'ready':'waiting',createdAt:Date.now()};for(const uid of playersIds){const sid=getSocketIdByUserId(uid);if(sid)io.sockets.sockets.get(sid)?.join(id);sendToUser(uid,'gameRoomCreated',rooms[id])}io.to(id).emit('roomUpdate',rooms[id]);if(rooms[id].status==='ready')io.to(id).emit('roomReady',rooms[id])}

initDB().then(()=>server.listen(PORT,()=>console.log(`🚀 Servidor Reinos de Aço V12 CORRIGIDO rodando na porta ${PORT}`))).catch(e=>{console.error('❌ Falha ao iniciar:',e);process.exit(1)});
