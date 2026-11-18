import type { CSSProperties } from 'react';
import type { PlacementEvaluation } from '../../shared/domain';
import type { BoardLayout } from '../lib/lot';

export interface ParkingBoardProps {
  readonly board: BoardLayout;
  readonly disabled: boolean;
  readonly preview: { cells: readonly number[]; valid: boolean } | null;
  readonly repack: Pick<PlacementEvaluation, 'cells' | 'ghostPairsAfter' | 'deadSpotsAfter'> | null;
  readonly onCell: (cell: number) => void;
}

const obstacleNames = { pillar: 'Concrete pillar', hydrant: 'Fire hydrant', corral: 'Cart corral', tarped_car: 'Tarped car' };
const vehiclePaints = ['#f17f46', '#81d2dd', '#e9bc58', '#bba3f0', '#c3dd76'];

export function ParkingBoard({ board, disabled, preview, repack, onCell }: ParkingBoardProps): React.JSX.Element {
  const { gridCols, gridRows, obstacles, elevatorCell, vehicles = [] } = board;
  const obstacleByCell = new Map(obstacles.map(({ cell, kind }) => [cell, kind]));
  const parkedCells = new Set(vehicles.flatMap(({ cells }) => cells));
  const cellLabel = (cell: number) => `Row ${Math.floor(cell / gridCols) + 1}, column ${cell % gridCols + 1}`;
  function footprint(cells: readonly number[]): CSSProperties {
    const first = Math.min(...cells);
    const last = Math.max(...cells);
    return {
      gridColumn: `${first % gridCols + 1} / ${last % gridCols + 2}`,
      gridRow: `${Math.floor(first / gridCols) + 1} / ${Math.floor(last / gridCols) + 2}`,
    };
  }
  return (
    <div className="parking-board" role="group" aria-label="Parking board" style={{ '--columns': gridCols, '--rows': gridRows } as CSSProperties}>
      {Array.from({ length: gridCols * gridRows }, (_, cell) => {
        const obstacle = obstacleByCell.get(cell);
        const parked = parkedCells.has(cell) || repack?.cells.includes(cell);
        const selected = preview?.cells.includes(cell);
        const label = obstacle ? obstacleNames[obstacle] : parked ? 'Parked vehicle' : cell === elevatorCell ? 'Elevator' : 'Open';
        return (
          <button key={cell} type="button" aria-label={`${cellLabel(cell)} · ${label}`} aria-pressed={Boolean(selected)}
            className={`parking-cell ${obstacle ?? ''} ${selected ? preview?.valid ? 'preview-valid' : 'preview-blocked' : ''}`}
            style={footprint([cell])} disabled={disabled || Boolean(obstacle || parked)} onClick={() => onCell(cell)}>
            {obstacle ? <span className="fixture" aria-hidden="true" /> : cell === elevatorCell ? <span className="elevator">ELEV</span> : null}
          </button>
        );
      })}
      {vehicles.map((vehicle) => (
        <div key={vehicle.userId} className={`vehicle ${Math.max(...vehicle.cells) - Math.min(...vehicle.cells) >= gridCols ? 'vertical' : ''}`}
          role="img" aria-label={`${vehicle.username}${vehicle.windowNoteId ? ` · ${vehicle.windowNoteId.replaceAll('_', ' ')}` : ''}`}
          style={{ ...footprint(vehicle.cells), '--paint': vehiclePaints[Math.min(...vehicle.cells) % vehiclePaints.length] } as CSSProperties}>
          <span className="plate">{vehicle.username.slice(0, 8)}</span>{vehicle.windowNoteId && <span className="sticker" aria-hidden="true" />}
        </div>
      ))}
      {repack && <>
        {!repack.cells.every((cell) => parkedCells.has(cell)) && <div className="vehicle just-parked" aria-hidden="true" style={footprint(repack.cells)} />}
        {repack.ghostPairsAfter.map((pair) => <div key={pair.join('-')} className="ghost-stall" role="img" aria-label={`Ghost stall · ${cellLabel(pair[0])}`} style={footprint(pair)} />)}
        {repack.deadSpotsAfter.map((cell) => <div key={cell} className="dead-spot" role="img" aria-label={`Dead Spot · ${cellLabel(cell)}`} style={footprint([cell])}><span /></div>)}
      </>}
    </div>
  );
}
