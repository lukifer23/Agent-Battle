import type { PublicMatchDetail } from "../shared.js";

type Shot = { playerId: string; coordinate: string; hit: boolean; sunk?: string };
type FleetStatus = { placed: boolean; sunk: string[]; placements?: Array<{ ship: string; start: string; orientation: string }> };
type PublicState = { phase: string; next: string | null; terminal: boolean; shots: Shot[]; fleets: Record<string, FleetStatus>; metrics: Record<string, { shotsFired: number; hits: number; misses: number; accuracy: number | null; shipsSunk: number; shotsToFirstHit: number | null; shotsToSink: Record<string, number> }> };
const files = "abcdefghij";
const lengths: Record<string, number> = { carrier: 5, battleship: 4, cruiser: 3, submarine: 3, destroyer: 2 };
function shipCells(status: FleetStatus): Set<string> {
  const cells = new Set<string>();
  for (const ship of status.placements ?? []) for (let i = 0; i < lengths[ship.ship]; i++) {
    const file = String.fromCharCode(ship.start.charCodeAt(0) + (ship.orientation === "horizontal" ? i : 0));
    const rank = Number(ship.start.slice(1)) + (ship.orientation === "vertical" ? i : 0);
    cells.add(`${file}${rank}`);
  }
  return cells;
}
export function BattleshipArena({ match, replayPly }: { match: PublicMatchDetail; replayPly: number | null }) {
  const frame = replayPly !== null && match.replay?.[replayPly] ? match.replay[replayPly] : match.gameState;
  const state = frame as PublicState;
  return <div className="battleship-arena">
    <p className="battleship-status" role="status">{state.phase === "placement" ? "Fleet placement" : state.terminal ? "Battle complete · fleets revealed" : `${match.players.find((seat) => seat.id === state.next)?.label ?? state.next} to fire`}</p>
    <div className="battleship-boards">{match.players.map((seat) => {
      const status = state.fleets[seat.id];
      const shots = state.shots.filter((shot) => shot.playerId !== seat.id);
      const ownCells = shipCells(status);
      const metrics = state.metrics[seat.id];
      return <section className="battleship-board-panel" key={seat.id} aria-label={`${seat.label} fleet and incoming shots`}>
        <div className="battleship-board-head"><h3>{seat.label}</h3><span>{status.placed ? `${status.sunk.length}/5 sunk` : "Placing fleet"}</span></div>
        <div className="battleship-grid" role="grid" aria-label={`${seat.label} board`}>
          <span aria-hidden="true" />{[...files].map((file) => <b key={file} aria-hidden="true">{file.toUpperCase()}</b>)}
          {Array.from({ length: 10 }, (_, row) => <div className="battleship-grid-row" role="row" key={row}>
            <b aria-hidden="true">{row + 1}</b>{[...files].map((file) => {
              const coordinate = `${file}${row + 1}`;
              const shot = shots.find((item) => item.coordinate === coordinate);
              const visibleShip = state.terminal && ownCells.has(coordinate);
              const label = shot ? shot.hit ? "Hit" : "Miss" : visibleShip ? "Ship" : "Unknown";
              return <span role="gridcell" aria-label={`${coordinate.toUpperCase()}: ${label}`} title={`${coordinate.toUpperCase()}: ${label}`} className={`battle-cell ${shot?.hit ? "hit" : shot ? "miss" : visibleShip ? "ship" : "unknown"}`} key={coordinate}>{shot?.hit ? "×" : shot ? "·" : visibleShip ? "■" : ""}</span>;
            })}</div>)}
        </div>
        <p>{shots.length} shots received · {shots.filter((shot) => shot.hit).length} hits · {status.sunk.length} ships sunk</p>
        <p>{metrics.shotsFired} fired · {metrics.hits} hits · {metrics.accuracy === null ? "accuracy pending" : `${(metrics.accuracy * 100).toFixed(0)}% accuracy`} · first hit {metrics.shotsToFirstHit ?? "pending"}</p>
      </section>;
    })}</div>
    <div className="battleship-legend"><span>× Hit</span><span>· Miss</span>{state.terminal && <span>■ Ship</span>}</div>
  </div>;
}
