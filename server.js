const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
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
    teamId: p.teamId || null
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

io.on('connection', (socket) => {
  console.log('Novo guerreiro conectou:', socket.id);

  socket.on('join', (data = {}) => {
    const nome = safeText(data.nome || data.name, 24) || 'Guerreiro';
    const userId = safeText(data.userId, 80) || socket.id;

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
      classe: data.classe || 'guerreiro',
      facing: data.facing || 1,
      nome,
      local: data.local || 'lobby',
      status: 'online',
      teamId: null
    };

    socket.data.userId = userId;
    socket.emit('connectedInfo', {
      socketId: socket.id,
      userId,
      nome
    });

    sendSocialState(userId);
    emitPlayers();
    notifyFriendsOnline(userId);

    console.log(`${nome} entrou online (${socket.id})`);
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

server.listen(PORT, () => {
  console.log(`Servidor Reinos de Aço rodando na porta ${PORT}`);
});
