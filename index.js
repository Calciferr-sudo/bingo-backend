const express = require('express');
const http = require('http');
const cors = require('cors');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;  // ✅ Important!

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

let players = [];
let gameStarted = false;

io.on('connection', socket => {
  console.log(`Player connected: ${socket.id}`);

  if (players.length >= 2 || gameStarted) {
    socket.emit('roomFull');
    socket.disconnect();
    return;
  }

  players.push(socket);

  socket.on('markNumber', num => {
    io.emit('markNumber', num); // Broadcast to all
  });

  socket.on('declareWin', () => {
    io.emit('gameOver');
  });

  socket.on('disconnect', () => {
    players = players.filter(p => p !== socket);
    console.log(`Player disconnected: ${socket.id}`);
  });
});

server.listen(3000, () => {
  console.log("Server running on port 3000");
});