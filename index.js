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

// --- Game Rooms State ---
// Stores gameId -> { game_state_object }
const gameRooms = new Map();

// --- Helper Functions ---

/**
 * Emits the current game state for a specific room to all players in that room.
 * @param {string} gameId - The ID of the game room.
 */
function emitGameState(gameId) {
    const gameRoom = gameRooms.get(gameId);
    if (!gameRoom) {
        console.error(`Attempted to emit state for non-existent room: ${gameId}`);
        return;
    }

    // Prepare state to send to clients. Exclude sensitive data like socket objects.
    const playersInfo = gameRoom.players.map(p => ({
        id: p.id,
        username: p.username,
        playerNumber: p.playerNumber // Send player number
    }));

    io.to(gameId).emit('gameState', {
        gameId: gameId,
        gameStarted: gameRoom.gameStarted,
        currentTurnPlayerId: gameRoom.currentTurnPlayerId,
        markedNumbers: gameRoom.markedNumbers,
        players: playersInfo // Send player array with usernames
    });
}

/**
 * Assigns the turn to the next player in the sequence for a given game room.
 * @param {object} gameRoom - The game room object.
 */
function advanceTurn(gameRoom) {
    if (gameRoom.players.length > 0) {
        gameRoom.turnIndex = (gameRoom.turnIndex + 1) % gameRoom.players.length;
        gameRoom.currentTurnPlayerId = gameRoom.players[gameRoom.turnIndex].id;
    } else {
        gameRoom.currentTurnPlayerId = null;
    }
}

/**
 * Resets a single game round to its initial state within a room.
 * @param {string} gameId - The ID of the game room.
 */
function resetGameRound(gameId) {
    const gameRoom = gameRooms.get(gameId);
    if (!gameRoom) return;

    gameRoom.gameStarted = false;
    gameRoom.currentTurnPlayerId = null;
    gameRoom.markedNumbers = [];
    gameRoom.turnIndex = 0;

    io.to(gameId).emit('gameReset'); // Tell clients to reset their boards
    emitGameState(gameId); // Send the new, reset state
    console.log(`Game round in room ${gameId} has been reset.`);
}

/**
 * Generates a random 6-character alphanumeric game ID.
 * @returns {string} The generated game ID.
 */
function generateGameId() {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    do {
        result = '';
        for (let i = 0; i < 6; i++) {
            result += characters.charAt(Math.floor(Math.random() * characters.length));
        }
    } while (gameRooms.has(result)); // Ensure ID is unique
    return result;
}

// --- Socket.IO Connection Handling ---
io.on('connection', socket => {
    console.log(`Player connected: ${socket.id}`);
    
    // Store gameId directly on socket for easy access
    socket.gameId = null;

    // Handle game creation request
    socket.on('createGame', (username) => {
        if (socket.gameId) {
            socket.emit('gameError', 'You are already in a game. Please leave current game first.');
            return;
        }

        const gameId = generateGameId();
        const playerNumber = 1; // First player in a new room is Player 1

        // Initialize new game room state
        gameRooms.set(gameId, {
            players: [], // Initialize as empty, then add player
            gameStarted: false,
            currentTurnPlayerId: null,
            markedNumbers: [],
            turnIndex: 0,
            playerUsernames: {} // Store usernames for easy lookup
        });

        const gameRoom = gameRooms.get(gameId);
        // Add player to game with playerNumber 1
        gameRoom.players.push({ id: socket.id, socket: socket, username: username, playerNumber: playerNumber });
        gameRoom.playerUsernames[socket.id] = username; // Store username

        socket.join(gameId);
        socket.gameId = gameId; // Store the game ID on the socket
        socket.emit('gameCreated', gameId); // Confirm creation to the client
        console.log(`Game created by ${username} (${socket.id}). Game ID: ${gameId}`);
        emitGameState(gameId);
    });

    // Handle game join request
    socket.on('joinGame', (gameId, username) => {
        if (socket.gameId) {
            socket.emit('gameError', 'You are already in a game. Please leave current game first.');
            return;
        }

        const gameRoom = gameRooms.get(gameId);

        if (!gameRoom) {
            socket.emit('gameError', 'Game not found. Please check the ID or create a new game.');
            console.log(`Join failed: Game ${gameId} not found.`);
            return;
        }

        if (gameRoom.players.length >= 2) {
            socket.emit('gameError', 'Game is full (max 2 players).');
            console.log(`Join failed: Game ${gameId} is full.`);
            return;
        }

        // Check if the player is already in this game (re-joining scenario)
        if (gameRoom.players.some(p => p.id === socket.id)) {
            console.log(`Player ${username} (${socket.id}) already in game ${gameId}. Re-joining.`);
            socket.join(gameId); // Ensure they are formally in the room
            socket.gameId = gameId; // Link socket to game ID
            return socket.emit('gameJoined', gameId);
        }

        const playerNumber = gameRoom.players.length === 0 ? 1 : 2;
        gameRoom.players.push({ id: socket.id, socket: socket, username: username, playerNumber: playerNumber });
        gameRoom.playerUsernames[socket.id] = username; // Store username

        socket.join(gameId);
        socket.gameId = gameId; // Store the game ID on the socket
        socket.emit('gameJoined', gameId);
        io.to(gameId).emit('userJoined', username); // Notify others in the room
        console.log(`Player ${username} (${socket.id}) joined game ${gameId}. Current players: ${gameRoom.players.map(p => p.username).join(', ')}`);
        emitGameState(gameId);
    });

    // Handle game start request
    socket.on('startGame', () => {
        const gameId = socket.gameId;
        const gameRoom = gameRooms.get(gameId);

        if (!gameRoom) {
            socket.emit('gameError', 'Not in a game.');
            return;
        }

        if (gameRoom.gameStarted) {
            socket.emit('gameError', 'Game has already started.');
            return;
        }

        if (gameRoom.players.length < 2) {
            socket.emit('gameError', 'Need at least 2 players to start the game.');
            return;
        }

        gameRoom.gameStarted = true;
        gameRoom.markedNumbers = []; // Clear marked numbers for a new game round

        // Randomly select the first player for this round
        gameRoom.turnIndex = Math.floor(Math.random() * gameRoom.players.length);
        gameRoom.currentTurnPlayerId = gameRoom.players[gameRoom.turnIndex].id;
        
        console.log(`Game started in room ${gameId}. First turn for: ${gameRoom.playerUsernames[gameRoom.currentTurnPlayerId]}`);
        emitGameState(gameId); // Broadcast new game state
    });

    // Handle a player marking a number
    socket.on('markNumber', num => {
        const gameId = socket.gameId;
        const gameRoom = gameRooms.get(gameId);

        if (!gameRoom) {
            socket.emit('gameError', 'Not in a game.');
            return;
        }

        // Basic validation: Is it this player's turn and is the game started?
        if (gameRoom.gameStarted && socket.id === gameRoom.currentTurnPlayerId) {
            // Further validation: Is the number valid (1-25) and not already marked?
            if (num >= 1 && num <= 25 && !gameRoom.markedNumbers.includes(num)) {
                gameRoom.markedNumbers.push(num);
                io.to(gameId).emit('numberMarked', num); // Broadcast the marked number to all clients
                console.log(`Player ${gameRoom.playerUsernames[socket.id]} marked: ${num} in room ${gameId}. Marked numbers: ${gameRoom.markedNumbers}`);
                advanceTurn(gameRoom); // Move to the next player's turn
                emitGameState(gameId); // Broadcast updated game state (including new turn)
            } else {
                socket.emit('gameError', 'Invalid number or already marked.');
            }
        } else if (!gameRoom.gameStarted) {
            socket.emit('gameError', 'Game has not started yet.');
        } else {
            socket.emit('gameError', 'It is not your turn.');
        }
    });

    // Handle win declaration from a client
    socket.on('declareWin', () => {
        const gameId = socket.gameId;
        const gameRoom = gameRooms.get(gameId);

        if (!gameRoom) {
            socket.emit('gameError', 'Not in a game.');
            return;
        }

        if (gameRoom.gameStarted) {
            gameRoom.gameStarted = false; // End the current round
            gameRoom.currentTurnPlayerId = null; // No one's turn
            
            const winnerUsername = gameRoom.playerUsernames[socket.id] || socket.id;
            io.to(gameId).emit('playerDeclaredWin', winnerUsername); // Broadcast winner's username
            console.log(`Player ${winnerUsername} (${socket.id}) declared BINGO and won round in ${gameId}!`);
            
            emitGameState(gameId); // Emit the updated state to reflect game ended
        }
    });

    // Handle chat messages
    socket.on('sendMessage', message => {
        const gameId = socket.gameId;
        const gameRoom = gameRooms.get(gameId);

        if (!gameRoom) {
            socket.emit('gameError', 'Not in a game to send messages.');
            return;
        }

        const senderUsername = gameRoom.playerUsernames[socket.id] || socket.id;
        io.to(gameId).emit('message', {
            senderId: senderUsername, // Send username instead of raw socket ID
            message: message
        });
        console.log(`Chat message from ${senderUsername} in room ${gameId}: ${message}`);
    });

    // Handle game reset request (for current round only)
    socket.on('resetGame', () => {
        const gameId = socket.gameId;
        const gameRoom = gameRooms.get(gameId);

        if (!gameRoom) {
            socket.emit('gameError', 'Not in a game.');
            return;
        }

        // Only allow reset if game is not started (i.e., after a win or before start)
        if (!gameRoom.gameStarted) {
            console.log(`Player ${gameRoom.playerUsernames[socket.id]} requested game reset for room ${gameId}.`);
            resetGameRound(gameId);
        } else {
            socket.emit('gameError', 'Game is in progress. Please wait for a winner or disconnect.');
        }
    });

    // Handle player disconnection
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        const gameId = socket.gameId;

        if (gameId && gameRooms.has(gameId)) {
            const gameRoom = gameRooms.get(gameId);
            const disconnectedPlayerUsername = gameRoom.playerUsernames[socket.id] || socket.id;

            // Remove player from the room
            gameRoom.players = gameRoom.players.filter(p => p.id !== socket.id);
            delete gameRoom.playerUsernames[socket.id]; // Clean up username

            io.to(gameId).emit('userLeft', disconnectedPlayerUsername); // Notify others in the room

            // If the disconnected player was supposed to be the current turn holder, advance turn
            if (gameRoom.currentTurnPlayerId === socket.id && gameRoom.gameStarted) {
                if (gameRoom.players.length > 0) {
                    // Re-calculate turnIndex to avoid out-of-bounds if the current player was removed
                    const currentTurnPlayerIndex = gameRoom.players.findIndex(p => p.id === gameRoom.currentTurnPlayerId);
                    gameRoom.turnIndex = (currentTurnPlayerIndex === -1) ? 0 : currentTurnPlayerIndex; // Reset to 0 or current turn if still valid
                    advanceTurn(gameRoom);
                } else {
                    // No players left, clean up the game room
                    console.log(`Last player disconnected from room ${gameId}. Deleting room.`);
                    gameRooms.delete(gameId);
                }
            }

            // If game was started and now less than 2 players, reset game round
            if (gameRoom.gameStarted && gameRoom.players.length < 2) {
                console.log(`Not enough players in room ${gameId}. Game round ended.`);
                resetGameRound(gameId);
            }
            
            // If the room still exists (e.g., one player left), emit updated state
            if (gameRooms.has(gameId)) {
                emitGameState(gameId);
            }
        }
        // If player wasn't in a game, nothing to do here
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
