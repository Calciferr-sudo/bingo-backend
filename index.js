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
        origin:FRONTEND_URL,
        methods: ['GET', 'POST']
    }
});

const PORT = process.env.PORT || 3000;

// --- Global Game State Storage ---
// Using a Map to store multiple game rooms, keyed by gameId
const games = new Map(); // gameId -> { players: [], gameStarted: false, currentTurnPlayerId: null, markedNumbers: [], turnIndex: 0 }

// --- Helper Functions ---

/**
 * Generates a unique, short game ID.
 * @returns {string} A 6-character uppercase alphanumeric ID.
 */
function generateGameId() {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

/**
 * Emits the current game state for a specific game room to all players in that room.
 * This keeps all clients synchronized.
 * @param {string} gameId - The ID of the game room to emit state for.
 */
function emitGameState(gameId) {
    const game = games.get(gameId);
    if (!game) {
        console.error(`Attempted to emit state for non-existent game: ${gameId}`);
        return;
    }

    const state = {
        gameId: gameId,
        players: game.players.map(p => ({ id: p.id })), // Send only IDs to clients
        gameStarted: game.gameStarted,
        currentTurnPlayerId: game.currentTurnPlayerId,
        markedNumbers: game.markedNumbers,
        turnIndex: game.turnIndex
    };
    io.to(gameId).emit('gameState', state);
    console.log(`Emitted gameState for game ${gameId}. Started: ${game.gameStarted}, Turn: ${game.currentTurnPlayerId ? game.currentTurnPlayerId.substring(0,5) : 'N/A'}`);
}

/**
 * Advances the turn to the next player in the current game.
 * @param {string} gameId - The ID of the game to advance turn for.
 */
function advanceTurn(gameId) {
    const game = games.get(gameId);
    if (!game || game.players.length === 0) {
        console.log(`Cannot advance turn for game ${gameId}: game not found or no players.`);
        return;
    }
    game.turnIndex = (game.turnIndex + 1) % game.players.length;
    game.currentTurnPlayerId = game.players[game.turnIndex].id;
    console.log(`Game ${gameId}: Turn advanced to ${game.currentTurnPlayerId}`);
    emitGameState(gameId); // Update clients
}

/**
 * Resets the state of a specific game room.
 * @param {string} gameId - The ID of the game to reset.
 */
function resetGame(gameId) {
    const game = games.get(gameId);
    if (!game) {
        console.error(`Attempted to reset non-existent game: ${gameId}`);
        return;
    }

    game.gameStarted = false;
    game.currentTurnPlayerId = null;
    game.markedNumbers = [];
    game.turnIndex = 0;
    // Keep players in the room, just reset game state
    game.players.forEach(p => p.socket.emit('gameReset')); // Notify players in the room
    console.log(`Game ${gameId} has been reset.`);
    emitGameState(gameId); // Update clients with new state
}

// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log(`A player connected: ${socket.id}`);

    // Store the gameId for this socket directly on the socket object
    socket.playerGameId = null;

    // Handle creating a new game
    socket.on('createGame', () => {
        let gameId;
        do {
            gameId = generateGameId();
        } while (games.has(gameId)); // Ensure ID is unique

        games.set(gameId, {
            players: [{ id: socket.id, socket: socket }],
            gameStarted: false,
            currentTurnPlayerId: null,
            markedNumbers: [],
            turnIndex: 0
        });

        socket.join(gameId); // Join the Socket.IO room
        socket.playerGameId = gameId; // Link this socket to the game ID
        console.log(`Player ${socket.id} created and joined game: ${gameId}`);
        socket.emit('gameCreated', gameId); // Confirm creation to the client
        emitGameState(gameId); // Emit initial state for the new game
    });

    // Handle player joining a game
    socket.on('joinGame', (gameId) => {
        // Basic validation
        if (!gameId) {
            return socket.emit('gameError', 'Invalid Game ID provided.');
        }

        let game = games.get(gameId);

        // Check if game exists
        if (!game) {
            console.log(`Game ${gameId} not found. Player ${socket.id} attempted to join.`);
            return socket.emit('gameError', 'Game not found. Please check the ID or create a new game.');
        }

        // Check if the game room is full
        if (game.players.length >= 2) {
            console.log(`Game ${gameId} is full. Player ${socket.id} attempted to join.`);
            return socket.emit('gameError', 'Game room is full. Please try another Game ID or create a new game.');
        }

        // Check if the player is already in this game
        if (game.players.some(p => p.id === socket.id)) {
            console.log(`Player ${socket.id} already in game ${gameId}.`);
            // Just send a success message to the client as they are already in.
            socket.join(gameId); // Ensure they are formally in the room
            socket.playerGameId = gameId; // Link socket to game ID
            return socket.emit('gameJoined', gameId);
        }

        // Add player to the game
        game.players.push({ id: socket.id, socket: socket });
        socket.join(gameId); // Join the Socket.IO room
        socket.playerGameId = gameId; // Link this socket to the game ID
        console.log(`Player ${socket.id} joined game ${gameId}. Current players: ${game.players.map(p => p.id).join(', ')}`);

        socket.emit('gameJoined', gameId); // Confirm to the joining player
        // NEW: Notify other players in the room that a user has joined
        socket.to(gameId).emit('userJoined', socket.id);

        // Emit updated game state to all players in the room
        emitGameState(gameId);
    });

    // Handle game start request
    socket.on('startGame', () => {
        const gameId = socket.playerGameId;
        const game = games.get(gameId);

        if (!game) {
            return socket.emit('gameError', 'You are not in an active game.');
        }

        if (game.gameStarted) {
            return socket.emit('gameError', 'Game has already started.');
        }

        if (game.players.length < 2) {
            return socket.emit('gameError', 'Need at least 2 players to start the game.');
        }

        game.gameStarted = true;
        game.currentTurnPlayerId = game.players[game.turnIndex].id; // Assign first turn
        console.log(`Game ${gameId} started! First turn: ${game.currentTurnPlayerId}`);
        emitGameState(gameId); // Update clients
    });

    // Handle a player marking a number
    socket.on('markNumber', (num) => {
        const gameId = socket.playerGameId;
        const game = games.get(gameId);

        if (!game) {
            return socket.emit('gameError', 'You are not in an active game.');
        }

        if (!game.gameStarted) {
            return socket.emit('gameError', 'Game has not started yet.');
        }

        if (socket.id !== game.currentTurnPlayerId) {
            // This is one of the messages that will now trigger the temporary notification
            return socket.emit('gameError', 'It is not your turn.');
        }

        if (game.markedNumbers.includes(num)) {
            // This is one of the messages that will now trigger the temporary notification
            return socket.emit('gameError', 'Number already called.');
        }

        game.markedNumbers.push(num);
        console.log(`Player ${socket.id} marked number ${num} in game ${gameId}.`);
        io.to(gameId).emit('numberMarked', num); // Broadcast to all in the room
        advanceTurn(gameId); // Move to next player's turn
    });

    // Handle a player declaring Bingo
    socket.on('declareWin', () => {
        const gameId = socket.playerGameId;
        const game = games.get(gameId);

        if (!game) {
            return socket.emit('gameError', 'You are not in an active game.');
        }

        if (!game.gameStarted) {
            return socket.emit('gameError', 'Game has not started yet.');
        }

        game.gameStarted = false; // End the game
        console.log(`Player ${socket.id} declared win in game ${gameId}!`);
        io.to(gameId).emit('playerDeclaredWin', socket.id); // Broadcast winner to all in the room
        emitGameState(gameId); // Update state to reflect game ended
    });

    // Handle chat messages
    socket.on('sendMessage', (message) => {
        const gameId = socket.playerGameId;
        if (gameId) {
            console.log(`Player ${socket.id} (Game ${gameId}): ${message}`);
            io.to(gameId).emit('message', {
                senderId: socket.id,
                message: message
            });
        } else {
            socket.emit('gameError', 'You must be in a game to send messages.');
        }
    });

    // Handle game reset request
    socket.on('resetGame', () => {
        const gameId = socket.playerGameId;
        const game = games.get(gameId);

        if (!game) {
            return socket.emit('gameError', 'You are not in an active game.');
        }

        console.log(`Player ${socket.id} requested game reset for game ${gameId}.`);
        resetGame(gameId);
    });

    // Handle player disconnection
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        const gameId = socket.playerGameId;

        if (gameId && games.has(gameId)) {
            const game = games.get(gameId);

            // NEW: Notify other players in the room that a user has left BEFORE removing them from the list
            socket.to(gameId).emit('userLeft', socket.id); // Emit to others in the room (not self)

            game.players = game.players.filter(p => p.id !== socket.id); // Remove disconnected player

            console.log(`Player ${socket.id} left game ${gameId}. Remaining players: ${game.players.length}`);

            if (game.players.length === 0) {
                // If no players left, delete the game room
                games.delete(gameId);
                console.log(`Game ${gameId} deleted as no players remain.`);
            } else {
                // If the disconnected player was supposed to be the current turn holder, advance turn
                if (game.gameStarted && game.currentTurnPlayerId === socket.id) {
                    if (game.players.length > 0) {
                        // Re-calculate turnIndex to avoid out-of-bounds if the current player was removed
                        const currentTurnPlayerIndex = game.players.findIndex(p => p.id === game.currentTurnPlayerId);
                        game.turnIndex = (currentTurnPlayerIndex === -1) ? 0 : currentTurnPlayerIndex; // Reset to 0 or current turn if still valid
                        advanceTurn(gameId);
                    } else {
                        // This case should be caught by game.players.length === 0, but as a fallback
                        resetGame(gameId);
                    }
                }

                // If game was started and now less than 2 players, reset game
                if (game.gameStarted && game.players.length < 2) {
                    console.log(`Game ${gameId}: Not enough players (${game.players.length}). Game ended.`);
                    resetGame(gameId); // This will also emit gameState
                } else {
                    emitGameState(gameId); // Update game state for remaining players
                }
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
