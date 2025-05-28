const express = require('express'); 
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }  // Allow all origins or restrict to your frontend domain
});

let players = {};
let scoreboard = {};
let currentTimer = null;
let countdown = 10;
let gameActive = true;  // Prevent multiple winners per round

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  socket.on('joinGame', (playerName) => {
    // Optionally check for duplicate names here
    players[socket.id] = playerName;
    if (!scoreboard[playerName]) scoreboard[playerName] = 0;
    io.emit('updatePlayers', players);
    io.emit('updateScoreboard', scoreboard);
    if (!gameActive) {
      socket.emit('gameOver', 'Game already ended, please wait for reset.');
    }
  });

  socket.on('markNumber', (num) => {
    if (!gameActive) return; // Ignore marks if game ended
    io.emit('markNumber', num);
    startCountdown(); // reset or continue countdown
  });

  socket.on('declareWin', () => {
    if (!gameActive) return; // Only first winner counts
    const winnerName = players[socket.id];
    if (winnerName) {
      scoreboard[winnerName] = (scoreboard[winnerName] || 0) + 1;
      io.emit('gameOver', winnerName);
      io.emit('updateScoreboard', scoreboard);
      stopCountdown();
      gameActive = false;
    }
  });

  socket.on('playAgain', () => {
    // Reset for next game
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
  stopCountdown();
  countdown = 10;
  io.emit('countdown', countdown);
  currentTimer = setInterval(() => {
    countdown--;
    io.emit('countdown', countdown);
    if (countdown <= 0) {
      stopCountdown();
      io.emit('turnTimeout');
      // You may want to do something on timeout, e.g. force next turn or reset game
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
