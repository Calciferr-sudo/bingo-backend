const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

app.use(cors());

const io = new Server(server, {
  cors: {
    origin: 'https://calciferr-sudo.github.io',
    methods: ['GET', 'POST'],
  }
});

let players = 0;

io.on('connection', (socket) => {
  players++;
  io.emit('userJoined', players);

  socket.on('playerName', (name) => {
    socket.broadcast.emit('playerJoined', name);
  });

  socket.on('markNumber', (num) => {
    io.emit('markNumber', num);
  });

  socket.on('declareWin', () => {
    io.emit('gameOver');
  });

  socket.on('disconnect', () => {
    players = Math.max(0, players - 1);
    io.emit('userJoined', players);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
