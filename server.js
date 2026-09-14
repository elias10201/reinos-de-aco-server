const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.get("/", (req, res) => {
  res.send("⚔️ Servidor Reinos de Aço online!");
});

/* =========================================================
   DADOS DO SERVIDOR
========================================================= */

const players = {};
const profiles = {};
const friendRequests = {};
const teams = {};
const invites = {};
const rooms = {};

/* =========================================================
   FUNÇÕES AUXILIARES
========================================================= */

function cleanText(text, max = 120) {
  if (typeof text !== "string") return "";
  return text.trim().slice(0, max);
}

function createProfile(socket, data = {}) {
  const userId = cleanText(data.userId, 80) || socket.id;

  if (!profiles[userId]) {
    profiles[userId] = {
      userId,
      name:
        cleanText(data.nome || data.name, 30) ||
        `Guerreiro_${socket.id.slice(0, 5)}`,
      classe: cleanText(data.classe, 30) || "guerreiro",
      socketId: socket.id,
      online: true,
      local: data.local || "game",
      friends: [],
      teamId: null
    };
  } else {
    profiles[userId].socketId = socket.id;
    profiles[userId].online = true;

    if (data.nome || data.name) {
      profiles[userId].name =
        cleanText(data.nome || data.name, 30) ||
        profiles[userId].name;
    }

    if (data.classe) {
      profiles[userId].classe = cleanText(data.classe, 30);
    }

    if (data.local) {
      profiles[userId].local = data.local;
    }
  }

  socket.userId = userId;

  return profiles[userId];
}

function getProfile(socket) {
  if (!socket.userId) return null;
  return profiles[socket.userId] || null;
}

function getSocketByUserId(userId) {
  const profile = profiles[userId];
  if (!profile || !profile.online) return null;

  return io.sockets.sockets.get(profile.socketId) || null;
}

function publicProfile(userId) {
  const p = profiles[userId];

  if (!p) return null;

  return {
    userId: p.userId,
    name: p.name,
    classe: p.classe,
    online: p.online,
    local: p.local,
    teamId: p.teamId
  };
}

function sendFriends(socket) {
  const profile = getProfile(socket);

  if (!profile) return;

  socket.emit(
    "friendsList",
    profile.friends
      .map(id => publicProfile(id))
      .filter(Boolean)
  );
}

function broadcastOnlinePlayers() {
  io.emit(
    "onlinePlayers",
    Object.values(profiles)
      .filter(p => p.online)
      .map(p => publicProfile(p.userId))
  );
}

/* =========================================================
   CONEXÃO
========================================================= */

io.on("connection", socket => {

  console.log("⚔️ Novo guerreiro conectou:", socket.id);

  /* =======================================================
     JOIN — COMPATÍVEL COM O MULTIPLAYER ANTIGO
  ======================================================= */

  socket.on("join", (data = {}) => {

    const profile = createProfile(socket, data);

    players[socket.id] = {
      id: socket.id,
      userId: profile.userId,
      nome: profile.name,
      name: profile.name,
      x: Number(data.x) || 0,
      y: Number(data.y) || 0,
      classe: profile.classe,
      facing: Number(data.facing) || 1,
      local: data.local || "game"
    };

    console.log(
      `🟢 ${profile.name} entrou em ${players[socket.id].local}`
    );

    io.emit("updatePlayers", players);

    sendFriends(socket);
    broadcastOnlinePlayers();

    socket.emit("profileData", publicProfile(profile.userId));
  });

  /* =======================================================
     MOVIMENTO
  ======================================================= */

  socket.on("move", (data = {}) => {

    if (!players[socket.id]) return;

    const player = players[socket.id];

    if (typeof data.x === "number") {
      player.x = data.x;
    }

    if (typeof data.y === "number") {
      player.y = data.y;
    }

    if (typeof data.facing === "number") {
      player.facing = data.facing;
    }

    if (data.local) {
      player.local = data.local;
    }

    if (data.nome || data.name) {
      player.nome =
        cleanText(data.nome || data.name, 30) ||
        player.nome;
    }

    if (players[socket.id].userId) {
      const profile = profiles[players[socket.id].userId];

      if (profile) {
        if (data.local) {
          profile.local = data.local;
        }

        if (data.nome || data.name) {
          profile.name =
            cleanText(data.nome || data.name, 30) ||
            profile.name;
        }
      }
    }

    io.emit("updatePlayers", players);
  });

  /* =======================================================
     ALTERAR LOCAL
     game / social / lobby / pvp
  ======================================================= */

  socket.on("setLocation", data => {

    const profile = getProfile(socket);

    if (!profile) return;

    const local = cleanText(data?.local, 30) || "game";

    profile.local = local;

    if (players[socket.id]) {
      players[socket.id].local = local;
    }

    io.emit("playerLocationChanged", {
      userId: profile.userId,
      local
    });

    io.emit("updatePlayers", players);
  });

  /* =======================================================
     CHAT
  ======================================================= */

  socket.on("chatMessage", data => {

    const profile = getProfile(socket);

    if (!profile) return;

    const text = cleanText(data?.text, 200);

    if (!text) return;

    const message = {
      id: socket.id,
      userId: profile.userId,
      nome: profile.name,
      name: profile.name,
      classe: profile.classe,
      text,
      local: profile.local,
      time: Date.now()
    };

    io.emit("chatMessage", message);
  });

  /* =======================================================
     LISTA DE JOGADORES ONLINE
  ======================================================= */

  socket.on("getOnlinePlayers", () => {
    broadcastOnlinePlayers();
  });

  /* =======================================================
     AMIZADE
  ======================================================= */

  socket.on("friendRequest", data => {

    const sender = getProfile(socket);

    if (!sender) return;

    const targetId = cleanText(data?.userId, 80);

    if (!targetId) return;

    if (targetId === sender.userId) {
      socket.emit("friendError", {
        message: "Você não pode adicionar você mesmo."
      });
      return;
    }

    if (!profiles[targetId]) {
      socket.emit("friendError", {
        message: "Jogador não encontrado."
      });
      return;
    }

    if (sender.friends.includes(targetId)) {
      socket.emit("friendError", {
        message: "Esse jogador já está nos seus amigos."
      });
      return;
    }

    if (!friendRequests[targetId]) {
      friendRequests[targetId] = [];
    }

    if (friendRequests[targetId].includes(sender.userId)) {
      socket.emit("friendError", {
        message: "Solicitação já enviada."
      });
      return;
    }

    friendRequests[targetId].push(sender.userId);

    const targetSocket = getSocketByUserId(targetId);

    if (targetSocket) {
      targetSocket.emit("friendRequestReceived", {
        from: publicProfile(sender.userId)
      });
    }

    socket.emit("friendRequestSent", {
      to: publicProfile(targetId)
    });
  });

  /* =======================================================
     RESPOSTA DE AMIZADE
  ======================================================= */

  socket.on("friendRequestRespond", data => {

    const receiver = getProfile(socket);

    if (!receiver) return;

    const fromId = cleanText(data?.userId, 80);
    const accepted = !!data?.accepted;

    if (!fromId) return;

    if (!friendRequests[receiver.userId]) {
      friendRequests[receiver.userId] = [];
    }

    friendRequests[receiver.userId] =
      friendRequests[receiver.userId].filter(
        id => id !== fromId
      );

    if (accepted) {

      if (!receiver.friends.includes(fromId)) {
        receiver.friends.push(fromId);
      }

      if (profiles[fromId] &&
          !profiles[fromId].friends.includes(receiver.userId)) {

        profiles[fromId].friends.push(receiver.userId);
      }

      socket.emit("friendAdded", {
        friend: publicProfile(fromId)
      });

      const senderSocket = getSocketByUserId(fromId);

      if (senderSocket) {
        senderSocket.emit("friendAdded", {
          friend: publicProfile(receiver.userId)
        });

        sendFriends(senderSocket);
      }
    }

    sendFriends(socket);
  });

  /* =======================================================
     REMOVER AMIGO
  ======================================================= */

  socket.on("removeFriend", data => {

    const profile = getProfile(socket);

    if (!profile) return;

    const friendId = cleanText(data?.userId, 80);

    profile.friends =
      profile.friends.filter(id => id !== friendId);

    if (profiles[friendId]) {
      profiles[friendId].friends =
        profiles[friendId].friends.filter(
          id => id !== profile.userId
        );
    }

    sendFriends(socket);

    const friendSocket = getSocketByUserId(friendId);

    if (friendSocket) {
      sendFriends(friendSocket);
    }
  });

  /* =======================================================
     VER SOLICITAÇÕES
  ======================================================= */

  socket.on("getFriendRequests", () => {

    const profile = getProfile(socket);

    if (!profile) return;

    const requests =
      (friendRequests[profile.userId] || [])
        .map(id => publicProfile(id))
        .filter(Boolean);

    socket.emit("friendRequestsList", requests);
  });

  /* =======================================================
     CRIAR TIME
  ======================================================= */

  socket.on("createTeam", data => {

    const leader = getProfile(socket);

    if (!leader) return;

    if (leader.teamId) {
      socket.emit("teamError", {
        message: "Você já está em um time."
      });
      return;
    }

    const teamId =
      "team_" +
      Date.now() +
      "_" +
      Math.random().toString(36).slice(2, 8);

    const team = {
      id: teamId,
      name:
        cleanText(data?.name, 30) ||
        `Time de ${leader.name}`,
      symbol:
        cleanText(data?.symbol, 10) ||
        "⚔️",
      leaderId: leader.userId,
      members: [leader.userId],
      createdAt: Date.now()
    };

    teams[teamId] = team;

    leader.teamId = teamId;

    socket.emit("teamCreated", team);
    socket.emit("teamData", team);

    broadcastOnlinePlayers();
  });

  /* =======================================================
     CONVIDAR PARA TIME
  ======================================================= */

  socket.on("teamInvite", data => {

    const leader = getProfile(socket);

    if (!leader) return;

    const teamId = leader.teamId;
    const targetId = cleanText(data?.userId, 80);

    if (!teamId || !teams[teamId]) {
      socket.emit("teamError", {
        message: "Você não está em um time."
      });
      return;
    }

    const team = teams[teamId];

    if (team.leaderId !== leader.userId) {
      socket.emit("teamError", {
        message: "Somente o líder pode convidar."
      });
      return;
    }

    if (!profiles[targetId]) {
      socket.emit("teamError", {
        message: "Jogador não encontrado."
      });
      return;
    }

    if (team.members.includes(targetId)) {
      socket.emit("teamError", {
        message: "Esse jogador já está no time."
      });
      return;
    }

    const targetSocket = getSocketByUserId(targetId);

    if (!targetSocket) {
      socket.emit("teamError", {
        message: "Esse jogador está offline."
      });
      return;
    }

    const inviteId =
      "teamInvite_" +
      Date.now() +
      "_" +
      Math.random().toString(36).slice(2, 7);

    invites[inviteId] = {
      id: inviteId,
      type: "team",
      teamId,
      fromId: leader.userId,
      toId: targetId,
      createdAt: Date.now()
    };

    targetSocket.emit("teamInviteReceived", {
      invite: invites[inviteId],
      team
    });

    socket.emit("teamInviteSent", {
      invite: invites[inviteId]
    });
  });

  /* =======================================================
     ACEITAR / RECUSAR TIME
  ======================================================= */

  socket.on("teamInviteRespond", data => {

    const player = getProfile(socket);

    if (!player) return;

    const inviteId = cleanText(data?.inviteId, 100);
    const accepted = !!data?.accepted;

    const invite = invites[inviteId];

    if (!invite) return;

    if (invite.toId !== player.userId) return;

    const team = teams[invite.teamId];

    if (!team) {
      delete invites[inviteId];
      return;
    }

    if (accepted) {

      if (player.teamId) {
        socket.emit("teamError", {
          message: "Você já está em outro time."
        });

        delete invites[inviteId];
        return;
      }

      if (!team.members.includes(player.userId)) {
        team.members.push(player.userId);
      }

      player.teamId = team.id;

      socket.emit("teamJoined", team);

      const leaderSocket =
        getSocketByUserId(team.leaderId);

      if (leaderSocket) {
        leaderSocket.emit("teamUpdated", team);
      }

    } else {

      socket.emit("teamInviteDeclined", {
        invite
      });
    }

    delete invites[inviteId];
  });

  /* =======================================================
     PEGAR DADOS DO TIME
  ======================================================= */

  socket.on("getTeam", () => {

    const profile = getProfile(socket);

    if (!profile || !profile.teamId) {
      socket.emit("teamData", null);
      return;
    }

    const team = teams[profile.teamId];

    if (!team) {
      profile.teamId = null;
      socket.emit("teamData", null);
      return;
    }

    socket.emit("teamData", team);
  });

  /* =======================================================
     SAIR DO TIME
  ======================================================= */

  socket.on("leaveTeam", () => {

    const player = getProfile(socket);

    if (!player || !player.teamId) return;

    const team = teams[player.teamId];

    if (!team) {
      player.teamId = null;
      socket.emit("teamData", null);
      return;
    }

    if (team.leaderId === player.userId) {

      for (const memberId of team.members) {

        if (profiles[memberId]) {
          profiles[memberId].teamId = null;
        }

        const memberSocket =
          getSocketByUserId(memberId);

        if (memberSocket) {
          memberSocket.emit("teamDisbanded");
        }
      }

      delete teams[team.id];

    } else {

      team.members =
        team.members.filter(
          id => id !== player.userId
        );

      player.teamId = null;

      socket.emit("teamLeft");

      for (const memberId of team.members) {

        const memberSocket =
          getSocketByUserId(memberId);

        if (memberSocket) {
          memberSocket.emit("teamUpdated", team);
        }
      }
    }

    broadcastOnlinePlayers();
  });

  /* =======================================================
     EXPULSAR MEMBRO
  ======================================================= */

  socket.on("kickTeamMember", data => {

    const leader = getProfile(socket);

    if (!leader || !leader.teamId) return;

    const team = teams[leader.teamId];

    if (!team) return;

    if (team.leaderId !== leader.userId) return;

    const targetId =
      cleanText(data?.userId, 80);

    if (!team.members.includes(targetId)) return;

    team.members =
      team.members.filter(id => id !== targetId);

    if (profiles[targetId]) {
      profiles[targetId].teamId = null;
    }

    const targetSocket =
      getSocketByUserId(targetId);

    if (targetSocket) {
      targetSocket.emit("teamKicked");
    }

    for (const memberId of team.members) {

      const memberSocket =
        getSocketByUserId(memberId);

      if (memberSocket) {
        memberSocket.emit("teamUpdated", team);
      }
    }
  });

  /* =======================================================
     CONVITE PARA COMBATE
  ======================================================= */

  socket.on("gameInvite", data => {

    const sender = getProfile(socket);

    if (!sender) return;

    const targetId =
      cleanText(data?.userId, 80);

    const mode =
      cleanText(data?.mode, 30) || "1v1";

    if (!profiles[targetId]) {
      socket.emit("gameInviteError", {
        message: "Jogador não encontrado."
      });
      return;
    }

    const targetSocket =
      getSocketByUserId(targetId);

    if (!targetSocket) {
      socket.emit("gameInviteError", {
        message: "Jogador está offline."
      });
      return;
    }

    const inviteId =
      "gameInvite_" +
      Date.now() +
      "_" +
      Math.random().toString(36).slice(2, 8);

    invites[inviteId] = {
      id: inviteId,
      type: "game",
      fromId: sender.userId,
      toId: targetId,
      mode,
      createdAt: Date.now()
    };

    targetSocket.emit("gameInviteReceived", {
      invite: invites[inviteId],
      from: publicProfile(sender.userId)
    });

    socket.emit("gameInviteSent", {
      invite: invites[inviteId]
    });
  });

  /* =======================================================
     RESPOSTA AO CONVITE DE COMBATE
  ======================================================= */

  socket.on("gameInviteRespond", data => {

    const player = getProfile(socket);

    if (!player) return;

    const inviteId =
      cleanText(data?.inviteId, 100);

    const accepted = !!data?.accepted;

    const invite = invites[inviteId];

    if (!invite) return;

    if (invite.toId !== player.userId) return;

    if (!accepted) {

      const senderSocket =
        getSocketByUserId(invite.fromId);

      if (senderSocket) {
        senderSocket.emit("gameInviteDeclined", {
          invite
        });
      }

      delete invites[inviteId];
      return;
    }

    /* Cria sala automaticamente */

    const roomId =
      "room_" +
      Date.now() +
      "_" +
      Math.random().toString(36).slice(2, 8);

    rooms[roomId] = {
      id: roomId,
      mode: invite.mode,
      players: [
        invite.fromId,
        player.userId
      ],
      started: false,
      createdAt: Date.now()
    };

    const senderSocket =
      getSocketByUserId(invite.fromId);

    if (senderSocket) {
      senderSocket.join(roomId);

      senderSocket.emit("gameRoomCreated", {
        room: rooms[roomId]
      });
    }

    socket.join(roomId);

    socket.emit("gameRoomJoined", {
      room: rooms[roomId]
    });

    delete invites[inviteId];
  });

  /* =======================================================
     CRIAR SALA MANUAL
  ======================================================= */

  socket.on("createRoom", data => {

    const player = getProfile(socket);

    if (!player) return;

    const mode =
      cleanText(data?.mode, 30) || "1v1";

    const roomId =
      "room_" +
      Date.now() +
      "_" +
      Math.random().toString(36).slice(2, 8);

    rooms[roomId] = {
      id: roomId,
      mode,
      players: [player.userId],
      started: false,
      createdAt: Date.now()
    };

    socket.join(roomId);

    socket.emit("roomCreated", {
      room: rooms[roomId]
    });
  });

  /* =======================================================
     ENTRAR EM SALA
  ======================================================= */

  socket.on("joinRoom", data => {

    const player = getProfile(socket);

    if (!player) return;

    const roomId =
      cleanText(data?.roomId, 100);

    const room = rooms[roomId];

    if (!room) {
      socket.emit("roomError", {
        message: "Sala não encontrada."
      });
      return;
    }

    if (room.started) {
      socket.emit("roomError", {
        message: "Essa sala já começou."
      });
      return;
    }

    if (!room.players.includes(player.userId)) {
      room.players.push(player.userId);
    }

    socket.join(roomId);

    io.to(roomId).emit(
      "roomUpdated",
      room
    );
  });

  /* =======================================================
     SAIR DA SALA
  ======================================================= */

  socket.on("leaveRoom", data => {

    const player = getProfile(socket);

    if (!player) return;

    const roomId =
      cleanText(data?.roomId, 100);

    const room = rooms[roomId];

    if (!room) return;

    room.players =
      room.players.filter(
        id => id !== player.userId
      );

    socket.leave(roomId);

    if (room.players.length === 0) {
      delete rooms[roomId];
      return;
    }

    io.to(roomId).emit(
      "roomUpdated",
      room
    );
  });

  /* =======================================================
     INICIAR SALA
  ======================================================= */

  socket.on("startRoom", data => {

    const player = getProfile(socket);

    if (!player) return;

    const roomId =
      cleanText(data?.roomId, 100);

    const room = rooms[roomId];

    if (!room) return;

    if (!room.players.includes(player.userId)) {
      return;
    }

    room.started = true;

    io.to(roomId).emit(
      "roomStarted",
      room
    );
  });

  /* =======================================================
     DESCONEXÃO
  ======================================================= */

  socket.on("disconnect", () => {

    console.log(
      "🔴 Guerreiro desconectou:",
      socket.id
    );

    delete players[socket.id];

    const profile = Object.values(profiles)
      .find(p => p.socketId === socket.id);

    if (profile) {

      profile.online = false;
      profile.socketId = null;

      /*
       * Não apagamos o perfil.
       * Assim a amizade fica registrada
       * enquanto o servidor estiver ligado.
       */

      if (profile.teamId) {

        const team =
          teams[profile.teamId];

        if (team) {

          team.members =
            team.members.filter(
              id => id !== profile.userId
            );

          if (
            team.leaderId === profile.userId ||
            team.members.length === 0
          ) {

            for (const memberId of team.members) {

              if (profiles[memberId]) {
                profiles[memberId].teamId = null;
              }

              const memberSocket =
                getSocketByUserId(memberId);

              if (memberSocket) {
                memberSocket.emit("teamDisbanded");
              }
            }

            delete teams[team.id];

          } else {

            io.to(team.id).emit(
              "teamUpdated",
              team
            );
          }
        }

        profile.teamId = null;
      }
    }

    io.emit(
      "updatePlayers",
      players
    );

    broadcastOnlinePlayers();
  });
});

/* =========================================================
   SERVIDOR
========================================================= */

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(
    `⚔️ Servidor Reinos de Aço rodando na porta ${PORT}`
  );
});
