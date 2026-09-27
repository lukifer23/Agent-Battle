import { Chess, type Square } from "chess.js";

export const PIECE_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };

export function squaresOfUci(uci: string | undefined): { from?: Square; to?: Square } {
  if (!uci || uci.length < 4) return {};
  return { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square };
}

export function kingSquare(fen: string, color: "w" | "b"): Square | undefined {
  for (const rank of new Chess(fen).board()) {
    for (const square of rank) {
      if (square && square.type === "k" && square.color === color) return square.square;
    }
  }
  return undefined;
}

export function isInCheck(fen: string): boolean {
  try { return new Chess(fen).inCheck(); }
  catch { return false; }
}

/** Squares to highlight for the last move plus a check indicator, if any. */
export function highlightSquares(fen: string, lastUci?: string): Record<string, { backgroundColor: string }> {
  const styles: Record<string, { backgroundColor: string }> = {};
  const { from, to } = squaresOfUci(lastUci);
  if (from) styles[from] = { backgroundColor: "rgba(196, 237, 105, 0.35)" };
  if (to) styles[to] = { backgroundColor: "rgba(196, 237, 105, 0.5)" };
  if (isInCheck(fen)) {
    let turn: "w" | "b" = "w";
    try { turn = new Chess(fen).turn(); } catch { /* default to white */ }
    const king = kingSquare(fen, turn);
    if (king) styles[king] = { backgroundColor: "rgba(232, 156, 130, 0.65)" };
  }
  return styles;
}

export function materialSummary(fen: string): { white: number; black: number } {
  const totals = { white: 0, black: 0 };
  const placement = fen.split(" ")[0] ?? "";
  for (const symbol of placement) {
    if (/[prnbq]/.test(symbol)) totals.black += PIECE_VALUES[symbol] ?? 0;
    else if (/[PRNBQ]/.test(symbol)) totals.white += PIECE_VALUES[symbol.toLowerCase()] ?? 0;
  }
  return totals;
}

export function positionSummary(fen: string, lastSan?: string): string {
  let turn: "white" | "black" = "white";
  try { turn = new Chess(fen).turn() === "w" ? "white" : "black"; } catch { /* default */ }
  const material = materialSummary(fen);
  const advantage = material.white === material.black ? "material is level" : material.white > material.black ? `White is up ${material.white - material.black}` : `Black is up ${material.black - material.white}`;
  return [`${turn} to move`, isInCheck(fen) ? "in check" : undefined, advantage, lastSan ? `last move ${lastSan}` : undefined].filter(Boolean).join(", ");
}
