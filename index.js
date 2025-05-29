const express = require('express');
const http = require('http');
const cors = require('cors');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);

// IMPORTANT: Set your frontend's actual URL here.
// If running locally with Live Server, it's often http://127.0.0.1:5500 or http://localhost:5500
// If hosted on Cloudflare Pages, it would be the URL like 'https://your-app-name.pages.dev'
const FRONTEND_URL = 'https://bingo-multiplayer.pages.dev'; // <--- !!! ENSURE THIS MATCHES YOUR DEPLOYED FRONTEND URL !!!

const io = socketIO(server, {
    cors: {
        origin: FRONTEND_URL,
        methods: ['GET', 'POST']
    }
});

const PORT = process.env.PORT || 3000;

// --- Global Game State ---
let players = []; // Stores { id: socket.id, socket: socket }
let gameStarted = false;
let currentTurnPlayerId = null; // The ID of the player whose turn it is
let markedNumbers = []; // Numbers that have been called/marked globally
let turnIndex = 0; // Index in the players array for whose turn it is

// --- Helper Functions ---

/**
 * Emits the current game state to all connected players.
 * This keeps all clients synchronized.
 */
function emitGameState() {
    io.emit('gameState', {
        gameStarted: gameStarted,
        currentTurnPlayerId: currentTurnPlayerId,
        markedNumbers: markedNumbers,
        players: players.map(p => ({ id: p.id })) // Ensure 'players' is always sent
    });
}

/**
 * Advances the turn to the next player in the 'players' array.
 * If no players, or game not started, does nothing.
 */
function advanceTurn() {
    if (!gameStarted || players.length === 0) {
        currentTurnPlayerId = null;
        return;
    }

    turnIndex = (turnIndex + 1) % players.length;
    currentTurnPlayerId = players[turnIndex].id;
    console.log(`It's now player ${currentTurnPlayerId}'s turn.`);
    emitGameState(); // Notify clients of turn change
}

/**
 * Resets the game state to its initial values.
 * This function handles both manual reset and game-over reset.
 */
function resetGame() {
    console.log('Game is being reset.');
    gameStarted = false;
    currentTurnPlayerId = null;
    markedNumbers = [];
    turnIndex = 0; // Reset turn index
    // Do NOT clear the 'players' array here, as players might still be connected
    io.emit('gameReset'); // Notify all clients about the reset
    emitGameState(); // Send initial state after reset
}

// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);
    players.push({ id: socket.id, socket: socket }); // Add new player to the list

    // If this is the first player, assign turn to them
    if (players.length === 1) {
        currentTurnPlayerId = socket.id;
    } else if (!gameStarted && players.length > 1 && currentTurnPlayerId === null) {
        // If game not started and new player joins, and no current turn holder,
        // assign turn to the first player in the list
        currentTurnPlayerId = players[0].id;
    }

    emitGameState(); // Send current game state to the newly connected player

    // Handle game start request
    socket.on('startGame', () => {
        if (!gameStarted && players.length >= 2) {
            gameStarted = true;
            turnIndex = 0; // Start with the first player
            currentTurnPlayerId = players[turnIndex].id;
            markedNumbers = []; // Clear marked numbers for a new game
            console.log('Game started!');
            emitGameState(); // Update all clients that game has started
        } else if (gameStarted) {
            socket.emit('error', 'Game already in progress.');
        } else {
            socket.emit('error', 'Need at least 2 players to start the game.');
        }
    });

    // Handle number marking (calling a number)
    socket.on('markNumber', (num) => {
        // Ensure it's the current player's turn and the number hasn't been marked yet
        if (gameStarted && socket.id === currentTurnPlayerId && !markedNumbers.includes(num)) {
            markedNumbers.push(num); // Add number to globally marked list
            console.log(`Number marked by ${socket.id}: ${num}`);
            io.emit('numberMarked', num); // Broadcast to all clients that number was marked
            advanceTurn(); // Move to the next player's turn
        } else if (!gameStarted) {
            socket.emit('error', 'Game not started. Cannot mark numbers.');
        } else if (socket.id !== currentTurnPlayerId) {
            socket.emit('error', 'It is not your turn.');
        } else if (markedNumbers.includes(num)) {
            socket.emit('error', 'This number has already been called.');
        }
    });

    // Handle player declaring Bingo/Win
    socket.on('declareWin', () => {
        // Implement logic to verify if the player actually won (e.g., check their board state)
        // For simplicity, we'll assume the client correctly determined bingo
        if (gameStarted && socket.id === currentTurnPlayerId) { // Only allow if it's their turn and game is active
            console.log(`Player ${socket.id} declared win!`);
            gameStarted = false; // End the game
            io.emit('playerDeclaredWin', socket.id); // Broadcast the winner
        } else if (!gameStarted) {
            socket.emit('error', 'Game is not active. Cannot declare win.');
        } else {
            socket.emit('error', 'It is not your turn to declare win.');
        }
    });

    // Handle chat messages
    socket.on('sendMessage', (message) => {
        console.log(`Message from ${socket.id}: ${message}`);
        io.emit('message', {
            senderId: socket.id,
            message: message
        });
    });

    // Handle game reset request
    socket.on('resetGame', () => {
        if (gameStarted) { // Only allow reset if a game is active
             console.log(`Player ${socket.id} requested game reset.`);
             resetGame();
        } else {
            socket.emit('error', 'No active game to reset.');
        }
    });

    // Handle player disconnection
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        players = players.filter(p => p.id !== socket.id); // Remove disconnected player

        // If the disconnected player was supposed to be the current turn holder, advance turn
        if (currentTurnPlayerId === socket.id && gameStarted) {
            if (players.length > 0) {
                 advanceTurn();
            } else {
                // No players left, reset the game fully
                resetGame();
            }
        }

        // If game was started and now less than 2 players, reset game
        if (gameStarted && players.length < 2) {
            console.log('Not enough players. Game ended.');
            resetGame();
        }

        console.log(`Remaining players: ${players.map(p => p.id)}`);
        emitGameState(); // Update game state for remaining players
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
