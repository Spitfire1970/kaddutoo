/**
 * Chess960 (Fischer Random Chess) position generator
 * Generates a valid Chess960 starting position according to the rules:
 * 1. Bishops must be on opposite-colored squares
 * 2. King must be between the rooks
 * 3. Pawns are on the 2nd rank (7th for black)
 */

// Generate a valid Chess960 position in FEN notation
function generateChess960Position() {
  // Place bishops on opposite-colored squares
  const lightSquareBishop = getRandomEven();
  const darkSquareBishop = getRandomOdd();
  
  // Place queen
  let emptySquares = [0, 1, 2, 3, 4, 5, 6, 7].filter(
    square => square !== lightSquareBishop && square !== darkSquareBishop
  );
  const queenIndex = Math.floor(Math.random() * emptySquares.length);
  const queenSquare = emptySquares[queenIndex];
  emptySquares.splice(queenIndex, 1);
  
  // Place knights
  const knight1Index = Math.floor(Math.random() * emptySquares.length);
  const knight1Square = emptySquares[knight1Index];
  emptySquares.splice(knight1Index, 1);
  
  const knight2Index = Math.floor(Math.random() * emptySquares.length);
  const knight2Square = emptySquares[knight2Index];
  emptySquares.splice(knight2Index, 1);
  
  // Place king and rooks (king must be between rooks)
  // Sort remaining squares
  emptySquares.sort((a, b) => a - b);
  
  // King goes in the middle square
  const kingSquare = emptySquares[1];
  
  // Rooks go on the remaining squares
  const rook1Square = emptySquares[0];
  const rook2Square = emptySquares[2];
  
  // Create the piece placement
  const pieces = Array(8).fill(null);
  pieces[lightSquareBishop] = 'B';
  pieces[darkSquareBishop] = 'B';
  pieces[queenSquare] = 'Q';
  pieces[knight1Square] = 'N';
  pieces[knight2Square] = 'N';
  pieces[kingSquare] = 'K';
  pieces[rook1Square] = 'R';
  pieces[rook2Square] = 'R';
  
  // Generate FEN string
  const whitePieces = pieces.join('');
  const blackPieces = whitePieces.toLowerCase();
  
  // Fixed FEN string - White pieces should be on the 1st rank (bottom) and black on the 8th rank (top)
  return `${blackPieces}/pppppppp/8/8/8/8/PPPPPPPP/${whitePieces} w KQkq - 0 1`;
}

// Helper function to get a random even number between 0 and 7
function getRandomEven() {
  const evens = [0, 2, 4, 6];
  return evens[Math.floor(Math.random() * evens.length)];
}

// Helper function to get a random odd number between 0 and 7
function getRandomOdd() {
  const odds = [1, 3, 5, 7];
  return odds[Math.floor(Math.random() * odds.length)];
}

module.exports = { generateChess960Position }; 