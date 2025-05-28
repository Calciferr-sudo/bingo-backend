const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  }
});

// Your socket.io logic here...
io.on('connection', (socket) => {
  console.log('New user connected');

  socket.on('markNumber', (num) => {
    io.emit('markNumber', num);
  });

  socket.on('declareWin', () => {
    io.emit('gameOver');
  });

  socket.on('disconnect', () => {
    console.log('User disconnected');
  });
});

// ✅ Only one listen call:
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
