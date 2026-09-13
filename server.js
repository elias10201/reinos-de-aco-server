const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Libera a conexão para o seu index.html
const io = new Server(server, {
  cors: { origin: "*" }
});

let players = {};

io.on('connection', (socket) => {
  console.log('Novo guerreiro conectou:', socket.id);

  // Quando o jogador entra no jogo
  socket.on('join', (data) => {
    players[socket.id] = {
      id: socket.id,
      x: data.x,
      y: data.y,
      classe: data.classe,
      facing: data.facing
    };
    // Manda a lista de todos os jogadores para todo mundo
    io.emit('updatePlayers', players);
  });

  // Quando o jogador anda
  socket.on('move', (data) => {
    if(players[socket.id]) {
      players[socket.id].x = data.x;
      players[socket.id].y = data.y;
      players[socket.id].facing = data.facing;
      // Espalha o movimento para os outros verem
      io.emit('updatePlayers', players);
    }
  });

  // Quando o jogador manda mensagem no Chat
  socket.on('chatMessage', (data) => {
    io.emit('chatMessage', { id: socket.id, classe: data.classe, text: data.text });
  });

  // Quando o jogador fecha o jogo ou cai a internet
  socket.on('disconnect', () => {
    console.log('Guerreiro desconectou:', socket.id);
    delete players[socket.id];
    io.emit('updatePlayers', players);
  });
});

// A porta que o Render vai usar
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
