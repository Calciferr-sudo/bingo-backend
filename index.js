const express = require('express');
const http = require('http');
const cors = require('cors');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);

// IMPORTANT: Set your frontend's actual URL here.
// If running locally with Live Server, it's often http://127.0.0.1:5500 or http://localhost:5500
// If hosted on Render, it would be https://your-frontend-app-name.onrender.com
const FRONTEND_URL = 'https://bingo-multiplayer.pages.dev'; // <--- !!! CHANGE THIS !!!

const io = socketIO(server, {
    cors: {
        origin:'https://github.com/Calciferr-sudo/bingo-multiplayer',
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
        markedNumbers: markedNumbers // Send all marked numbers
    });
}

/**
 * Assigns the turn to the next player in the sequence.
 */
function advanceTurn() {
    if (players.length > 0) {
        turnIndex = (turnIndex + 1) % players.length;
        currentTurnPlayerId = players[turnIndex].id;
    } else {
        currentTurnPlayerId = null;
    }
}

/**
 * Resets the game to its initial state.
 */
function resetGame() {
    gameStarted = false;
    currentTurnPlayerId = null;
    markedNumbers = [];
    turnIndex = 0;
    io.emit('gameReset'); // Tell clients to reset their boards
    emitGameState(); // Send the new, reset state
    console.log('Game has been reset.');
}

// --- Socket.IO Connection Handling ---
io.on('connection', socket => {
    console.log(`Player connected: ${socket.id}`);

    // If game is already started and we have 2 players, new player is spectator or denied
    // For this example, we'll keep it simple and disconnect if 2 players are already in a game.
    if (players.length >= 2 && gameStarted) {
        console.log(`Room full. Disconnecting new player: ${socket.id}`);
        socket.emit('roomFull', 'Sorry, the game is full. Please try again later.');
        socket.disconnect();
        return;
    }

    // Add new player to the list
    players.push({ id: socket.id, socket: socket });
    console.log(`Current players: ${players.map(p => p.id)}`);

    // Send initial game state to the newly connected player
    emitGameState();

    // --- Event Listeners for the connected socket ---

    // Handle game start request
    socket.on('startGame', () => {
        if (!gameStarted && players.length >= 2) {
            gameStarted = true;
            // Randomly select the first player to start
            turnIndex = Math.floor(Math.random() * players.length);
            currentTurnPlayerId = players[turnIndex].id;
            markedNumbers = []; // Clear marked numbers for a new game
            console.log(`Game started. First turn for: ${currentTurnPlayerId}`);
            emitGameState(); // Broadcast new game state
        } else if (gameStarted) {
            socket.emit('error', 'Game is already in progress.');
        } else {
            socket.emit('error', 'Need at least 2 players to start the game.');
        }
    });

    // Handle number marking requests
    socket.on('markNumber', num => {
        // Basic validation: Is it this player's turn and is the game started?
        if (gameStarted && socket.id === currentTurnPlayerId) {
            // Further validation: Is the number valid (1-25) and not already marked?
            if (num >= 1 && num <= 25 && !markedNumbers.includes(num)) {
                markedNumbers.push(num);
                io.emit('numberMarked', num); // Broadcast the marked number to all clients
                console.log(`Player ${socket.id} marked: ${num}. Marked numbers: ${markedNumbers}`);
                advanceTurn(); // Move to the next player's turn
                emitGameState(); // Broadcast updated game state (including new turn)
            } else {
                socket.emit('error', 'Invalid number or already marked.');
            }
        } else if (!gameStarted) {
            socket.emit('error', 'Game has not started yet.');
        } else {
            socket.emit('error', 'It is not your turn.');
        }
    });

    // Handle win declaration from a client
    socket.on('declareWin', () => {
        if (gameStarted) {
            // The client already checks for Bingo before declaring win.
            // In a more robust game, you'd re-verify the win condition on the server.
            gameStarted = false; // End the game
            currentTurnPlayerId = null; // No one's turn
            io.emit('playerDeclaredWin', socket.id); // Broadcast winner ID
            console.log(`Player ${socket.id} declared BINGO and won!`);
            emitGameState(); // Send final game state
        }
    });

    // Handle chat messages
    socket.on('sendMessage', message => {
        console.log(`Chat message from ${socket.id}: ${message}`);
        // Broadcast the message to all connected clients
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

// Remove the duplicate server.listen from your original code
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
