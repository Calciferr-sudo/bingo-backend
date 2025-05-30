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
 * Generates a unique, short, and memorable Game ID.
 * @returns {string} A 4-character uppercase alphanumeric ID.
 */
function generateGameId() {
    let gameId;
    do {
        gameId = Math.random().toString(36).substring(2, 6).toUpperCase();
    } while (gameRooms.has(gameId)); // Ensure ID is unique
    return gameId;
}

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
        playerNumber: p.playerNumber // Include playerNumber
    }));

    io.to(gameId).emit('gameState', {
        gameId: gameRoom.gameId,
        players: playersInfo,
        gameStarted: gameRoom.gameStarted,
        currentTurnPlayerId: gameRoom.currentTurnPlayerId,
        markedNumbers: gameRoom.markedNumbers,
        winnerId: gameRoom.winnerId || null, // Add winnerId to state
        draw: gameRoom.draw || false, // NEW: Add draw state to broadcast
        pendingNewMatchRequest: gameRoom.pendingNewMatchRequest || null // Include pending request state
    });
}

/**
 * Advances the turn to the next player in the specified game room.
 * @param {object} gameRoom - The game room object.
 */
function advanceTurn(gameRoom) {
    if (gameRoom.players.length === 0) {
        gameRoom.currentTurnPlayerId = null;
        return;
    }
    gameRoom.turnIndex = (gameRoom.turnIndex + 1) % gameRoom.players.length;
    gameRoom.currentTurnPlayerId = gameRoom.players[gameRoom.turnIndex].id;
    console.log(`Room ${gameRoom.gameId}: Turn advanced to ${gameRoom.currentTurnPlayerId}`);
    emitGameState(gameRoom.gameId);
}

/**
 * Resets a specific game room to its initial state for a new round.
 * @param {string} gameId - The ID of the game room to reset.
 */
function resetGameRound(gameId) {
    const gameRoom = gameRooms.get(gameId);
    if (!gameRoom) {
        console.error(`Attempted to reset non-existent game room: ${gameId}`);
        return;
    }

    console.log(`Resetting game room: ${gameId}`);
    gameRoom.gameStarted = false;
    gameRoom.currentTurnPlayerId = null;
    gameRoom.markedNumbers = [];
    gameRoom.turnIndex = 0;
    gameRoom.winnerId = null; // Clear winner
    gameRoom.draw = false; // NEW: Clear draw state
    gameRoom.pendingNewMatchRequest = null; // Clear any pending requests

    // Re-assign player numbers in case players left/joined
    gameRoom.players.forEach((p, idx) => {
        p.playerNumber = idx + 1;
    });

    io.to(gameId).emit('gameReset'); // Notify clients about reset
    emitGameState(gameId); // Send new state
}

// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // Store the gameId the player is currently in
    let playerCurrentGameId = null;

    // Handle game creation
    socket.on('createGame', (username) => {
        if (playerCurrentGameId) {
            socket.emit('gameError', 'You are already in a game. Please leave or reset it first.');
            return;
        }

        const gameId = generateGameId();
        const newGameRoom = {
            gameId: gameId,
            players: [], // { id, socket, username, playerNumber }
            gameStarted: false,
            currentTurnPlayerId: null,
            markedNumbers: [],
            turnIndex: 0,
            winnerId: null,
            draw: false, // NEW: Initialize draw state
            pendingNewMatchRequest: null // Initialize pending request state
        };
        gameRooms.set(gameId, newGameRoom);

        socket.join(gameId);
        playerCurrentGameId = gameId;

        // Add player to the room
        newGameRoom.players.push({
            id: socket.id,
            socket: socket,
            username: username,
            playerNumber: newGameRoom.players.length + 1
        });
        console.log(`Player ${username} (${socket.id}) created and joined game room: ${gameId}`);

        socket.emit('gameCreated', gameId);
        emitGameState(gameId);
        // Announce new player to existing players in the room (if any)
        io.to(gameId).emit('userJoined', username);
    });

    // Handle joining a game
    socket.on('joinGame', (gameId, username) => {
        if (playerCurrentGameId) {
            socket.emit('gameError', 'You are already in a game. Please leave or reset it first.');
            return;
        }

        const gameRoom = gameRooms.get(gameId);
        if (!gameRoom) {
            socket.emit('gameError', 'Game not found. Please check the ID.');
            return;
        }
        if (gameRoom.players.length >= 2) {
            socket.emit('gameError', 'Game room is full (max 2 players).');
            return;
        }
        if (gameRoom.gameStarted) {
            socket.emit('gameError', 'Game has already started.');
            return;
        }

        socket.join(gameId);
        playerCurrentGameId = gameId;

        // Add player to the room
        gameRoom.players.push({
            id: socket.id,
            socket: socket,
            username: username,
            playerNumber: gameRoom.players.length + 1 // Assign player number
        });
        console.log(`Player ${username} (${socket.id}) joined game room: ${gameId}`);

        socket.emit('gameJoined', gameId);
        emitGameState(gameId);
        // Announce new player to existing players in the room
        io.to(gameId).emit('userJoined', username);
    });

    // Handle starting the game
    socket.on('startGame', () => {
        const gameId = playerCurrentGameId;
        const gameRoom = gameRooms.get(gameId);

        if (!gameRoom) {
            socket.emit('gameError', 'Not in a game room.');
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
        gameRoom.winnerId = null; // Clear winner for new round
        gameRoom.draw = false; // NEW: Clear draw state for new round
        gameRoom.pendingNewMatchRequest = null; // Clear any pending requests
        // Randomly decide who starts first
        gameRoom.turnIndex = Math.floor(Math.random() * gameRoom.players.length);
        gameRoom.currentTurnPlayerId = gameRoom.players[gameRoom.turnIndex].id;
        console.log(`Game ${gameId} started. Player ${gameRoom.players[gameRoom.turnIndex].username} (${gameRoom.currentTurnPlayerId}) starts.`);
        emitGameState(gameId);
    });

    // Handle marking a number
    socket.on('markNumber', (number) => {
        const gameId = playerCurrentGameId;
        const gameRoom = gameRooms.get(gameId);

        if (!gameRoom || !gameRoom.gameStarted) {
            socket.emit('gameError', 'Game not active or not started.');
            return;
        }
        if (gameRoom.currentTurnPlayerId !== socket.id) {
            socket.emit('gameError', 'It is not your turn.');
            return;
        }
        if (gameRoom.markedNumbers.includes(number)) {
            socket.emit('gameError', 'Number already called.');
            return;
        }

        gameRoom.markedNumbers.push(number);
        console.log(`Room ${gameId}: Player ${socket.id} marked number: ${number}`);
        io.to(gameId).emit('numberMarked', number); // Emit to all clients in the room

        // Check for win condition after marking
        // If there's already a winner or it's a draw, don't advance turn
        if (gameRoom.winnerId || gameRoom.draw) { // NEW: Check for draw as well
             console.log(`Game ${gameId} already has a winner (${gameRoom.winnerId}) or is a draw. No more turns.`);
        } else {
             advanceTurn(gameRoom); // Advance turn after marking
        }
    });

    // Handle a player declaring Bingo/Win
    socket.on('declareWin', () => {
        const gameId = playerCurrentGameId;
        const gameRoom = gameRooms.get(gameId);

        if (!gameRoom || gameRoom.gameStarted === false || gameRoom.draw === true) { // NEW: Check if game is already not started or is a draw
            // This means another player already won or declared a win on the same turn.
            // Or the game state is already in a draw.
            if (gameRoom && gameRoom.winnerId && gameRoom.winnerId !== socket.id) {
                // If there's already a winner and it's not THIS player, it's a simultaneous win (draw)
                gameRoom.draw = true; // Set draw state
                gameRoom.gameStarted = false; // Ensure game is marked as not started
                gameRoom.currentTurnPlayerId = null; // No one's turn in a draw
                console.log(`Room ${gameId}: Simultaneous win detected! Player ${socket.id} also declared win.`);
                const lastMarkedNumber = gameRoom.markedNumbers[gameRoom.markedNumbers.length - 1]; // Get the number that caused the draw
                io.to(gameId).emit('gameDraw', { number: lastMarkedNumber }); // NEW: Emit draw event
                emitGameState(gameId); // Update state to reflect draw
            } else {
                // This is a genuine error, e.g., trying to declare win when game hasn't started
                socket.emit('gameError', 'Cannot declare win. Game not active or already won.');
            }
            return;
        }

        // Server sets the winner
        gameRoom.winnerId = socket.id;
        gameRoom.gameStarted = false; // End the game
        gameRoom.currentTurnPlayerId = null; // No one's turn after win
        console.log(`Room ${gameId}: Player ${socket.id} declared win!`);

        // Find the username of the winner to send to clients
        const winner = gameRoom.players.find(p => p.id === socket.id);
        const winningUsername = winner ? winner.username : 'Unknown Player';

        io.to(gameId).emit('playerDeclaredWin', { winnerId: socket.id, winningUsername: winningUsername });
        emitGameState(gameId); // Update state to reflect winner and game ended
    });

    // Handle request for a new match
    socket.on('requestNewMatch', () => {
        const gameId = playerCurrentGameId;
        const gameRoom = gameRooms.get(gameId);

        if (!gameRoom) {
            socket.emit('gameError', 'Not in a game room to request a new match.');
            return;
        }
        if (gameRoom.gameStarted) {
            socket.emit('gameError', 'Game is still in progress. Cannot request new match.');
            return;
        }
        if (gameRoom.players.length < 2) {
            socket.emit('gameError', 'Need two players to request a new match.');
            return;
        }
        if (gameRoom.pendingNewMatchRequest) {
            socket.emit('gameError', 'A new match request is already pending.');
            return;
        }

        const requester = gameRoom.players.find(p => p.id === socket.id);
        const opponent = gameRoom.players.find(p => p.id !== socket.id);

        if (requester && opponent) {
            gameRoom.pendingNewMatchRequest = {
                requesterId: requester.id,
                requesterUsername: requester.username
            };
            opponent.socket.emit('newMatchRequested', requester.username);
            console.log(`Room ${gameId}: ${requester.username} requested new match from ${opponent.username}.`);
            emitGameState(gameId); // Update state to show pending request
        } else {
            socket.emit('gameError', 'Opponent not found in room.');
        }
    });

    // Handle accepting a new match
    socket.on('acceptNewMatch', () => {
        const gameId = playerCurrentGameId;
        const gameRoom = gameRooms.get(gameId);

        if (!gameRoom || !gameRoom.pendingNewMatchRequest || gameRoom.pendingNewMatchRequest.requesterId === socket.id) {
            socket.emit('gameError', 'No pending new match request to accept or you are the requester.');
            return;
        }

        console.log(`Room ${gameId}: Player ${gameRoom.players.find(p => p.id === socket.id)?.username} accepted new match.`);
        resetGameRound(gameId); // Reset the game for a new round
        io.to(gameId).emit('newMatchAccepted'); // Notify both players
        emitGameState(gameId); // Ensure state is broadcast after reset
    });

    // Handle declining a new match
    socket.on('declineNewMatch', () => {
        const gameId = playerCurrentGameId;
        const gameRoom = gameRooms.get(gameId);

        if (!gameRoom || !gameRoom.pendingNewMatchRequest || gameRoom.pendingNewMatchRequest.requesterId === socket.id) {
            socket.emit('gameError', 'No pending new match request to decline or you are the requester.');
            return;
        }

        const requesterId = gameRoom.pendingNewMatchRequest.requesterId;
        const requesterSocket = gameRoom.players.find(p => p.id === requesterId)?.socket;
        const declinerUsername = gameRoom.players.find(p => p.id === socket.id)?.username;

        gameRoom.pendingNewMatchRequest = null; // Clear the pending request
        console.log(`Room ${gameId}: Player ${declinerUsername} declined new match.`);

        if (requesterSocket) {
            requesterSocket.emit('newMatchDeclined', declinerUsername);
        }
        socket.emit('newMatchDeclined', declinerUsername); // Notify decliner as well
        emitGameState(gameId); // Update state to clear pending request
    });


    // Handle chat messages
    socket.on('sendMessage', (message) => {
        const gameId = playerCurrentGameId;
        const gameRoom = gameRooms.get(gameId);

        if (!gameRoom) {
            socket.emit('gameError', 'Not in a game room to send messages.');
            return;
        }

        const sender = gameRoom.players.find(p => p.id === socket.id);
        const senderUsername = sender ? sender.username : `Player-${socket.id.substring(0, 4)}`;

        io.to(gameId).emit('message', {
            senderId: senderUsername, // Send username instead of raw ID
            message: message
        });
    });

    // Handle game reset request (this is now primarily for a full reset, or can be repurposed)
    socket.on('resetGame', () => {
        const gameId = playerCurrentGameId;
        const gameRoom = gameRooms.get(gameId);

        if (!gameRoom) {
            socket.emit('gameError', 'Not in a game room to reset.');
            return;
        }
        // If game is started, prevent direct reset. Must win or disconnect.
        if (gameRoom.gameStarted) {
             socket.emit('gameError', 'Game is in progress. Please wait for a winner or disconnect.');
             return;
        }
        // If there's a pending request, prevent direct reset
        if (gameRoom.pendingNewMatchRequest) {
            socket.emit('gameError', 'A new match request is pending. Please respond or wait.');
            return;
        }

        // This path is now primarily for a full game reset (e.g., after a win, if no request is sent)
        console.log(`Player ${socket.id} requested full game reset for room ${gameId}.`);
        resetGameRound(gameId);
    });

    // Handle player explicitly leaving the game room
    socket.on('leaveGame', () => {
        console.log(`Player ${socket.id} explicitly leaving game.`);
        const gameId = playerCurrentGameId;

        if (gameId && gameRooms.has(gameId)) {
            const gameRoom = gameRooms.get(gameId);
            const leavingPlayer = gameRoom.players.find(p => p.id === socket.id);
            const leavingUsername = leavingPlayer ? leavingPlayer.username : 'Unknown Player';

            // Remove player from the room's player list
            gameRoom.players = gameRoom.players.filter(p => p.id !== socket.id);
            console.log(`Player ${leavingUsername} (${socket.id}) left room ${gameId}.`);
            io.to(gameId).emit('userLeft', leavingUsername); // Notify others in the room

            // Leave the Socket.IO room
            socket.leave(gameId);
            playerCurrentGameId = null; // Clear the game ID on the socket

            // If the leaving player was the current turn holder, advance turn
            if (gameRoom.currentTurnPlayerId === socket.id && gameRoom.gameStarted) {
                if (gameRoom.players.length > 0) {
                    // Re-calculate turnIndex to avoid out-of-bounds if the current player was removed
                    const currentTurnPlayerIndex = gameRoom.players.findIndex(p => p.id === gameRoom.currentTurnPlayerId);
                    gameRoom.turnIndex = (currentTurnPlayerIndex === -1) ? 0 : currentTurnPlayerIndex; // Reset to 0 or current turn if still valid
                    advanceTurn(gameRoom);
                } else {
                    // No players left, clean up the game room
                    console.log(`Last player left from room ${gameId}. Deleting room.`);
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
            } else {
                // If the room was deleted, ensure no state is emitted for it.
            }
        }
    });


    // Handle player disconnection (browser tab close, network issue)
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);

        // Use playerCurrentGameId to find the room they were in
        if (playerCurrentGameId) {
            const gameId = playerCurrentGameId;
            const gameRoom = gameRooms.get(gameId);

            if (gameRoom) {
                const disconnectedPlayer = gameRoom.players.find(p => p.id === socket.id);
                const disconnectedUsername = disconnectedPlayer ? disconnectedPlayer.username : 'Unknown Player';

                // Remove player from the room's player list
                gameRoom.players = gameRoom.players.filter(p => p.id !== socket.id);
                console.log(`Player ${disconnectedUsername} (${socket.id}) disconnected from room ${gameId}.`);
                io.to(gameId).emit('userLeft', disconnectedUsername); // Notify others in the room

                // If the disconnected player was the current turn holder, advance turn
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
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
