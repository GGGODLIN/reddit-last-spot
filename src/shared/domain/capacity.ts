import {
  type PlacementEvaluation,
  type PlacementShapeValidationResult,
  type PlacementValidationResult,
  type StandardStallCapacityResult,
  type UserStreakStats,
  type VehicleType,
  WINDOW_NOTE_IDS,
  type WindowNoteId,
} from './types';

function assertPositiveGridDimensions(gridCols: number, gridRows: number): void {
  if (!Number.isSafeInteger(gridCols) || !Number.isSafeInteger(gridRows) || gridCols < 1 || gridRows < 1) {
    throw new RangeError(`Grid dimensions must be positive integers, received ${gridCols}x${gridRows}`);
  }
}

export function isPerimeterCell(gridCols: number, gridRows: number, cell: number): boolean {
  if (!Number.isSafeInteger(cell) || cell < 0 || cell >= gridCols * gridRows) {
    return false;
  }
  const row = Math.floor(cell / gridCols);
  const col = cell % gridCols;
  return row === 0 || row === gridRows - 1 || col === 0 || col === gridCols - 1;
}

export function isPresetWindowNoteId(candidate: string | undefined | null): candidate is WindowNoteId {
  return typeof candidate === 'string' && (WINDOW_NOTE_IDS as readonly string[]).includes(candidate);
}

function tryAugmentBipartitePath(
  evenCell: number,
  stamp: number,
  adj: Int32Array,
  adjCount: Int32Array,
  matchPartner: Int32Array,
  visitedStamp: Int32Array,
): boolean {
  const baseOffset = evenCell * 4;
  const degree = adjCount[evenCell] ?? 0;
  for (let i = 0; i < degree; i += 1) {
    const oddNeighbor = adj[baseOffset + i]!;
    if (visitedStamp[oddNeighbor] === stamp) continue;
    visitedStamp[oddNeighbor] = stamp;
    const existingPartner = matchPartner[oddNeighbor]!;
    if (
      existingPartner === -1 ||
      tryAugmentBipartitePath(existingPartner, stamp, adj, adjCount, matchPartner, visitedStamp)
    ) {
      matchPartner[oddNeighbor] = evenCell;
      matchPartner[evenCell] = oddNeighbor;
      return true;
    }
  }
  return false;
}

export function computeStandardStallCapacity(
  gridCols: number,
  gridRows: number,
  occupiedCells: Iterable<number>,
): StandardStallCapacityResult {
  assertPositiveGridDimensions(gridCols, gridRows);
  const totalCells = gridCols * gridRows;
  const occupied = new Int32Array(totalCells);
  for (const rawCell of occupiedCells) {
    if (Number.isSafeInteger(rawCell) && rawCell >= 0 && rawCell < totalCells) {
      occupied[rawCell] = 1;
    }
  }

  const adj = new Int32Array(totalCells * 4);
  const adjCount = new Int32Array(totalCells);
  const matchPartner = new Int32Array(totalCells);
  matchPartner.fill(-1);

  for (let row = 0; row < gridRows; row += 1) {
    for (let col = 0; col < gridCols; col += 1) {
      if (((row + col) & 1) !== 0) continue;
      const cell = row * gridCols + col;
      if (occupied[cell] === 1) continue;
      const base = cell * 4;
      let count = 0;
      if (row > 0 && occupied[cell - gridCols] === 0) adj[base + count++] = cell - gridCols;
      if (col > 0 && occupied[cell - 1] === 0) adj[base + count++] = cell - 1;
      if (col + 1 < gridCols && occupied[cell + 1] === 0) adj[base + count++] = cell + 1;
      if (row + 1 < gridRows && occupied[cell + gridCols] === 0) adj[base + count++] = cell + gridCols;
      adjCount[cell] = count;
    }
  }

  // Greedy warm-start pairs adjacent empty cells before augmenting-path search.
  for (let row = 0; row < gridRows; row += 1) {
    for (let col = 0; col < gridCols; col += 1) {
      if (((row + col) & 1) !== 0) continue;
      const evenCell = row * gridCols + col;
      if (occupied[evenCell] === 1) continue;
      const base = evenCell * 4;
      const degree = adjCount[evenCell]!;
      for (let i = 0; i < degree; i += 1) {
        const oddNeighbor = adj[base + i]!;
        if (matchPartner[oddNeighbor] === -1) {
          matchPartner[evenCell] = oddNeighbor;
          matchPartner[oddNeighbor] = evenCell;
          break;
        }
      }
    }
  }

  const visitedStamp = new Int32Array(totalCells);
  let stamp = 0;
  for (let row = 0; row < gridRows; row += 1) {
    for (let col = 0; col < gridCols; col += 1) {
      if (((row + col) & 1) !== 0) continue;
      const evenCell = row * gridCols + col;
      if (occupied[evenCell] === 1 || matchPartner[evenCell] !== -1) continue;
      stamp += 1;
      tryAugmentBipartitePath(evenCell, stamp, adj, adjCount, matchPartner, visitedStamp);
    }
  }

  const ghostPairs: Array<readonly [number, number]> = [];
  const deadSpots: number[] = [];
  for (let cell = 0; cell < totalCells; cell += 1) {
    if (occupied[cell] === 1) continue;
    const partner = matchPartner[cell]!;
    if (partner === -1) {
      deadSpots.push(cell);
    } else if (cell < partner) {
      ghostPairs.push([cell, partner] as const);
    }
  }

  return { remainingStalls: ghostPairs.length, ghostPairs, deadSpots };
}

export function validatePlacementShape(
  gridCols: number,
  gridRows: number,
  vehicleType: VehicleType,
  cells: readonly number[],
): PlacementShapeValidationResult {
  if (!Number.isSafeInteger(gridCols) || !Number.isSafeInteger(gridRows) || gridCols < 1 || gridRows < 1) {
    return { ok: false, reason: 'invalid_grid_dimensions' };
  }
  const expectedLength = vehicleType === 'sedan_2x1' ? 2 : 3;
  if (cells.length !== expectedLength) {
    return { ok: false, reason: 'wrong_cell_count' };
  }
  const totalCells = gridCols * gridRows;
  for (const cell of cells) {
    if (!Number.isSafeInteger(cell) || cell < 0 || cell >= totalCells) {
      return { ok: false, reason: 'cell_out_of_bounds' };
    }
  }

  const sorted = [...cells].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === sorted[i - 1]) {
      return { ok: false, reason: 'duplicate_cells' };
    }
  }

  const rows = sorted.map((c) => Math.floor(c / gridCols));
  const cols = sorted.map((c) => c % gridCols);
  const sameRow = rows.every((r) => r === rows[0]);
  const consecutiveCols = cols.every((col, idx) => idx === 0 || col - cols[idx - 1]! === 1);
  const sameCol = cols.every((c) => c === cols[0]);
  const consecutiveRows = rows.every((row, idx) => idx === 0 || row - rows[idx - 1]! === 1);

  if (!(sameRow && consecutiveCols) && !(sameCol && consecutiveRows)) {
    return { ok: false, reason: 'not_contiguous_or_collinear' };
  }
  return { ok: true, normalizedCells: sorted };
}

export function validatePlacementCells(
  gridCols: number,
  gridRows: number,
  occupiedCells: Iterable<number>,
  vehicleType: VehicleType,
  cells: readonly number[],
): PlacementValidationResult {
  const shape = validatePlacementShape(gridCols, gridRows, vehicleType, cells);
  if (!shape.ok) return shape;
  const occupiedSet = new Set<number>(occupiedCells);
  for (const cell of shape.normalizedCells) {
    if (occupiedSet.has(cell)) return { ok: false, reason: 'cell_occupied' };
  }
  return shape;
}

export function listValidPlacements(
  gridCols: number,
  gridRows: number,
  occupiedCells: Iterable<number>,
  vehicleType: VehicleType,
): ReadonlyArray<readonly number[]> {
  assertPositiveGridDimensions(gridCols, gridRows);
  const totalCells = gridCols * gridRows;
  const occupied = new Uint8Array(totalCells);
  for (const cell of occupiedCells) {
    if (Number.isSafeInteger(cell) && cell >= 0 && cell < totalCells) occupied[cell] = 1;
  }

  const span = vehicleType === 'sedan_2x1' ? 2 : 3;
  const placements: Array<readonly number[]> = [];

  for (let row = 0; row < gridRows; row += 1) {
    for (let col = 0; col <= gridCols - span; col += 1) {
      const s = row * gridCols + col;
      if (span === 2 && occupied[s] === 0 && occupied[s + 1] === 0) {
        placements.push([s, s + 1] as const);
      } else if (span === 3 && occupied[s] === 0 && occupied[s + 1] === 0 && occupied[s + 2] === 0) {
        placements.push([s, s + 1, s + 2] as const);
      }
    }
  }

  for (let row = 0; row <= gridRows - span; row += 1) {
    for (let col = 0; col < gridCols; col += 1) {
      const s = row * gridCols + col;
      if (span === 2 && occupied[s] === 0 && occupied[s + gridCols] === 0) {
        placements.push([s, s + gridCols] as const);
      } else if (
        span === 3 &&
        occupied[s] === 0 &&
        occupied[s + gridCols] === 0 &&
        occupied[s + 2 * gridCols] === 0
      ) {
        placements.push([s, s + gridCols, s + 2 * gridCols] as const);
      }
    }
  }

  placements.sort((a, b) => {
    const d0 = a[0]! - b[0]!;
    if (d0 !== 0) return d0;
    const d1 = a[1]! - b[1]!;
    if (d1 !== 0) return d1;
    return (a[2] ?? 0) - (b[2] ?? 0);
  });
  return placements;
}

export function evaluatePlacement(
  gridCols: number,
  gridRows: number,
  occupiedCells: Iterable<number>,
  elevatorCell: number,
  vehicleType: VehicleType,
  cells: readonly number[],
): PlacementEvaluation {
  assertPositiveGridDimensions(gridCols, gridRows);
  const totalCells = gridCols * gridRows;
  if (!Number.isSafeInteger(elevatorCell) || elevatorCell < 0 || elevatorCell >= totalCells) {
    throw new RangeError(`Elevator cell ${elevatorCell} is outside grid bounds 0..${totalCells - 1}`);
  }

  const occupiedSet = new Set<number>();
  for (const cell of occupiedCells) {
    if (Number.isSafeInteger(cell) && cell >= 0 && cell < totalCells) occupiedSet.add(cell);
  }

  const validation = validatePlacementCells(gridCols, gridRows, occupiedSet, vehicleType, cells);
  if (!validation.ok) {
    throw new RangeError(`Invalid placement (${validation.reason})`);
  }

  const normalizedCells = validation.normalizedCells;
  const beforeCapacity = computeStandardStallCapacity(gridCols, gridRows, occupiedSet);
  const afterCapacity = computeStandardStallCapacity(gridCols, gridRows, [
    ...occupiedSet,
    ...normalizedCells,
  ]);

  const remainingStallsBefore = beforeCapacity.remainingStalls;
  const remainingStallsAfter = afterCapacity.remainingStalls;
  const delta = remainingStallsBefore - remainingStallsAfter;

  const allValidPlacements = listValidPlacements(gridCols, gridRows, occupiedSet, vehicleType);
  let minUnavoidableCost = delta;
  for (const candidate of allValidPlacements) {
    if (minUnavoidableCost <= 1) break;
    const candidateAfter = computeStandardStallCapacity(gridCols, gridRows, [...occupiedSet, ...candidate]);
    const candidateDelta = remainingStallsBefore - candidateAfter.remainingStalls;
    if (candidateDelta < minUnavoidableCost) minUnavoidableCost = candidateDelta;
  }

  const wastedStalls = delta - minUnavoidableCost;
  const elevRow = Math.floor(elevatorCell / gridCols);
  const elevCol = elevatorCell % gridCols;
  let minElevatorDistance = Number.POSITIVE_INFINITY;
  for (const cell of normalizedCells) {
    const manhattan = Math.abs(Math.floor(cell / gridCols) - elevRow) + Math.abs((cell % gridCols) - elevCol);
    if (manhattan < minElevatorDistance) minElevatorDistance = manhattan;
  }

  const maxGridDistance = gridRows - 1 + (gridCols - 1);
  const elevatorBonus = wastedStalls === 0 ? (maxGridDistance + 1 - minElevatorDistance) * 2 : 0;
  const stepScore = Math.max(0, 100 - wastedStalls * 45) + elevatorBonus;

  return {
    vehicleType,
    cells: normalizedCells,
    remainingStallsBefore,
    remainingStallsAfter,
    delta,
    minUnavoidableCost,
    wastedStalls,
    minElevatorDistance,
    elevatorBonus,
    stepScore,
    ghostPairsAfter: afterCapacity.ghostPairs,
    deadSpotsAfter: afterCapacity.deadSpots,
  };
}

function addDaysToIsoDate(isoDate: string, days: number): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (match === null) return null;
  const year = Number.parseInt(match[1] ?? '', 10);
  const month = Number.parseInt(match[2] ?? '', 10);
  const day = Number.parseInt(match[3] ?? '', 10);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return new Date(parsed.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

export function computeNextUserStreak(previous: UserStreakStats, puzzleDate: string): UserStreakStats {
  const prevLastDate = previous.lastPlayedPuzzleDate;
  const nextTotalShifts = previous.totalShifts + 1;

  if (prevLastDate === null || prevLastDate.length === 0) {
    return {
      currentStreak: 1,
      bestStreak: Math.max(previous.bestStreak, 1),
      totalShifts: nextTotalShifts,
      lastPlayedPuzzleDate: puzzleDate,
    };
  }

  // Playing a second post from the same calendar puzzleDate must not inflate daily streak.
  if (prevLastDate === puzzleDate) {
    const currentStreak = Math.max(1, previous.currentStreak);
    return {
      currentStreak,
      bestStreak: Math.max(previous.bestStreak, currentStreak),
      totalShifts: nextTotalShifts,
      lastPlayedPuzzleDate: puzzleDate,
    };
  }

  // Playing an older historical post preserves the player's latest streak watermark.
  if (puzzleDate < prevLastDate) {
    const currentStreak = Math.max(1, previous.currentStreak);
    return {
      currentStreak,
      bestStreak: Math.max(previous.bestStreak, currentStreak),
      totalShifts: nextTotalShifts,
      lastPlayedPuzzleDate: prevLastDate,
    };
  }

  const currentStreak =
    addDaysToIsoDate(prevLastDate, 1) === puzzleDate ? Math.max(1, previous.currentStreak) + 1 : 1;
  return {
    currentStreak,
    bestStreak: Math.max(previous.bestStreak, currentStreak),
    totalShifts: nextTotalShifts,
    lastPlayedPuzzleDate: puzzleDate,
  };
}
