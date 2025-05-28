const express = require('express');
const http = require('http');
const cors = require('cors');
const socketIO = require('socket.io');

const app = express();
app.use(cors()); // ✅ Important!

const server = http.createServer(app);

// Socket.IO server configured with CORS:
const io = socketIO(server, {
  cors: {
    origin: 'https://calciferr-sudo.github.io', // ✅ Your exact GitHub Pages URL
    methods: ['GET', 'POST']
  }
});

io.on('connection', (socket) => {
  console.log('A user connected');

  socket.on('markNumber', (num) => {
    io.emit('markNumber', num);
  });

  socket.on('declareWin', () => {
    io.emit('gameOver');
  });

  socket.on('disconnect', () => {
    console.log('A user disconnected');
  });
});
socket.on("chatMessage", (msg) => {
  io.emit("chatMessage", msg);
});
