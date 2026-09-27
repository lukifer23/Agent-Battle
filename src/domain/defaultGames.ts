import { GameRegistry } from "./game.js";
import { ChessGame } from "../games/chess/ChessGame.js";
import { HangmanGame } from "../games/hangman/HangmanGame.js";
export const defaultGames = new GameRegistry().register(new ChessGame()).register(new HangmanGame());
