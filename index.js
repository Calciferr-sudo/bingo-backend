const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: 'https://github.com/Calciferr-sudo' }
});

let players = {};
let scoreboard = {};
let currentTimer = null;
let countdown = 10;

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  socket.on('joinGame', (playerName) => {
    players[socket.id] = playerName;
    if (!scoreboard[playerName]) scoreboard[playerName] = 0;
    io.emit('updatePlayers', players);
    io.emit('updateScoreboard', scoreboard);
  });

  socket.on('markNumber', (num) => {
    io.emit('markNumber', num);
    startCountdown(); // reset or continue the countdown
  });

  socket.on('declareWin', () => {
    const winnerName = players[socket.id];
    if (winnerName) {
      scoreboard[winnerName]++;
      io.emit('gameOver', winnerName);
      io.emit('updateScoreboard', scoreboard);
      stopCountdown();
    }
  });

  socket.on('playAgain', () => {
    io.emit('resetGame');
    startCountdown();
  });

  socket.on('disconnect', () => {
    const leftPlayer = players[socket.id];
    delete players[socket.id];
    console.log(`Player disconnected: ${socket.id}`);
    io.emit('updatePlayers', players);
  });
});

function startCountdown() {
  stopCountdown(); // Clear any existing timer
  countdown = 10;
  currentTimer = setInterval(() => {
    countdown--;
    io.emit('countdown', countdown);
    if (countdown <= 0) {
      stopCountdown();
      io.emit('turnTimeout');
    }
  }, 1000);
}

function stopCountdown() {
  if (currentTimer) {
    clearInterval(currentTimer);
    currentTimer = null;
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
