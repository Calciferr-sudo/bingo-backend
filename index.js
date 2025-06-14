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

// This is the /ping endpoint that the keep-alive service needs to hit.
// It responds with a 200 OK and "pong".
app.get('/ping', (req, res) => {
    console.log('Received /ping request.'); // Log for debugging
    res.status(200).send('pong');
});

// --- Game Rooms State ---
// Stores gameId -> { game_state_object }
const gameRooms = new Map();

// NEW: AI Player Constants
const AI_PLAYER_ID = 'AI-PLAYER';
const AI_USERNAME = 'BingoBot';

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
        playerNumber: p.playerNumber,
        isReady: p.isReady // Include readiness status
    }));

    io.to(gameId).emit('gameState', {
        gameId: gameId,
        players: playersInfo,
        gameStarted: gameRoom.gameStarted,
        currentTurnPlayerId: gameRoom.currentTurnPlayerId,
        markedNumbers: gameRoom.markedNumbers,
        winnerId: gameRoom.winnerId,
        draw: gameRoom.draw, // Include draw status
        pendingNewMatchRequest: gameRoom.pendingNewMatchRequest ? {
            requesterId: gameRoom.pendingNewMatchRequest.requesterId,
            requesterUsername: gameRoom.pendingNewMatchRequest.requesterUsername
        } : null
    });
}

/**
 * Generates a unique 4-character alphanumeric ID for a game room.
 * @returns {string} - The generated game ID.
 */
function generateGameId() {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const charactersLength = characters.length;
    for (let i = 0; i < 4; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    // Ensure uniqueness
    if (gameRooms.has(result)) {
        return generateGameId(); // Recursively call until unique
    }
    return result;
}

/**
 * Resets a game room to its initial state for a new round.
 * @param {string} gameId - The ID of the game room to reset.
 */
function resetGameRound(gameId) {
    const gameRoom = gameRooms.get(gameId);
    if (gameRoom) {
        console.log(`Resetting game round for room ${gameId}.`);
        gameRoom.gameStarted = false;
        gameRoom.markedNumbers = [];
        gameRoom.currentTurnPlayerId = null;
        gameRoom.turnIndex = 0;
        gameRoom.winnerId = null; // Clear winner
        gameRoom.draw = false; // Clear draw status
        gameRoom.pendingNewMatchRequest = null; // Clear any pending requests

        // Reset player readiness for new round, but keep AI's 'ready' state if it's an AI game
        gameRoom.players.forEach(p => {
            if (p.id !== AI_PLAYER_ID) { // Only reset human player readiness
                p.isReady = false;
            }
        });

        io.to(gameId).emit('gameReset'); // Notify clients of reset
        emitGameState(gameId); // Update clients with new state
    }
}


/**
 * Advances the turn to the next player in the game room.
 * @param {object} gameRoom - The game room object.
 */
function advanceTurn(gameRoom) {
    if (gameRoom.players.length === 0) {
        gameRoom.currentTurnPlayerId = null;
        return;
    }
    gameRoom.turnIndex = (gameRoom.turnIndex + 1) % gameRoom.players.length;
    gameRoom.currentTurnPlayerId = gameRoom.players[gameRoom.turnIndex].id;
    console.log(`Turn advanced in room ${gameRoom.gameId}. Current turn: ${gameRoom.currentTurnPlayerId}`);
}

// NEW: Function to broadcast online players count
function broadcastOnlinePlayersCount() {
    // io.engine.clientsCount gives the total number of connected Socket.IO clients
    const onlineCount = io.engine.clientsCount;
    io.emit('onlinePlayersCount', onlineCount);
    console.log(`Currently online players: ${onlineCount}`);
}

// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);
    broadcastOnlinePlayersCount(); // Broadcast count on every new connection

    let playerCurrentGameId = null; // To keep track of the gameId this socket is in

    // --- Lobby Actions ---

    // Create Game
    socket.on('createGame', (username) => {
        if (playerCurrentGameId) {
            socket.emit('gameError', 'Already in a game. Please leave first.');
            return;
        }

        const gameId = generateGameId();
        const newGameRoom = {
            gameId: gameId,
            players: [], // { id, username, playerNumber, isReady }
            gameStarted: false,
            markedNumbers: [], // Numbers called in this game
            currentTurnPlayerId: null,
            turnIndex: 0,
            winnerId: null, // ID of the player who won
            draw: false, // true if game ended in a draw
            pendingNewMatchRequest: null // { requesterId, requesterUsername }
        };
        gameRooms.set(gameId, newGameRoom);
        playerCurrentGameId = gameId;

        const playerNumber = newGameRoom.players.length + 1;
        newGameRoom.players.push({ id: socket.id, username: username, playerNumber: playerNumber, isReady: false });
        socket.join(gameId);
        socket.emit('gameCreated', gameId);
        console.log(`Player ${username} (${socket.id}) created and joined game ${gameId}`);
        io.to(gameId).emit('userJoined', username); // Notify others in room
        emitGameState(gameId);
    });

    // NEW: Create AI Game
    socket.on('createAIGame', (username) => {
        if (playerCurrentGameId) {
            socket.emit('gameError', 'Already in a game. Please leave first.');
            return;
        }

        const gameId = generateGameId();
        const newGameRoom = {
            gameId: gameId,
            players: [], // { id, username, playerNumber, isReady }
            gameStarted: false,
            markedNumbers: [], // Numbers called in this game
            currentTurnPlayerId: null,
            turnIndex: 0,
            winnerId: null,
            draw: false,
            pendingNewMatchRequest: null,
            isAIGame: true // Flag to indicate this is an AI game
        };
        gameRooms.set(gameId, newGameRoom);
        playerCurrentGameId = gameId;

        // Add Human Player
        newGameRoom.players.push({ id: socket.id, username: username, playerNumber: 1, isReady: false });
        // Add AI Player
        newGameRoom.players.push({ id: AI_PLAYER_ID, username: AI_USERNAME, playerNumber: 2, isReady: true }); // AI is always ready

        socket.join(gameId);
        socket.emit('aiGameCreated', gameId); // Different event for AI game creation
        console.log(`Player ${username} (${socket.id}) created and joined AI game ${gameId}`);
        emitGameState(gameId); // Emit initial state including AI
    });


    // Join Game
    socket.on('joinGame', (gameId, username) => {
        if (playerCurrentGameId) {
            socket.emit('gameError', 'Already in a game. Please leave first.');
            return;
        }

        const gameRoom = gameRooms.get(gameId);
        if (!gameRoom) {
            socket.emit('gameError', 'Game not found. Please check the ID.');
            return;
        }
        // NEW: Prevent joining AI games
        if (gameRoom.isAIGame) {
            socket.emit('gameError', 'This is an AI game. You cannot join it.');
            return;
        }

        if (gameRoom.players.length >= 2) {
            socket.emit('gameError', 'Game room is full (max 2 players).');
            return;
        }
        if (gameRoom.gameStarted) {
            socket.emit('gameError', 'Game has already started. Cannot join.');
            return;
        }

        playerCurrentGameId = gameId;
        const playerNumber = gameRoom.players.length + 1;
        gameRoom.players.push({ id: socket.id, username: username, playerNumber: playerNumber, isReady: false });
        socket.join(gameId);
        socket.emit('gameJoined', gameId);
        console.log(`Player ${username} (${socket.id}) joined game ${gameId}`);
        io.to(gameId).emit('userJoined', username); // Notify others in room
        emitGameState(gameId);
    });

    // Player leaves game
    socket.on('leaveGame', () => {
        const gameId = playerCurrentGameId;
        if (!gameId) {
            socket.emit('gameError', 'Not in a game.');
            return;
        }

        const gameRoom = gameRooms.get(gameId);
        if (gameRoom) {
            // NEW: Get leaving player info BEFORE filtering
            const leavingPlayer = gameRoom.players.find(p => p.id === socket.id);
            const leavingUsername = (leavingPlayer && leavingPlayer.username) || 'A player'; 

            // Remove player from the game room
            gameRoom.players = gameRoom.players.filter(p => p.id !== socket.id);
            console.log(`Player ${socket.id} left room ${gameId}. Remaining players: ${gameRoom.players.length}`);

            // Notify other players (if any remain)
            if (gameRoom.players.length > 0) {
                io.to(gameId).emit('userLeft', leavingUsername); // Emits the username
            }

            // If it was an AI game and the human player left, delete the room
            if (gameRoom.isAIGame && gameRoom.players.length === 1 && gameRoom.players[0].id === AI_PLAYER_ID) {
                console.log(`Human player left AI game ${gameId}. Deleting room.`);
                gameRooms.delete(gameId);
            }
            // If game was started and now less than 2 players (and not an AI game where AI is the only one left), reset game round
            else if (gameRoom.gameStarted && gameRoom.players.length < 2 && !gameRoom.isAIGame) {
                console.log(`Not enough players in room ${gameId}. Game round ended.`);
                resetGameRound(gameId); // This also handles emitting gameState
            } else if (gameRoom.players.length === 0) {
                // If no players left, clean up the game room
                console.log(`Last player left room ${gameId}. Deleting room.`);
                gameRooms.delete(gameId);
            } else {
                // If players remain, re-evaluate turn and emit updated state
                if (gameRoom.currentTurnPlayerId === socket.id && gameRoom.gameStarted) {
                    advanceTurn(gameRoom); // Advance turn if it was their turn
                }
                emitGameState(gameId); // Update state for remaining players
            }
        }
        socket.leave(gameId);
        playerCurrentGameId = null; // Clear the player's current game ID
        broadcastOnlinePlayersCount(); // Update count after a player leaves
    });


    // --- Game Actions ---

    // Start Game
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
        // For AI games, only 1 human player is needed to start
        const minPlayers = gameRoom.isAIGame ? 1 : 2;
        if (gameRoom.players.length < minPlayers) {
            socket.emit('gameError', `Need at least ${minPlayers} players to start the game.`);
            return;
        }

        // Mark all players as ready (or implement a ready-up system if desired)
        gameRoom.players.forEach(p => p.isReady = true);

        gameRoom.gameStarted = true;
        gameRoom.currentTurnPlayerId = gameRoom.players[0].id; // First player starts
        console.log(`Game ${gameId} started. Player ${gameRoom.currentTurnPlayerId} starts.`);
        emitGameState(gameId);
    });

    // Mark Number
    socket.on('markNumber', (number) => {
        const gameId = playerCurrentGameId;
        const gameRoom = gameRooms.get(gameId);

        if (!gameRoom || !gameRoom.gameStarted || gameRoom.winnerId || gameRoom.draw) {
            socket.emit('gameError', 'Game not active or already ended.');
            return;
        }
        // Allow AI to mark if it's its turn
        if (gameRoom.currentTurnPlayerId !== socket.id && gameRoom.currentTurnPlayerId !== AI_PLAYER_ID) {
            socket.emit('gameError', 'It is not your turn.');
            return;
        }
        // If it's an AI game and AI is marking, ensure the socket ID matches AI_PLAYER_ID
        if (gameRoom.isAIGame && gameRoom.currentTurnPlayerId === AI_PLAYER_ID && socket.id !== AI_PLAYER_ID) {
             // This condition prevents a human from "marking" for the AI
             // However, the AI itself doesn't have a socket.id, so this check is for human trying to cheat.
             // The AI logic will directly call markNumber on the server, which is fine.
        }

        if (gameRoom.markedNumbers.includes(number)) {
            socket.emit('gameError', 'Number already called.');
            return;
        }

        gameRoom.markedNumbers.push(number);
        console.log(`Room ${gameId}: Player ${gameRoom.currentTurnPlayerId} marked number ${number}.`);
        io.to(gameId).emit('numberMarked', number); // Broadcast to all players
        advanceTurn(gameRoom); // Advance turn after number is marked
        emitGameState(gameId); // Update state
    });

    // Declare Win
    socket.on('declareWin', () => {
        const gameId = playerCurrentGameId;
        const gameRoom = gameRooms.get(gameId);

        if (!gameRoom || gameRoom.gameStarted === false || gameRoom.draw === true) {
            // Case 1: Game is not active, already won, or already a draw.
            // If it's won by another player and this declareWin comes in for the same game context, it's a draw.
            if (gameRoom && gameRoom.winnerId && gameRoom.winnerId !== socket.id) {
                // This means the first player's win was registered, and this player also got Bingo on the same turn.
                if (!gameRoom.draw) { // Only transition to draw if not already set
                    gameRoom.draw = true;
                    gameRoom.gameStarted = false;
                    gameRoom.currentTurnPlayerId = null;
                    console.log(`Room ${gameId}: Simultaneous win detected! Player ${socket.id} also declared win.`);
                    const lastMarkedNumber = gameRoom.markedNumbers[gameRoom.markedNumbers.length - 1]; // Get the number that caused the draw
                    io.to(gameId).emit('gameDraw', { number: lastMarkedNumber }); // Emit draw event
                    emitGameState(gameId); // Ensure draw state is broadcast
                }
            } else {
                // Genuine error: trying to declare win when game hasn't started or already won by *this* player
                socket.emit('gameError', 'Cannot declare win. Game not active or already won.');
            }
            return;
        }

        // --- Critical point: Check game state *before* setting winner ---
        // If a winner is *already* set by another player (due to a race condition) when *this* 'declareWin' is processed
        if (gameRoom.winnerId && gameRoom.winnerId !== socket.id) {
            // This is the second player to hit declareWin almost simultaneously
            if (!gameRoom.draw) { // Only transition to draw if not already set
                gameRoom.draw = true;
                gameRoom.gameStarted = false;
                gameRoom.currentTurnPlayerId = null;
                console.log(`Room ${gameId}: Simultaneous win detected! Player ${socket.id} also declared win.`);
                const lastMarkedNumber = gameRoom.markedNumbers[gameRoom.markedNumbers.length - 1]; // Get the number that caused the draw
                io.to(gameId).emit('gameDraw', { number: lastMarkedNumber }); // Emit draw event
                emitGameState(gameId); // Ensure draw state is broadcast
            }
            return; // Exit, as it's now a draw, not a single winner
        }

        // If no winner was set before, this player is the first to declare win
        gameRoom.winnerId = socket.id;
        gameRoom.gameStarted = false; // End the game
        gameRoom.currentTurnPlayerId = null; // No one's turn after win
        console.log(`Room ${gameId}: Player ${socket.id} declared win!`);

        const winner = gameRoom.players.find(p => p.id === socket.id);
        const winningUsername = winner ? winner.username : 'Unknown Player';

        io.to(gameId).emit('playerDeclaredWin', { winnerId: socket.id, winningUsername: winningUsername });
        emitGameState(gameId); // Update state to reflect winner and game ended
    });


    // Request New Match
    socket.on('requestNewMatch', () => {
        const gameId = playerCurrentGameId;
        const gameRoom = gameRooms.get(gameId);

        if (!gameRoom || gameRoom.gameStarted || (!gameRoom.winnerId && !gameRoom.draw)) {
            socket.emit('gameError', 'Cannot request a new match. Game must be ended (won/draw).');
            return;
        }

        if (gameRoom.pendingNewMatchRequest) {
            socket.emit('gameError', 'A new match request is already pending.');
            return;
        }

        const requester = gameRoom.players.find(p => p.id === socket.id);
        if (!requester) {
            socket.emit('gameError', 'Requester not found in room.');
            return;
        }

        gameRoom.pendingNewMatchRequest = {
            requesterId: socket.id,
            requesterUsername: requester.username
        };
        console.log(`Room ${gameId}: Player ${requester.username} requested a new match.`);

        // Emit to all players in the room, including the requester, WITH requesterId
        io.to(gameId).emit('newMatchRequested', {
            requesterId: requester.id,
            requesterUsername: requester.username
        });
        emitGameState(gameId); // Update state with pending request
    });

    // Accept New Match
    socket.on('acceptNewMatch', () => {
        const gameId = playerCurrentGameId;
        const gameRoom = gameRooms.get(gameId);

        if (!gameRoom || !gameRoom.pendingNewMatchRequest) {
            socket.emit('gameError', 'No new match request pending.');
            return;
        }

        // Ensure the acceptor is not the requester
        if (gameRoom.pendingNewMatchRequest.requesterId === socket.id && !gameRoom.isAIGame) { // AI can "accept" its own request
            socket.emit('gameError', 'You cannot accept your own request.');
            return;
        }

        console.log(`Room ${gameId}: Player ${socket.id} accepted new match request.`);
        gameRoom.pendingNewMatchRequest = null; // Clear pending request
        resetGameRound(gameId); // Reset the game for a new round
        // The resetGameRound function already emits 'gameReset' and 'gameState'
        // io.to(gameId).emit('newMatchAccepted'); // No longer needed here, handled by gameReset
    });

    // Decline New Match
    socket.on('declineNewMatch', () => {
        const gameId = playerCurrentGameId;
        const gameRoom = gameRooms.get(gameId);

        if (!gameRoom || !gameRoom.pendingNewMatchRequest) {
            socket.emit('gameError', 'No new match request pending.');
            return;
        }

        const decliner = gameRoom.players.find(p => p.id === socket.id);
        const declinerUsername = decliner ? decliner.username : 'Unknown Player';

        console.log(`Room ${gameId}: Player ${socket.id} declined new match request.`);
        gameRoom.pendingNewMatchRequest = null; // Clear pending request
        io.to(gameId).emit('newMatchDeclined', declinerUsername); // Notify clients that it was declined
        emitGameState(gameId); // Update state after declining
    });


    // Chat Message
    socket.on('sendMessage', (message) => {
        const gameId = playerCurrentGameId;
        const gameRoom = gameRooms.get(gameId);

        if (!gameRoom) {
            socket.emit('gameError', 'Not in a game to send messages.');
            return;
        }

        const sender = gameRoom.players.find(p => p.id === socket.id);
        const senderUsername = sender ? sender.username : `Player-${socket.id.substring(0, 4)}`;

        console.log(`Room ${gameId} - Chat: [${senderUsername}] ${message}`);
        io.to(gameId).emit('message', { senderId: senderUsername, message: message });
    });


    // Listen for incoming emotes
    socket.on('sendEmote', (emote) => {
        const gameId = playerCurrentGameId;
        const gameRoom = gameRooms.get(gameId);

        if (!gameRoom) {
            socket.emit('gameError', 'Not in a game to send emotes.');
            return;
        }

        const sender = gameRoom.players.find(p => p.id === socket.id);
        const senderUsername = sender ? sender.username : `Player-${socket.id.substring(0, 4)}`;

        // Optional: Basic validation for allowed emotes
        // Ensure this list matches the `data-emote` attributes in your index.html exactly
        const allowedEmotes = ['👍 Nice!', '👎 Oops!', '😂 Haha!', '😡 Argh!', '✨ Bingo!']; 
        if (!allowedEmotes.includes(emote)) {
            console.warn(`Player ${senderUsername} tried to send invalid emote: ${emote}`);
            socket.emit('gameError', 'Invalid emote.');
            return;
        }

        console.log(`Room ${gameId} - Emote: [${senderUsername}] sent ${emote}`);
        // Broadcast the emote to everyone in the room (including sender, who can then display it)
        io.to(gameId).emit('emote', { senderUsername: senderUsername, emote: emote });
    });


    // --- Disconnection Handling ---
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        const gameId = playerCurrentGameId;
        const gameRoom = gameRooms.get(gameId);

        if (gameRoom) {
            // NEW: Get disconnected player info BEFORE filtering
            const disconnectedPlayer = gameRoom.players.find(p => p.id === socket.id);
            const disconnectedUsername = (disconnectedPlayer && disconnectedPlayer.username) || 'A player';

            gameRoom.players = gameRoom.players.filter(p => p.id !== socket.id);
            console.log(`Player ${disconnectedUsername} (${socket.id}) disconnected from room ${gameId}. Remaining players: ${gameRoom.players.length}`);

            // Notify remaining players about disconnection (if any human player left)
            if (gameRoom.players.length > 0 && gameRoom.players.some(p => p.id !== AI_PLAYER_ID)) {
                io.to(gameId).emit('userLeft', disconnectedUsername);
            }

            // If it was an AI game and the human player disconnected, delete the room
            if (gameRoom.isAIGame && gameRoom.players.length === 1 && gameRoom.players[0].id === AI_PLAYER_ID) {
                console.log(`Human player disconnected from AI game ${gameId}. Deleting room.`);
                gameRooms.delete(gameId);
            }
            // If game was started and now less than 2 players (and not an AI game where AI is the only one left), reset game round
            else if (gameRoom.gameStarted && gameRoom.players.length < 2 && !gameRoom.isAIGame) {
                console.log(`Not enough players in room ${gameId}. Game round ended.`);
                resetGameRound(gameId);
            } else if (gameRoom.players.length === 0) {
                // If no players left, clean up the game room
                console.log(`Last player disconnected from room ${gameId}. Deleting room.`);
                gameRooms.delete(gameId);
            } else {
                // If players remain, re-evaluate turn and emit updated state
                if (gameRoom.currentTurnPlayerId === socket.id && gameRoom.gameStarted) {
                    advanceTurn(gameRoom); // Advance turn if it was their turn
                }
                emitGameState(gameId); // Update state for remaining players
            }
        }
        socket.leave(gameId);
        playerCurrentGameId = null; // Clear the player's current game ID
        broadcastOnlinePlayersCount(); // Update count after a player disconnects
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);

    // --- NEW: Self-ping interval for backend to stay awake ---
    // This URL needs to be the publicly accessible URL of your Render backend service.
    // Render typically sets this as an environment variable.
    const DEPLOYED_BACKEND_URL = process.env.RENDER_EXTERNAL_URL; 

    // Fallback for local development or if RENDER_EXTERNAL_URL isn't available
    const BACKEND_PING_URL = DEPLOYED_BACKEND_URL ? `${DEPLOYED_BACKEND_URL}/ping` : `http://localhost:${PORT}/ping`;
    
    // Ping interval should be less than Render's dormancy period (e.g., 15 minutes)
    const PING_INTERVAL_MS = 14 * 60 * 1000; // 14 minutes

    if (DEPLOYED_BACKEND_URL) { // Only start self-ping if deployed URL is known
        setInterval(() => {
            fetch(BACKEND_PING_URL)
                .then(response => {
                    if (!response.ok) {
                        console.warn(`Self-ping failed: ${response.status} ${response.statusText}. URL: ${BACKEND_PING_URL}`);
                    } else {
                        console.log('Self-ping successful.');
                    }
                })
                .catch(error => {
                    console.error(`Self-ping error to ${BACKEND_PING_URL}:`, error.message);
                });
        }, PING_INTERVAL_MS);
        console.log(`Backend self-ping configured to ${BACKEND_PING_URL} every ${PING_INTERVAL_MS / 1000 / 60} minutes.`);
    } else {
        console.warn('RENDER_EXTERNAL_URL not found. Self-ping will not be active in this environment. Ensure it is set on Render.');
    }
    // --- END Self-ping ---

    // Initial broadcast of online players count when server starts
    broadcastOnlinePlayersCount(); 
    // Broadcast online players count periodically (e.g., every 30 seconds)
    setInterval(broadcastOnlinePlayersCount, 30 * 1000); // Every 30 seconds
});
