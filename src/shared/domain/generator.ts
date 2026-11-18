import seedrandomModule from 'seedrandom';
import { computeStandardStallCapacity, evaluatePlacement, listValidPlacements } from './capacity';
import {
  DEFAULT_GRID_COLS,
  DEFAULT_GRID_ROWS,
  type EnvironmentalObstacle,
  type GenerateFloorOptions,
  OBSTACLE_KINDS,
  type ObstacleKind,
  type SeededFloorSpec,
  type VehicleType,
  type WarmUpBaySpec,
} from './types';

function createPrng(seed: string): seedrandomModule.PRNG {
  const candidate: unknown = seedrandomModule;
  if (typeof candidate === 'function') {
    return (candidate as typeof seedrandomModule)(seed);
  }
  return (candidate as { readonly default: typeof seedrandomModule }).default(seed);
}

function listPerimeterCells(gridCols: number, gridRows: number): number[] {
  const perimeter: number[] = [];
  for (let row = 0; row < gridRows; row += 1) {
    for (let col = 0; col < gridCols; col += 1) {
      if (row === 0 || row === gridRows - 1 || col === 0 || col === gridCols - 1) {
        perimeter.push(row * gridCols + col);
      }
    }
  }
  return perimeter;
}

function pickRandomInt(rng: seedrandomModule.PRNG, minInclusive: number, maxInclusive: number): number {
  return minInclusive + Math.floor(rng() * (maxInclusive - minInclusive + 1));
}

function assignObstacleKinds(
  rng: seedrandomModule.PRNG,
  obstacleCells: readonly number[],
): EnvironmentalObstacle[] {
  return [...obstacleCells]
    .sort((a, b) => a - b)
    .map((cell) => {
      const kind: ObstacleKind = OBSTACLE_KINDS[Math.floor(rng() * OBSTACLE_KINDS.length)] ?? 'pillar';
      return { cell, kind };
    });
}

function collectWastedStallValues(
  gridCols: number,
  gridRows: number,
  occupiedCells: readonly number[],
  elevatorCell: number,
  vehicleType: VehicleType,
): Set<number> {
  const distinctWasted = new Set<number>();
  for (const cells of listValidPlacements(gridCols, gridRows, occupiedCells, vehicleType)) {
    distinctWasted.add(
      evaluatePlacement(gridCols, gridRows, occupiedCells, elevatorCell, vehicleType, cells).wastedStalls,
    );
  }
  return distinctWasted;
}

function transformSquareCoord(
  row: number,
  col: number,
  side: number,
  symmetry: number,
): readonly [number, number] {
  const r1 = (symmetry & 1) !== 0 ? side - 1 - row : row;
  const c1 = (symmetry & 2) !== 0 ? side - 1 - col : col;
  return (symmetry & 4) !== 0 ? ([c1, r1] as const) : ([r1, c1] as const);
}

/**
 * Deterministic fallback motif on >= 6x6 grids leaving 15 empty cells (7 standard stalls):
 * 4-cell path (sedan_2x1 gets {0,1}; van_3x1 gets 1), 3-cell path (van_3x1 gets 0), 2x3 block, and 2x1 pair.
 */
function buildFallbackLiveEmptySet(gridCols: number, gridRows: number, symmetrySeed: number): Set<number> {
  const baseCoords: ReadonlyArray<readonly [number, number]> = [
    [0, 0], [0, 1], [0, 2], [0, 3],
    [2, 1], [2, 2], [2, 3],
    [4, 0], [4, 1], [4, 2], [5, 0], [5, 1], [5, 2],
    [3, 5], [4, 5],
  ];
  const canTranspose = gridCols === gridRows && gridCols >= 6;
  const symmetry = canTranspose ? symmetrySeed & 7 : symmetrySeed & 3;
  const emptySet = new Set<number>();
  for (const [r, c] of baseCoords) {
    if (canTranspose) {
      const [tr, tc] = transformSquareCoord(r, c, gridCols, symmetry);
      emptySet.add(tr * gridCols + tc);
    } else {
      const fr = (symmetry & 1) !== 0 ? gridRows - 1 - r : r;
      const fc = (symmetry & 2) !== 0 ? gridCols - 1 - c : c;
      emptySet.add(fr * gridCols + fc);
    }
  }
  return emptySet;
}

/**
 * Deterministic fallback motif on 6x6 leaving 15 empty cells (7 standard stalls) where
 * van_3x1 simultaneously reaches wastedStalls = 0 (1x3 strip), 1 (2x3 block), and 2 (6-cell alternating comb).
 */
function buildFallbackVanSpreadEmptySet(symmetrySeed: number): Set<number> {
  const baseCoords: ReadonlyArray<readonly [number, number]> = [
    [0, 0], [0, 2], [1, 0], [1, 1], [1, 2], [2, 1],
    [4, 0], [4, 1], [4, 2], [5, 0], [5, 1], [5, 2],
    [1, 5], [2, 5], [3, 5],
  ];
  const symmetry = symmetrySeed & 7;
  const emptySet = new Set<number>();
  for (const [r, c] of baseCoords) {
    const [tr, tc] = transformSquareCoord(r, c, 6, symmetry);
    emptySet.add(tr * 6 + tc);
  }
  return emptySet;
}

function sampleShuffledObstacleCells(
  rng: seedrandomModule.PRNG,
  totalCells: number,
  obstacleCount: number,
): number[] {
  const deck = Array.from({ length: totalCells }, (_, idx) => idx);
  for (let i = 0; i < obstacleCount; i += 1) {
    const swapIdx = i + Math.floor(rng() * (totalCells - i));
    const tmp = deck[i]!;
    deck[i] = deck[swapIdx]!;
    deck[swapIdx] = tmp;
  }
  return deck.slice(0, obstacleCount).sort((a, b) => a - b);
}

export function selectLiveFloorVehicle(
  seed: string,
  floorNumber: number,
  occupiedCells: Iterable<number>,
  gridCols: number = DEFAULT_GRID_COLS,
  gridRows: number = DEFAULT_GRID_ROWS,
): VehicleType {
  if (listValidPlacements(gridCols, gridRows, occupiedCells, 'van_3x1').length === 0) {
    return 'sedan_2x1';
  }
  return createPrng(`${seed}:live-vehicle:${floorNumber}`)() < 0.45 ? 'van_3x1' : 'sedan_2x1';
}

export function generateSeededFloor(
  seed: string,
  floorNumber: number,
  options: GenerateFloorOptions = {},
): SeededFloorSpec {
  const gridCols = options.gridCols ?? DEFAULT_GRID_COLS;
  const gridRows = options.gridRows ?? DEFAULT_GRID_ROWS;
  if (
    !Number.isSafeInteger(floorNumber) ||
    floorNumber < 1 ||
    !Number.isSafeInteger(gridCols) ||
    !Number.isSafeInteger(gridRows) ||
    gridCols < 6 ||
    gridRows < 6
  ) {
    throw new RangeError(`Invalid floor generation arguments: floor=${floorNumber}, grid=${gridCols}x${gridRows}`);
  }

  const floorSeed = `${seed}:floor:${floorNumber}`;
  const rng = createPrng(floorSeed);
  const totalCells = gridCols * gridRows;
  const perimeter = listPerimeterCells(gridCols, gridRows);
  const elevatorCell = perimeter[Math.floor(rng() * perimeter.length)] ?? 0;
  const minEmpty = 13;
  const maxEmpty = Math.min(18, totalCells - 18);

  for (let attempt = 0; attempt < 120; attempt += 1) {
    const targetEmpty = pickRandomInt(rng, minEmpty, Math.max(minEmpty, maxEmpty));
    const obstacleCells = sampleShuffledObstacleCells(rng, totalCells, totalCells - targetEmpty);
    const capacity = computeStandardStallCapacity(gridCols, gridRows, obstacleCells);
    if (capacity.remainingStalls < 6 || capacity.remainingStalls > 10) continue;

    const sedanWasted = collectWastedStallValues(gridCols, gridRows, obstacleCells, elevatorCell, 'sedan_2x1');
    if (!sedanWasted.has(0) || !sedanWasted.has(1)) continue;

    const assignedVehicle = selectLiveFloorVehicle(seed, floorNumber, obstacleCells, gridCols, gridRows);
    if (assignedVehicle === 'van_3x1') {
      const vanWasted = collectWastedStallValues(gridCols, gridRows, obstacleCells, elevatorCell, 'van_3x1');
      if (!vanWasted.has(0) || (!vanWasted.has(1) && !vanWasted.has(2))) continue;
    }

    return {
      floorNumber,
      seed: floorSeed,
      gridCols,
      gridRows,
      elevatorCell,
      obstacles: assignObstacleKinds(rng, obstacleCells),
      remainingStalls: capacity.remainingStalls,
      ghostPairs: capacity.ghostPairs,
      deadSpots: capacity.deadSpots,
    };
  }

  const fallbackEmpty = buildFallbackLiveEmptySet(gridCols, gridRows, Math.floor(rng() * 8));
  const fallbackObstacles = Array.from({ length: totalCells }, (_, i) => i).filter((c) => !fallbackEmpty.has(c));
  const fallbackCap = computeStandardStallCapacity(gridCols, gridRows, fallbackObstacles);
  return {
    floorNumber,
    seed: floorSeed,
    gridCols,
    gridRows,
    elevatorCell,
    obstacles: assignObstacleKinds(rng, fallbackObstacles),
    remainingStalls: fallbackCap.remainingStalls,
    ghostPairs: fallbackCap.ghostPairs,
    deadSpots: fallbackCap.deadSpots,
  };
}

function generateWarmUpBay1Sedan(seed: string): WarmUpBaySpec {
  const gridCols = DEFAULT_GRID_COLS;
  const gridRows = DEFAULT_GRID_ROWS;
  const totalCells = gridCols * gridRows;
  const rng = createPrng(`${seed}:warmup:bay1`);
  const perimeter = listPerimeterCells(gridCols, gridRows);
  const elevatorCell = perimeter[Math.floor(rng() * perimeter.length)] ?? 0;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const obstacleCells = sampleShuffledObstacleCells(rng, totalCells, totalCells - pickRandomInt(rng, 13, 17));
    const capacity = computeStandardStallCapacity(gridCols, gridRows, obstacleCells);
    if (capacity.remainingStalls < 6 || capacity.remainingStalls > 10) continue;

    const wastedValues = collectWastedStallValues(gridCols, gridRows, obstacleCells, elevatorCell, 'sedan_2x1');
    if (!wastedValues.has(0) || !wastedValues.has(1)) continue;

    return {
      bayNumber: 1,
      gridCols,
      gridRows,
      elevatorCell,
      assignedVehicle: 'sedan_2x1',
      obstacles: assignObstacleKinds(rng, obstacleCells),
      remainingStalls: capacity.remainingStalls,
      ghostPairs: capacity.ghostPairs,
      deadSpots: capacity.deadSpots,
    };
  }

  const fallbackEmpty = buildFallbackLiveEmptySet(gridCols, gridRows, Math.floor(rng() * 8));
  const fallbackObstacles = Array.from({ length: totalCells }, (_, i) => i).filter((c) => !fallbackEmpty.has(c));
  const cap = computeStandardStallCapacity(gridCols, gridRows, fallbackObstacles);
  return {
    bayNumber: 1,
    gridCols,
    gridRows,
    elevatorCell,
    assignedVehicle: 'sedan_2x1',
    obstacles: assignObstacleKinds(rng, fallbackObstacles),
    remainingStalls: cap.remainingStalls,
    ghostPairs: cap.ghostPairs,
    deadSpots: cap.deadSpots,
  };
}

function generateWarmUpBay2Van(seed: string): WarmUpBaySpec {
  const gridCols = DEFAULT_GRID_COLS;
  const gridRows = DEFAULT_GRID_ROWS;
  const totalCells = gridCols * gridRows;
  const rng = createPrng(`${seed}:warmup:bay2`);
  const perimeter = listPerimeterCells(gridCols, gridRows);
  const elevatorCell = perimeter[Math.floor(rng() * perimeter.length)] ?? 0;

  for (let attempt = 0; attempt < 150; attempt += 1) {
    const obstacleCells = sampleShuffledObstacleCells(rng, totalCells, totalCells - pickRandomInt(rng, 14, 18));
    const capacity = computeStandardStallCapacity(gridCols, gridRows, obstacleCells);
    if (capacity.remainingStalls < 6 || capacity.remainingStalls > 10) continue;

    const wastedValues = collectWastedStallValues(gridCols, gridRows, obstacleCells, elevatorCell, 'van_3x1');
    if (!wastedValues.has(0) || !wastedValues.has(1) || !wastedValues.has(2)) continue;

    return {
      bayNumber: 2,
      gridCols,
      gridRows,
      elevatorCell,
      assignedVehicle: 'van_3x1',
      obstacles: assignObstacleKinds(rng, obstacleCells),
      remainingStalls: capacity.remainingStalls,
      ghostPairs: capacity.ghostPairs,
      deadSpots: capacity.deadSpots,
    };
  }

  const fallbackEmpty = buildFallbackVanSpreadEmptySet(Math.floor(rng() * 8));
  const fallbackObstacles = Array.from({ length: totalCells }, (_, i) => i).filter((c) => !fallbackEmpty.has(c));
  const cap = computeStandardStallCapacity(gridCols, gridRows, fallbackObstacles);
  return {
    bayNumber: 2,
    gridCols,
    gridRows,
    elevatorCell,
    assignedVehicle: 'van_3x1',
    obstacles: assignObstacleKinds(rng, fallbackObstacles),
    remainingStalls: cap.remainingStalls,
    ghostPairs: cap.ghostPairs,
    deadSpots: cap.deadSpots,
  };
}

export function generateWarmUpBays(seed: string): readonly [WarmUpBaySpec, WarmUpBaySpec] {
  return [generateWarmUpBay1Sedan(seed), generateWarmUpBay2Van(seed)] as const;
}
