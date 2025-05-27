const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const { Chess } = require('chess.js');
const { generateChess960Position } = require('./chess960');

// In-memory storage for active games and players
const players = new Map(); // Map of player ID to player object
const games = new Map(); // Map of game ID to game object
const waitingGames = new Map(); // Map of game ID to game object (games waiting for an opponent)

// Global stats
const globalStats = {
  capturedQueens: 0,
  capturedPawns: 0,
  castledKings: 0,
};

// Initialize WebSocket server
function initChessServer(server) {
  const wss = new WebSocket.Server({ 
    server,
    path: '/chess-ws'
  });

  console.log('Chess WebSocket server initialized');

  wss.on('connection', (ws) => {
    const playerId = uuidv4();
    console.log(`Player connected: ${playerId}`);

    // Initialize player
    players.set(playerId, {
      id: playerId,
      name: null,
      ws,
      gameId: null
    });

    // Handle messages from clients
    ws.on('message', (message) => {
      try {
        const parsedMessage = JSON.parse(message);
        handleMessage(playerId, parsedMessage);
      } catch (error) {
        console.error('Error parsing message:', error);
        sendError(ws, 'Invalid message format');
      }
    });

    // Handle disconnection
    ws.on('close', () => {
      handlePlayerDisconnect(playerId);
    });
  });

  // Handle incoming messages
  function handleMessage(playerId, message) {
    const player = players.get(playerId);
    if (!player) return;

    const { type, data } = message;

    switch (type) {
      case 'register':
        registerPlayer(playerId, data.name);
        break;
      case 'get_waiting_games':
        sendWaitingGames(playerId);
        break;
      case 'create_game':
        createGame(playerId, data);
        break;
      case 'join_game':
        joinGame(playerId, data.gameId);
        break;
      case 'make_move':
        makeMove(playerId, data);
        break;
      case 'offer_draw':
        offerDraw(playerId, data.gameId);
        break;
      case 'accept_draw':
        acceptDraw(playerId, data.gameId);
        break;
      case 'decline_draw':
        declineDraw(playerId, data.gameId);
        break;
      case 'resign':
        resign(playerId, data.gameId);
        break;
      default:
        sendError(player.ws, 'Unknown message type');
    }
  }

  // Register player with a name
  function registerPlayer(playerId, name) {
    const player = players.get(playerId);
    if (!player) return;

    player.name = name;
    console.log(`Player ${playerId} registered as ${name}`);
  }

  // Send list of waiting games to player
  function sendWaitingGames(playerId) {
    const player = players.get(playerId);
    if (!player) return;

    const waitingGamesList = Array.from(waitingGames.values()).map(game => ({
      id: game.id,
      hostName: game.players.white ? game.players.white.name : game.players.black.name,
      mode: game.mode,
      timeControl: {
        name: `${Math.floor(game.timeControl.white / 60)}+${game.timeControl.increment}`
      }
    }));

    send(player.ws, {
      type: 'waiting_games',
      data: {
        games: waitingGamesList,
        globalStats
      }
    });
  }

  // Create a new game
  function createGame(playerId, data) {
    const player = players.get(playerId);
    if (!player) return;

    // Parse time control
    const timeControl = data.timeControl;
    
    // Randomly assign color
    const playerColor = Math.random() < 0.5 ? 'white' : 'black';
    
    // Create game instance
    let chess;
    if (data.mode === 'chess960') {
      const startPosition = generateChess960Position();
      chess = new Chess(startPosition);
    } else {
      chess = new Chess();
    }
    
    const gameId = uuidv4();
    const game = {
      id: gameId,
      chess,
      mode: data.mode,
      players: {
        white: playerColor === 'white' ? player : null,
        black: playerColor === 'black' ? player : null
      },
      timeControl: {
        white: timeControl.time,
        black: timeControl.time,
        increment: timeControl.increment
      },
      lastMoveTime: null, // Don't set the time until the game actually starts
      drawOffer: null,
      status: 'waiting',
      clockStarted: false, // Add a flag to track if the clock has started
      timerInterval: null // Add a field to store the timer interval
    };
    
    // Store game
    games.set(gameId, game);
    waitingGames.set(gameId, game);
    
    // Update player
    player.gameId = gameId;
    
    // Notify player
    send(player.ws, {
      type: 'game_created',
      data: {
        gameId,
        color: playerColor,
        position: getPositionObject(chess),
        timeControl: {
          white: game.timeControl.white,
          black: game.timeControl.black
        }
      }
    });
    
    console.log(`Game created: ${gameId}, mode: ${data.mode}, host: ${player.name} (${playerColor})`);
    
    // Broadcast updated waiting games list
    broadcastWaitingGames();
  }

  // Join an existing game
  function joinGame(playerId, gameId) {
    const player = players.get(playerId);
    const game = games.get(gameId);
    
    if (!player || !game) {
      if (player) {
        sendError(player.ws, 'Game not found');
      }
      return;
    }
    
    if (game.status !== 'waiting') {
      sendError(player.ws, 'Game is no longer available');
      return;
    }
    
    // Check if player is trying to join their own game
    if ((game.players.white && game.players.white.id === playerId) || 
        (game.players.black && game.players.black.id === playerId)) {
      sendError(player.ws, 'Cannot join your own game');
      return;
    }
    
    // Determine player color
    let playerColor;
    if (!game.players.white) {
      playerColor = 'white';
    } else if (!game.players.black) {
      playerColor = 'black';
    } else {
      sendError(player.ws, 'Game is full');
      return;
    }
    
    // Add player to game
    game.players[playerColor] = player;
    player.gameId = gameId;
    
    // Update game status
    game.status = 'playing';
    waitingGames.delete(gameId);
    
    // Start the clock now that both players have joined
    game.lastMoveTime = Date.now();
    game.clockStarted = true;
    
    // Start the timer to check for time-outs
    startGameTimer(game);
    
    // Get opponent
    const opponentColor = playerColor === 'white' ? 'black' : 'white';
    const opponent = game.players[opponentColor];
    
    // Notify joining player
    send(player.ws, {
      type: 'game_joined',
      data: {
        gameId,
        color: playerColor,
        position: getPositionObject(game.chess),
        opponent: opponent.name,
        timeControl: {
          white: game.timeControl.white,
          black: game.timeControl.black
        }
      }
    });
    
    // Notify opponent
    send(opponent.ws, {
      type: 'opponent_joined',
      data: {
        opponent: player.name,
        timeControl: {
          white: game.timeControl.white,
          black: game.timeControl.black
        }
      }
    });
    
    console.log(`Player ${player.name} joined game ${gameId} as ${playerColor}`);
    
    // Broadcast updated waiting games list
    broadcastWaitingGames();
  }

  // Start a timer to check for time-outs
  function startGameTimer(game) {
    // Clear any existing timer
    if (game.timerInterval) {
      clearInterval(game.timerInterval);
    }
    
    // Check every 100ms for more precise timing
    game.timerInterval = setInterval(() => {
      if (game.status !== 'playing' || !game.clockStarted) {
        clearInterval(game.timerInterval);
        game.timerInterval = null;
        return;
      }
      
      const now = Date.now();
      const elapsed = (now - game.lastMoveTime) / 1000; // Use precise timing (not floored)
      const turn = game.chess.turn() === 'w' ? 'white' : 'black';
      
      // Update time left with precise calculation
      const newTimeLeft = Math.max(0, game.timeControl[turn] - elapsed);
      
      // Only end the game if time is truly exhausted (less than 0.05 seconds)
      if (newTimeLeft <= 0.05) {
        // Player has run out of time
        const winner = turn === 'white' ? 'black' : 'white';
        endGame(game, `${winner === 'white' ? 'White' : 'Black'} wins on time`);
      } else if (Math.abs(game.timeControl[turn] - newTimeLeft) > 0.2) {
        // Only update the time if it's changed by more than 0.2 seconds
        // This reduces unnecessary updates while still keeping time accurate
        game.timeControl[turn] = newTimeLeft;
        game.lastMoveTime = now;
      }
    }, 100); // Check 10 times per second for more accurate timing
  }

  // Make a move
  function makeMove(playerId, data) {
    const player = players.get(playerId);
    if (!player) return;
    
    const game = games.get(data.gameId);
    if (!game || game.status !== 'playing') return;
    
    // Check if it's the player's turn
    const turn = game.chess.turn() === 'w' ? 'white' : 'black';
    if (data.playerColor !== turn) {
      sendError(player.ws, 'Not your turn');
      return;
    }
    
    // Try to make the move
    try {
      // Track pieces before move for stats
      const boardBefore = game.chess.board();
      const moveDetails = {
        from: data.from,
        to: data.to,
        promotion: 'q' // Auto-promote to queen
      };
      
      // Make the move
      const move = game.chess.move(moveDetails);
      if (!move) {
        sendError(player.ws, 'Invalid move');
        return;
      }
      
      // Update timers only if the clock has started
      if (game.clockStarted && game.lastMoveTime) {
        const now = Date.now();
        const elapsed = (now - game.lastMoveTime) / 1000; // Use precise timing
        game.timeControl[turn] = Math.max(0, game.timeControl[turn] - elapsed);
        game.timeControl[turn] += game.timeControl.increment; // Add increment
        game.lastMoveTime = now;
      } else {
        // If for some reason the clock hasn't started yet, start it now
        game.lastMoveTime = Date.now();
        game.clockStarted = true;
        startGameTimer(game);
      }
      
      // Check for game over conditions
      let gameOver = false;
      let result = null;
      
      if (game.chess.isCheckmate()) {
        gameOver = true;
        result = `${turn === 'white' ? 'White' : 'Black'} wins by checkmate`;
      } else if (game.chess.isDraw()) {
        gameOver = true;
        if (game.chess.isStalemate()) {
          result = 'Draw by stalemate';
        } else if (game.chess.isThreefoldRepetition()) {
          result = 'Draw by threefold repetition';
        } else if (game.chess.isInsufficientMaterial()) {
          result = 'Draw by insufficient material';
        } else {
          result = 'Draw by 50-move rule';
        }
      }
      
      // Update stats
      const statsUpdate = {};
      
      // Check for captured pieces
      if (move.captured) {
        if (move.captured === 'q') {
          globalStats.capturedQueens++;
          statsUpdate.capturedQueens = globalStats.capturedQueens;
        } else if (move.captured === 'p') {
          globalStats.capturedPawns++;
          statsUpdate.capturedPawns = globalStats.capturedPawns;
        }
      }
      
      // Check for castling
      if (move.flags.includes('k') || move.flags.includes('q')) {
        globalStats.castledKings++;
        statsUpdate.castledKings = globalStats.castledKings;
      }
      
      // Notify both players about the move
      const nextTurn = game.chess.turn() === 'w' ? 'white' : 'black';
      const moveData = {
        type: 'move_made',
        data: {
          move: {
            from: move.from,
            to: move.to,
            piece: move.piece,
            color: turn
          },
          position: getPositionObject(game.chess),
          timeLeft: {
            white: game.timeControl.white,
            black: game.timeControl.black
          },
          nextTurn,
          stats: Object.keys(statsUpdate).length > 0 ? statsUpdate : null
        }
      };
      
      // Send to both players
      if (game.players.white) send(game.players.white.ws, moveData);
      if (game.players.black) send(game.players.black.ws, moveData);
      
      // Handle game over
      if (gameOver) {
        endGame(game, result);
      }
      
    } catch (error) {
      console.error('Error making move:', error);
      sendError(player.ws, 'Error making move');
    }
  }

  // Offer a draw
  function offerDraw(playerId, gameId) {
    const player = players.get(playerId);
    const game = games.get(gameId);
    
    if (!player || !game || game.status !== 'playing') {
      if (player) {
        sendError(player.ws, 'Game not found or not in progress');
      }
      return;
    }
    
    // Determine player color
    const playerColor = game.players.white === player ? 'white' : 'black';
    const opponentColor = playerColor === 'white' ? 'black' : 'white';
    const opponent = game.players[opponentColor];
    
    if (!opponent) {
      sendError(player.ws, 'Opponent not found');
      return;
    }
    
    // Set draw offer
    game.drawOffer = playerColor;
    
    // Notify opponent
    send(opponent.ws, {
      type: 'draw_offered',
      data: {}
    });
    
    console.log(`Player ${player.name} offered a draw in game ${gameId}`);
  }

  // Accept a draw offer
  function acceptDraw(playerId, gameId) {
    const player = players.get(playerId);
    const game = games.get(gameId);
    
    if (!player || !game || game.status !== 'playing') {
      if (player) {
        sendError(player.ws, 'Game not found or not in progress');
      }
      return;
    }
    
    // Determine player color
    const playerColor = game.players.white === player ? 'white' : 'black';
    const opponentColor = playerColor === 'white' ? 'black' : 'white';
    
    // Check if there's a valid draw offer from the opponent
    if (game.drawOffer !== opponentColor) {
      sendError(player.ws, 'No valid draw offer');
      return;
    }
    
    // End the game as a draw
    endGame(game, 'Draw by agreement');
  }

  // Decline a draw offer
  function declineDraw(playerId, gameId) {
    const player = players.get(playerId);
    const game = games.get(gameId);
    
    if (!player || !game || game.status !== 'playing') {
      if (player) {
        sendError(player.ws, 'Game not found or not in progress');
      }
      return;
    }
    
    // Determine player color
    const playerColor = game.players.white === player ? 'white' : 'black';
    const opponentColor = playerColor === 'white' ? 'black' : 'white';
    const opponent = game.players[opponentColor];
    
    // Check if there's a valid draw offer from the opponent
    if (game.drawOffer !== opponentColor) {
      sendError(player.ws, 'No valid draw offer');
      return;
    }
    
    // Clear draw offer
    game.drawOffer = null;
    
    // Notify opponent
    if (opponent) {
      send(opponent.ws, {
        type: 'draw_declined',
        data: {}
      });
    }
    
    console.log(`Player ${player.name} declined draw offer in game ${gameId}`);
  }

  // Resign from a game
  function resign(playerId, gameId) {
    const player = players.get(playerId);
    const game = games.get(gameId);
    
    if (!player || !game || game.status !== 'playing') return;
    
    // Determine player color
    const playerColor = game.players.white === player ? 'white' : 'black';
    
    // End the game
    endGame(game, `${playerColor === 'white' ? 'Black' : 'White'} wins by resignation`);
  }

  // End a game
  function endGame(game, result) {
    if (game.status === 'ended') return;
    
    // Stop the game timer
    if (game.timerInterval) {
      clearInterval(game.timerInterval);
      game.timerInterval = null;
    }
    
    game.status = 'ended';
    
    // Notify both players
    const gameOverData = {
      type: 'game_over',
      data: {
        result
      }
    };
    
    if (game.players.white) {
      send(game.players.white.ws, gameOverData);
      game.players.white.gameId = null;
    }
    
    if (game.players.black) {
      send(game.players.black.ws, gameOverData);
      game.players.black.gameId = null;
    }
    
    // Remove game
    waitingGames.delete(game.id);
    games.delete(game.id);
    
    console.log(`Game ${game.id} ended: ${result}`);
  }

  // Handle player disconnection
  function handlePlayerDisconnect(playerId) {
    const player = players.get(playerId);
    if (!player) return;
    
    console.log(`Player disconnected: ${playerId}`);
    
    // Check if player is in a game
    if (player.gameId) {
      const game = games.get(player.gameId);
      if (game) {
        if (game.status === 'waiting') {
          // If game is waiting, just remove it
          waitingGames.delete(game.id);
          games.delete(game.id);
          
          // Stop any timers
          if (game.timerInterval) {
            clearInterval(game.timerInterval);
            game.timerInterval = null;
          }
        } else if (game.status === 'playing') {
          // If game is in progress, end it
          const playerColor = game.players.white === player ? 'white' : 'black';
          endGame(game, `${playerColor === 'white' ? 'Black' : 'White'} wins by disconnection`);
        }
      }
    }
    
    // Remove player
    players.delete(playerId);
    
    // Broadcast updated waiting games list
    broadcastWaitingGames();
  }

  // Broadcast waiting games to all connected players
  function broadcastWaitingGames() {
    const waitingGamesList = Array.from(waitingGames.values()).map(game => ({
      id: game.id,
      hostName: game.players.white ? game.players.white.name : game.players.black.name,
      mode: game.mode,
      timeControl: {
        name: `${Math.floor(game.timeControl.white / 60)}+${game.timeControl.increment}`
      }
    }));
    
    const message = {
      type: 'waiting_games',
      data: {
        games: waitingGamesList,
        globalStats
      }
    };
    
    // Send to all players not in a game
    for (const player of players.values()) {
      if (!player.gameId) {
        send(player.ws, message);
      }
    }
  }

  // Convert chess.js board to position object
  function getPositionObject(chess) {
    const position = {};
    const board = chess.board();
    
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        const piece = board[i][j];
        if (piece) {
          const file = String.fromCharCode(97 + j); // 'a' to 'h'
          const rank = 8 - i; // 1 to 8
          const square = `${file}${rank}`;
          
          // Map piece color correctly
          const pieceColor = piece.color === 'w' ? 'white' : 'black';
          
          position[square] = {
            type: piece.type.toLowerCase(),
            color: pieceColor
          };
        }
      }
    }
    
    return position;
  }

  // Helper to send JSON messages
  function send(ws, message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      // For time-related messages, round the time values to 1 decimal place
      // This ensures consistent display between client and server
      if (message.data && message.data.timeLeft) {
        const timeLeft = message.data.timeLeft;
        for (const color in timeLeft) {
          if (timeLeft[color] !== undefined) {
            // Keep full precision for server calculations but round for display
            timeLeft[color] = Math.round(timeLeft[color] * 10) / 10;
          }
        }
      }
      
      ws.send(JSON.stringify(message));
    }
  }

  // Helper to send error messages
  function sendError(ws, errorMessage) {
    send(ws, {
      type: 'error',
      data: {
        message: errorMessage
      }
    });
  }
}

module.exports = { initChessServer };