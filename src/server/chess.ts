import { Chess, type Move } from "chess.js";

export function moveToUci(move: Move): string {
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}

export function legalUciMoves(game: Chess): string[] {
  return game.moves({ verbose: true }).map(moveToUci);
}

export function parseUci(value: string): { from: string; to: string; promotion?: string } | undefined {
  const match = value.toLowerCase().match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/);
  if (!match) return undefined;
  return { from: match[1], to: match[2], ...(match[3] ? { promotion: match[3] } : {}) };
}

export function gameResult(game: Chess): { result: "1-0" | "0-1" | "1/2-1/2"; reason: string } | undefined {
  if (!game.isGameOver()) return undefined;
  if (game.isCheckmate()) {
    return game.turn() === "w"
      ? { result: "0-1", reason: "Checkmate — Black wins" }
      : { result: "1-0", reason: "Checkmate — White wins" };
  }
  if (game.isStalemate()) return { result: "1/2-1/2", reason: "Stalemate" };
  if (game.isInsufficientMaterial()) return { result: "1/2-1/2", reason: "Insufficient material" };
  if (game.isThreefoldRepetition()) return { result: "1/2-1/2", reason: "Threefold repetition" };
  if (game.isDrawByFiftyMoves()) return { result: "1/2-1/2", reason: "Fifty-move rule" };
  return { result: "1/2-1/2", reason: "Draw" };
}
