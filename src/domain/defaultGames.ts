import { GameRegistry } from "./game.js";
import { ChessGame } from "../games/chess/ChessGame.js";
import { HangmanDuelGame } from "../games/hangman/HangmanDuelGame.js";
import { HangmanGame } from "../games/hangman/HangmanGame.js";
import { BattleshipGame } from "../games/battleship/BattleshipGame.js";
export const defaultGames = new GameRegistry().register(new ChessGame()).register(new HangmanGame(), false).register(new HangmanDuelGame()).register(new BattleshipGame());
