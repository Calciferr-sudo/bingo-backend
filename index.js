const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

app.use(cors());

const io = new Server(server, {
  cors: {
    origin: 'https://calciferr-sudo.github.io',
    methods: ['GET', 'POST']
  }
});

let players = 0;

io.on('connection', (socket) => {
  players++;
  console.log("User connected. Total:", players);

  io.emit("userJoined", players);

  socket.on("playerName", (name) => {
    socket.broadcast.emit("playerJoined", name);
  });

  socket.on("markNumber", (num) => {
    io.emit("markNumber", num);
  });

  socket.on("declareWin", () => {
    io.emit("gameOver");
  });

  socket.on("disconnect", () => {
    players = Math.max(players - 1, 0);
    io.emit("userJoined", players);
    console.log("User disconnected. Remaining:", players);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
