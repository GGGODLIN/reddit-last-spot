export const LOT_SCHEMA_VERSION = 1 as const;
export const DEFAULT_GRID_COLS = 6 as const;
export const DEFAULT_GRID_ROWS = 6 as const;
export const MAX_FLOORS = 50 as const;

export type VehicleType = 'sedan_2x1' | 'van_3x1';

export const OBSTACLE_KINDS = ['pillar', 'hydrant', 'corral', 'tarped_car'] as const;
export type ObstacleKind = (typeof OBSTACLE_KINDS)[number];

export type FloorStatus = 'LIVE' | 'ARCHIVED';

export type ViewerMode = 'OFFICIAL_LIVE' | 'VISITOR_HOLD';

export const WINDOW_NOTE_IDS = [
  'tight_fit',
  'zero_waste',
  'elevator_vip',
  'compact_pro',
  'clutch_park',
] as const;
export type WindowNoteId = (typeof WINDOW_NOTE_IDS)[number];

export const WINDOW_NOTE_LABELS: Readonly<Record<WindowNoteId, string>> = {
  tight_fit: 'Mirrors folded — clean fit.',
  zero_waste: 'Zero stalls wasted.',
  elevator_vip: 'Saved steps to the elevator.',
  compact_pro: 'Left room for the next driver.',
  clutch_park: 'Threaded the needle.',
};

export interface EnvironmentalObstacle {
  readonly cell: number;
  readonly kind: ObstacleKind;
}

export interface ParkedVehicle {
  readonly userId: string;
  readonly username: string;
  readonly snoovatar: string | null;
  readonly vehicleType: VehicleType;
  readonly cells: readonly number[];
  readonly wastedStalls: number;
  readonly elevatorBonus: number;
  readonly stepScore: number;
  readonly windowNoteId: WindowNoteId | null;
  readonly parkedAtIso: string;
}

export interface StandardStallCapacityResult {
  readonly remainingStalls: number;
  readonly ghostPairs: ReadonlyArray<readonly [number, number]>;
  readonly deadSpots: ReadonlyArray<number>;
}

export type PlacementValidationFailureReason =
  | 'invalid_grid_dimensions'
  | 'wrong_cell_count'
  | 'cell_out_of_bounds'
  | 'duplicate_cells'
  | 'not_contiguous_or_collinear'
  | 'cell_occupied';

export type PlacementShapeValidationResult =
  | { readonly ok: true; readonly normalizedCells: readonly number[] }
  | { readonly ok: false; readonly reason: Exclude<PlacementValidationFailureReason, 'cell_occupied'> };

export type PlacementValidationResult =
  | { readonly ok: true; readonly normalizedCells: readonly number[] }
  | { readonly ok: false; readonly reason: PlacementValidationFailureReason };

export interface PlacementEvaluation {
  readonly vehicleType: VehicleType;
  readonly cells: readonly number[];
  readonly remainingStallsBefore: number;
  readonly remainingStallsAfter: number;
  readonly delta: number;
  readonly minUnavoidableCost: number;
  readonly wastedStalls: number;
  readonly minElevatorDistance: number;
  readonly elevatorBonus: number;
  readonly stepScore: number;
  readonly ghostPairsAfter: ReadonlyArray<readonly [number, number]>;
  readonly deadSpotsAfter: ReadonlyArray<number>;
}

export interface GenerateFloorOptions {
  readonly gridCols?: number;
  readonly gridRows?: number;
}

export interface SeededFloorSpec {
  readonly floorNumber: number;
  readonly seed: string;
  readonly gridCols: number;
  readonly gridRows: number;
  readonly elevatorCell: number;
  readonly obstacles: ReadonlyArray<EnvironmentalObstacle>;
  readonly remainingStalls: number;
  readonly ghostPairs: ReadonlyArray<readonly [number, number]>;
  readonly deadSpots: ReadonlyArray<number>;
}

export interface WarmUpBaySpec {
  readonly bayNumber: 1 | 2;
  readonly gridCols: number;
  readonly gridRows: number;
  readonly elevatorCell: number;
  readonly assignedVehicle: VehicleType;
  readonly obstacles: ReadonlyArray<EnvironmentalObstacle>;
  readonly remainingStalls: number;
  readonly ghostPairs: ReadonlyArray<readonly [number, number]>;
  readonly deadSpots: ReadonlyArray<number>;
}

export interface StoredLotMeta {
  readonly schemaVersion: number;
  readonly puzzleDate: string;
  readonly seed: string;
  readonly gridCols: number;
  readonly gridRows: number;
  readonly activeFloor: number;
  readonly floorCount: number;
  readonly revision: number;
}

export interface StoredFloorRecord {
  readonly floorNumber: number;
  readonly seed: string;
  readonly elevatorCell: number;
  readonly obstacles: ReadonlyArray<EnvironmentalObstacle>;
  readonly vehicles: ReadonlyArray<ParkedVehicle>;
  readonly remainingStalls: number;
  readonly status: FloorStatus;
  readonly lastSpotHero: string | null;
}

export interface FloorView extends StoredFloorRecord {
  readonly gridCols: number;
  readonly gridRows: number;
  readonly occupiedCells: ReadonlyArray<number>;
  readonly ghostPairs: ReadonlyArray<readonly [number, number]>;
  readonly deadSpots: ReadonlyArray<number>;
}

export interface FloorTabSummary {
  readonly floorNumber: number;
  readonly label: string;
  readonly status: FloorStatus;
  readonly remainingStalls: number;
  readonly vehicleCount: number;
  readonly lastSpotHero: string | null;
  readonly lastSpotHeroUsername: string | null;
}

export interface UserStreakStats {
  readonly currentStreak: number;
  readonly bestStreak: number;
  readonly totalShifts: number;
  readonly lastPlayedPuzzleDate: string | null;
}

export interface PlacementReceipt {
  readonly postId: string;
  readonly puzzleDate: string;
  readonly userId: string;
  readonly username: string;
  readonly snoovatar: string | null;
  readonly floorNumber: number;
  readonly revision: number;
  readonly vehicleType: VehicleType;
  readonly cells: readonly number[];
  readonly wastedStalls: number;
  readonly elevatorBonus: number;
  readonly stepScore: number;
  readonly totalShiftScore: number;
  readonly remainingStallsBefore: number;
  readonly remainingStallsAfter: number;
  readonly ghostPairsAfter: ReadonlyArray<readonly [number, number]>;
  readonly deadSpotsAfter: ReadonlyArray<number>;
  readonly crownedLastSpotHero: boolean;
  readonly openedOverflowFloor: number | null;
  readonly windowNoteId: WindowNoteId | null;
  readonly parkedAtIso: string;
  readonly streak: UserStreakStats;
}

export interface LotSummaryResponse {
  readonly ok: true;
  readonly postId: string;
  readonly activeFloor: number;
  readonly floorCount: number;
  readonly gridCols: number;
  readonly gridRows: number;
  readonly elevatorCell: number;
  readonly occupiedCells: ReadonlyArray<number>;
  readonly occupiedCount: number;
  readonly totalCells: number;
  readonly remainingStalls: number;
  readonly status: FloorStatus;
}

export interface LotStateResponse {
  readonly ok: true;
  readonly postId: string;
  readonly puzzleDate: string;
  readonly gridCols: number;
  readonly gridRows: number;
  readonly viewerMode: ViewerMode;
  readonly revision: number;
  readonly activeFloor: number;
  readonly floorCount: number;
  readonly warmUpBays: readonly [WarmUpBaySpec, WarmUpBaySpec];
  readonly assignedVehicle: VehicleType;
  readonly liveFloor: FloorView;
  readonly requestedFloor: FloorView;
  readonly floorsSummary: ReadonlyArray<FloorTabSummary>;
  readonly myPlacement: PlacementReceipt | null;
  readonly streak: UserStreakStats;
}

export interface ParkClientPreview {
  readonly wastedStalls: number;
  readonly remainingStallsAfter: number;
}

export interface ParkRequestPayload {
  readonly floorNumber: number;
  readonly expectedRevision: number;
  readonly vehicleType: VehicleType;
  readonly cells: readonly number[];
  readonly warmUpScores?: readonly [number, number];
  readonly windowNoteId?: WindowNoteId | null;
  readonly clientPreview: ParkClientPreview;
}

export type ParkResponse =
  | {
      readonly ok: true;
      readonly alreadyCommitted: boolean;
      readonly receipt: PlacementReceipt;
      readonly latestLotState: LotStateResponse | null;
    }
  | {
      readonly ok: false;
      readonly code:
        | 'LOGIN_REQUIRED_FOR_OFFICIAL_SPOT'
        | 'INVALID_PARK_PAYLOAD'
        | 'SPOT_TAKEN'
        | 'LOT_UPDATED_RETRY_PREVIEW'
        | 'CONCURRENT_CONFLICT_RETRY_EXHAUSTED';
      readonly latestLotState?: LotStateResponse | null;
    };

