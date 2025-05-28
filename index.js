const express = require('express'); 
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

let players = {};
let scoreboard = {};
let currentTimer = null;
let countdown = 10;
let gameActive = true;

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  socket.on('joinGame', (playerName) => {
    players[socket.id] = playerName;
    if (!scoreboard[playerName]) scoreboard[playerName] = 0;
    io.emit('updatePlayers', players);
    io.emit('updateScoreboard', scoreboard);
    if (!gameActive) {
      socket.emit('gameOver', 'Game already ended, please wait for reset.');
    }
  });

  socket.on('markNumber', (num) => {
    if (!gameActive) return;
    io.emit('markNumber', num);
    startCountdown();
  });

 socket.on('declareWin', () => {
  if (!gameActive) return;
  const winnerName = players[socket.id];
  if (winnerName) {
    scoreboard[winnerName] = (scoreboard[winnerName] || 0) + 1;
    io.emit('gameOver', winnerName); // this emits the correct name
    io.emit('updateScoreboard', scoreboard);
    stopCountdown();
    gameActive = false;
  }
});


  socket.on('playAgain', () => {
    gameActive = true;
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
  if (currentTimer) return; // Avoid multiple timers
  countdown = 10;
  io.emit('countdown', countdown);
  currentTimer = setInterval(() => {
    countdown--;
    io.emit('countdown', countdown);
    if (countdown <= 0) {
      stopCountdown();
      io.emit('turnTimeout');
      gameActive = false;
      // Auto-reset after 5 seconds
      setTimeout(() => {
        gameActive = true;
        io.emit('resetGame');
        startCountdown();
      }, 5000);
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
