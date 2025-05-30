const express = require('express');
const http = require('http');
const cors = require('cors');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);

const FRONTEND_URL = 'https://bingo-multiplayer.pages.dev'; // <--- !!! ENSURE THIS MATCHES YOUR DEPLOYED FRONTEND URL !!!

const io = socketIO(server, {
    cors: {
        origin: FRONTEND_URL,
        methods: ['GET', 'POST']
    }
});

const PORT = process.env.PORT || 3000;

// --- Global Game States ---
// Stores game states by gameId: { gameId: { players: [], gameStarted: false, ... } }
let games = {};

// Helper to generate a unique 6-character alphanumeric game ID
function generateGameId() {
    let id;
    do {
        id = Math.random().toString(36).substring(2, 8).toUpperCase();
    } while (games[id]); // Ensure ID is unique
    return id;
}

// --- Helper Functions for Game Logic (now adapted for rooms) ---

/**
 * Emits the current game state to all connected players in a specific room.
 * @param {string} gameId - The ID of the game room.
 */
function emitGameState(gameId) {
    const game = games[gameId];
    if (game) {
        io.to(gameId).emit('gameState', {
            gameStarted: game.gameStarted,
            currentTurnPlayerId: game.currentTurnPlayerId,
            markedNumbers: game.markedNumbers,
            players: game.players.map(p => ({ id: p.id, name: p.name || 'Player' })), // Include player names if added later
            gameId: gameId // Send gameId back to client
        });
        console.log(`[Game ${gameId}] Emitted gameState. Players: ${game.players.length}`);
    }
}

/**
 * Advances the turn to the next player in a specific game room.
 * @param {string} gameId - The ID of the game room.
 */
function advanceTurn(gameId) {
    const game = games[gameId];
    if (!game || !game.gameStarted || game.players.length === 0) {
        return;
    }

    game.turnIndex = (game.turnIndex + 1) % game.players.length;
    game.currentTurnPlayerId = game.players[game.turnIndex].id;
    console.log(`[Game ${gameId}] It's now player ${game.currentTurnPlayerId}'s turn.`);
    emitGameState(gameId); // Notify clients of turn change
}

/**
 * Resets the game state for a specific game room.
 * @param {string} gameId - The ID of the game room.
 */
function resetGame(gameId) {
    const game = games[gameId];
    if (game) {
        console.log(`[Game ${gameId}] Game is being reset.`);
        game.gameStarted = false;
        game.currentTurnPlayerId = null;
        game.markedNumbers = [];
        game.turnIndex = 0;
        io.to(gameId).emit('gameReset'); // Notify all clients in the room
        emitGameState(gameId); // Send initial state after reset
    }
}

/**
 * Removes a player from a game room. If the room becomes empty, it's deleted.
 * @param {string} gameId - The ID of the game room.
 * @param {string} playerId - The ID of the player to remove.
 */
function removePlayerFromGame(gameId, playerId) {
    const game = games[gameId];
    if (game) {
        const initialPlayerCount = game.players.length;
        game.players = game.players.filter(p => p.id !== playerId);
        console.log(`[Game ${gameId}] Player ${playerId} removed. Remaining: ${game.players.length}`);

        if (game.players.length === 0) {
            console.log(`[Game ${gameId}] Game room is empty, deleting.`);
            delete games[gameId]; // Delete the game if no players are left
        } else {
            // If the disconnected player was the current turn holder, advance turn
            if (game.currentTurnPlayerId === playerId && game.gameStarted) {
                advanceTurn(gameId);
            }
            // If game was started and now less than 2 players, reset game
            if (game.gameStarted && game.players.length < 2) {
                console.log(`[Game ${gameId}] Not enough players (${game.players.length}). Game ended.`);
                resetGame(gameId);
            }
            emitGameState(gameId); // Update remaining players in the room
        }
    }
}


// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // Store the gameId the player is currently in
    let playerGameId = null;

    // Handle 'createGame' request
    socket.on('createGame', () => {
        if (playerGameId) {
            socket.emit('error', 'You are already in a game. Please leave current game first.');
            return;
        }

        const gameId = generateGameId();
        games[gameId] = {
            players: [],
            gameStarted: false,
            currentTurnPlayerId: null,
            markedNumbers: [],
            turnIndex: 0,
            hostId: socket.id // Store the host ID if needed
        };
        playerGameId = gameId; // Assign this player to the new game

        socket.join(gameId); // Join the Socket.IO room
        games[gameId].players.push({ id: socket.id, socket: socket }); // Add player to game state

        games[gameId].currentTurnPlayerId = socket.id; // Host starts as first turn
        console.log(`Player ${socket.id} created game: ${gameId}`);
        socket.emit('gameCreated', gameId); // Tell client the new game ID
        emitGameState(gameId); // Send initial state for this room
    });

    // Handle 'joinGame' request
    socket.on('joinGame', (gameId) => {
        if (playerGameId) {
            socket.emit('error', 'You are already in a game. Please leave current game first.');
            return;
        }

        const game = games[gameId];
        if (!game) {
            socket.emit('gameError', 'Game ID not found.');
            console.log(`Player ${socket.id} tried to join non-existent game: ${gameId}`);
            return;
        }
        if (game.gameStarted) {
            socket.emit('gameError', 'Game has already started.');
            console.log(`Player ${socket.id} tried to join started game: ${gameId}`);
            return;
        }

        // Add player to game state
        game.players.push({ id: socket.id, socket: socket });
        playerGameId = gameId; // Assign this player to the game

        socket.join(gameId); // Join the Socket.IO room
        console.log(`Player ${socket.id} joined game: ${gameId}`);

        // If this is the second player, assign turn to the first player if not set
        if (game.players.length === 2 && !game.currentTurnPlayerId) {
            game.currentTurnPlayerId = game.players[0].id;
        }
        socket.emit('gameJoined', gameId); // Confirm successful join
        emitGameState(gameId); // Send updated state to all in room
    });

    // Handle 'startGame' request (now per gameId)
    socket.on('startGame', () => {
        const game = games[playerGameId];
        if (!game) {
            socket.emit('error', 'You are not in a game.');
            return;
        }
        if (!game.gameStarted && game.players.length >= 2) {
            game.gameStarted = true;
            game.turnIndex = 0;
            game.currentTurnPlayerId = game.players[game.turnIndex].id;
            game.markedNumbers = [];
            console.log(`[Game ${playerGameId}] Game started!`);
            emitGameState(playerGameId);
        } else if (game.gameStarted) {
            socket.emit('error', 'Game already in progress.');
        } else {
            socket.emit('error', 'Need at least 2 players to start the game.');
        }
    });

    // Handle number marking (now per gameId)
    socket.on('markNumber', (num) => {
        const game = games[playerGameId];
        if (!game) {
            socket.emit('error', 'You are not in a game.');
            return;
        }
        if (game.gameStarted && socket.id === game.currentTurnPlayerId && !game.markedNumbers.includes(num)) {
            game.markedNumbers.push(num);
            console.log(`[Game ${playerGameId}] Number marked by ${socket.id}: ${num}`);
            io.to(playerGameId).emit('numberMarked', num); // Broadcast to all in room
            advanceTurn(playerGameId);
        } else if (!game.gameStarted) {
            socket.emit('error', 'Game not started. Cannot mark numbers.');
        } else if (socket.id !== game.currentTurnPlayerId) {
            socket.emit('error', 'It is not your turn.');
        } else if (game.markedNumbers.includes(num)) {
            socket.emit('error', 'This number has already been called.');
        }
    });

    // Handle player declaring Bingo/Win (now per gameId)
    socket.on('declareWin', () => {
        const game = games[playerGameId];
        if (!game) {
            socket.emit('error', 'You are not in a game.');
            return;
        }
        if (game.gameStarted && socket.id === game.currentTurnPlayerId) {
            console.log(`[Game ${playerGameId}] Player ${socket.id} declared win!`);
            game.gameStarted = false;
            io.to(playerGameId).emit('playerDeclaredWin', socket.id);
        } else if (!game.gameStarted) {
            socket.emit('error', 'Game is not active. Cannot declare win.');
        } else {
            socket.emit('error', 'It is not your turn to declare win.');
        }
    });

    // Handle chat messages (now per gameId)
    socket.on('sendMessage', (message) => {
        if (!playerGameId) {
            socket.emit('error', 'You must join a game to send messages.');
            return;
        }
        console.log(`[Game ${playerGameId}] Message from ${socket.id}: ${message}`);
        io.to(playerGameId).emit('message', {
            senderId: socket.id,
            message: message
        });
    });

    // Handle game reset request (now per gameId)
    socket.on('resetGame', () => {
        const game = games[playerGameId];
        if (!game) {
            socket.emit('error', 'You are not in a game.');
            return;
        }
        if (game.gameStarted) {
            console.log(`[Game ${playerGameId}] Player ${socket.id} requested game reset.`);
            resetGame(playerGameId);
        } else {
            socket.emit('error', 'No active game to reset.');
        }
    });

    // Handle player disconnection
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        if (playerGameId) {
            removePlayerFromGame(playerGameId, socket.id);
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
