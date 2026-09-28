import { Chessboard } from "react-chessboard";
import type { CSSProperties } from "react";
import type { PublicMatchDetail } from "../shared.js";
import { HangmanDuelArena } from "./HangmanDuelArena.js";
import { HangmanArena } from "./HangmanArena.js";
import { BattleshipArena } from "./BattleshipArena.js";
export function ArenaRouter({ match, chess, replayPly }: { match: PublicMatchDetail | null; replayPly?: number | null; chess: { boardFen: string; boardOrientation: "white" | "black"; squareStyles: Record<string, CSSProperties>; summary: string } }) {
  if (match?.gameId === "hangman" && match.gameVersion === "shared-board-2") return <HangmanDuelArena key={match.id} match={match} replayPly={replayPly ?? null} />;
  if (match?.gameId === "hangman") return <HangmanArena key={match.id} match={match} replayPly={replayPly ?? null} />;
  if (match?.gameId === "battleship") return <BattleshipArena key={match.id} match={match} replayPly={replayPly ?? null} />;
  if (match && match.gameId !== "chess") return <p>Unsupported game view.</p>;
  const ranks = chess.boardOrientation === "white" ? [8,7,6,5,4,3,2,1] : [1,2,3,4,5,6,7,8];
  const files = chess.boardOrientation === "white" ? "abcdefgh" : "hgfedcba";
  return <><div className="board-frame">
    <div className="board-rank rank-left">{ranks.map((rank) => <span key={rank}>{rank}</span>)}</div>
    <div className="chessboard-wrap"><Chessboard options={{ position: chess.boardFen, boardOrientation: chess.boardOrientation, allowDragging: false, showAnimations: !window.matchMedia("(prefers-reduced-motion: reduce)").matches, animationDurationInMs: 240, boardStyle: { borderRadius: "3px", width: "100%" }, lightSquareStyle: { backgroundColor: "#d8cfb7" }, darkSquareStyle: { backgroundColor: "#526c61" }, squareStyles: chess.squareStyles, showNotation: false }} /></div>
    <div className="board-rank rank-right">{ranks.map((rank) => <span key={rank}>{rank}</span>)}</div>
    <div className="board-files">{[...files].map((file) => <span key={file}>{file}</span>)}</div>
  </div><p className="board-summary" aria-live="polite">{chess.summary}</p></>;
}
