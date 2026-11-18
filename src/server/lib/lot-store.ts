import type { RedisClient } from '@devvit/redis';
import {
  computeStandardStallCapacity,
  DEFAULT_GRID_COLS,
  DEFAULT_GRID_ROWS,
  type EnvironmentalObstacle,
  type FloorStatus,
  type FloorTabSummary,
  type FloorView,
  generateSeededFloor,
  generateWarmUpBays,
  isPresetWindowNoteId,
  LOT_SCHEMA_VERSION,
  type LotStateResponse,
  type LotSummaryResponse,
  OBSTACLE_KINDS,
  type ObstacleKind,
  type ParkedVehicle,
  type PlacementReceipt,
  selectLiveFloorVehicle,
  type StoredFloorRecord,
  type StoredLotMeta,
  type UserStreakStats,
  type ViewerMode,
  WINDOW_NOTE_LABELS,
  type WindowNoteId,
} from '../../shared/domain';

export const CRON_STATUS_KEY = 's1:ops:cron_status' as const;

export interface PostSeedDefaults {
  readonly puzzleDate: string;
  readonly seed: string;
  readonly gridCols: number;
  readonly gridRows: number;
}

export function buildPostScopedLotKeys(postId: string): [string, string, string, string] {
  return [
    `s1:post:${postId}:meta`,
    `s1:post:${postId}:floors`,
    `s1:post:${postId}:placements`,
    `s1:post:${postId}:lb`,
  ];
}

export function buildCronLockKey(puzzleDate: string): string {
  return `s1:ops:cron_lock:${puzzleDate}`;
}

export function formatSpoilerSafeBattleReport(
  receipt: PlacementReceipt,
  windowNoteId: WindowNoteId | null,
): string {
  const vehicleLabel = receipt.vehicleType === 'van_3x1' ? '3x1 Van' : '2x1 Sedan';
  const lines = [
    `**Last Spot Shift Report (${receipt.puzzleDate})** — Driver: u/${receipt.username}`,
    `Floor B${receipt.floorNumber} | Vehicle: ${vehicleLabel} | Wasted Stalls: ${receipt.wastedStalls} | Elevator Bonus: +${receipt.elevatorBonus} | Shift Score: ${receipt.totalShiftScore}`,
  ];
  if (receipt.crownedLastSpotHero) {
    lines.push('Badge: **Last Spot Hero** (sealed the final open stall on the floor)');
  }
  if (windowNoteId !== null) {
    lines.push(`Window Note: "${WINDOW_NOTE_LABELS[windowNoteId]}"`);
  }
  return lines.join('\n');
}

export function buildUserStatsKey(userId: string): string {
  return `s1:user:${userId}:stats`;
}

function parseSafeInt(rawValue: string | undefined, fallback: number, minValue: number): number {
  if (rawValue === undefined) return fallback;
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isSafeInteger(parsed) && parsed >= minValue ? parsed : fallback;
}

export function extractPostSeedDefaults(
  postId: string,
  postData: unknown,
  nowEpochMs: number,
): PostSeedDefaults {
  const fallbackDate = new Date(nowEpochMs).toISOString().slice(0, 10);
  const record =
    postData !== null && typeof postData === 'object' && !Array.isArray(postData)
      ? (postData as Record<string, unknown>)
      : {};

  const puzzleDate =
    typeof record.puzzleDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record.puzzleDate)
      ? record.puzzleDate
      : fallbackDate;
  const seed =
    typeof record.seed === 'string' && record.seed.trim().length > 0
      ? record.seed.trim()
      : `lot:${postId}`;
  const gridCols =
    typeof record.gridCols === 'number' &&
    Number.isSafeInteger(record.gridCols) &&
    record.gridCols >= 6 &&
    record.gridCols <= 7
      ? record.gridCols
      : DEFAULT_GRID_COLS;
  const gridRows =
    typeof record.gridRows === 'number' && Number.isSafeInteger(record.gridRows) && record.gridRows === 6
      ? record.gridRows
      : DEFAULT_GRID_ROWS;

  return { puzzleDate, seed, gridCols, gridRows };
}

export function parseStoredLotMeta(
  rawMeta: Record<string, string>,
  defaults: PostSeedDefaults,
): StoredLotMeta {
  return {
    schemaVersion: parseSafeInt(rawMeta.schemaVersion, LOT_SCHEMA_VERSION, 1),
    puzzleDate:
      typeof rawMeta.puzzleDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawMeta.puzzleDate)
        ? rawMeta.puzzleDate
        : defaults.puzzleDate,
    seed: typeof rawMeta.seed === 'string' && rawMeta.seed.length > 0 ? rawMeta.seed : defaults.seed,
    gridCols: parseSafeInt(rawMeta.gridCols, defaults.gridCols, 6),
    gridRows: parseSafeInt(rawMeta.gridRows, defaults.gridRows, 6),
    activeFloor: parseSafeInt(rawMeta.activeFloor, 1, 1),
    floorCount: parseSafeInt(rawMeta.floorCount, 1, 1),
    revision: parseSafeInt(rawMeta.revision, 0, 0),
  };
}

function isValidObstacleKind(kind: unknown): kind is ObstacleKind {
  return typeof kind === 'string' && (OBSTACLE_KINDS as readonly string[]).includes(kind);
}

export function parseStoredFloorRecord(
  rawJson: string | undefined,
  fallbackFloorNumber: number,
  fallbackSeed: string,
): StoredFloorRecord | null {
  if (typeof rawJson !== 'string' || rawJson.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;

    const obstacles: EnvironmentalObstacle[] = [];
    for (const item of Array.isArray(obj.obstacles) ? obj.obstacles : []) {
      if (item !== null && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        if (typeof rec.cell === 'number' && Number.isSafeInteger(rec.cell)) {
          obstacles.push({ cell: rec.cell, kind: isValidObstacleKind(rec.kind) ? rec.kind : 'pillar' });
        }
      }
    }

    const vehicles: ParkedVehicle[] = [];
    for (const item of Array.isArray(obj.vehicles) ? obj.vehicles : []) {
      if (item !== null && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        if (
          typeof rec.userId === 'string' &&
          (rec.vehicleType === 'sedan_2x1' || rec.vehicleType === 'van_3x1') &&
          Array.isArray(rec.cells)
        ) {
          const rawNote = typeof rec.windowNoteId === 'string' ? rec.windowNoteId : null;
          vehicles.push({
            userId: rec.userId,
            username: typeof rec.username === 'string' ? rec.username : rec.userId,
            snoovatar: typeof rec.snoovatar === 'string' ? rec.snoovatar : null,
            vehicleType: rec.vehicleType,
            cells: rec.cells.filter((c): c is number => typeof c === 'number' && Number.isSafeInteger(c)),
            wastedStalls: typeof rec.wastedStalls === 'number' ? rec.wastedStalls : 0,
            elevatorBonus: typeof rec.elevatorBonus === 'number' ? rec.elevatorBonus : 0,
            stepScore: typeof rec.stepScore === 'number' ? rec.stepScore : 0,
            windowNoteId: isPresetWindowNoteId(rawNote) ? rawNote : null,
            parkedAtIso: typeof rec.parkedAtIso === 'string' ? rec.parkedAtIso : '',
          });
        }
      }
    }

    const status: FloorStatus = obj.status === 'ARCHIVED' ? 'ARCHIVED' : 'LIVE';
    return {
      floorNumber:
        typeof obj.floorNumber === 'number' && Number.isSafeInteger(obj.floorNumber)
          ? obj.floorNumber
          : fallbackFloorNumber,
      seed: typeof obj.seed === 'string' ? obj.seed : fallbackSeed,
      elevatorCell:
        typeof obj.elevatorCell === 'number' && Number.isSafeInteger(obj.elevatorCell) ? obj.elevatorCell : 0,
      obstacles,
      vehicles,
      remainingStalls:
        typeof obj.remainingStalls === 'number' && Number.isSafeInteger(obj.remainingStalls)
          ? obj.remainingStalls
          : 0,
      status,
      lastSpotHero: typeof obj.lastSpotHero === 'string' ? obj.lastSpotHero : null,
    };
  } catch {
    return null;
  }
}

export function parsePlacementReceipt(rawJson: string | undefined): PlacementReceipt | null {
  if (typeof rawJson !== 'string' || rawJson.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as PlacementReceipt;
  } catch {
    return null;
  }
}

export function parseUserStreakStats(rawStats: Record<string, string>): UserStreakStats {
  const lastPlayed = rawStats.lastPlayedPuzzleDate;
  return {
    currentStreak: parseSafeInt(rawStats.currentStreak, 0, 0),
    bestStreak: parseSafeInt(rawStats.bestStreak, 0, 0),
    totalShifts: parseSafeInt(rawStats.totalShifts, 0, 0),
    lastPlayedPuzzleDate: typeof lastPlayed === 'string' && lastPlayed.length > 0 ? lastPlayed : null,
  };
}

export function buildFloorView(record: StoredFloorRecord, gridCols: number, gridRows: number): FloorView {
  const occupiedSet = new Set<number>();
  for (const obs of record.obstacles) occupiedSet.add(obs.cell);
  for (const vehicle of record.vehicles) {
    for (const cell of vehicle.cells) occupiedSet.add(cell);
  }
  const occupiedCells = [...occupiedSet].sort((a, b) => a - b);
  const capacity = computeStandardStallCapacity(gridCols, gridRows, occupiedCells);
  return {
    ...record,
    remainingStalls: capacity.remainingStalls,
    gridCols,
    gridRows,
    occupiedCells,
    ghostPairs: capacity.ghostPairs,
    deadSpots: capacity.deadSpots,
  };
}

export async function ensurePostLotInitialized(
  redisClient: RedisClient,
  postId: string,
  defaults: PostSeedDefaults,
): Promise<void> {
  const [metaKey, floorsKey] = buildPostScopedLotKeys(postId);
  const [existingMeta, existingFloor1] = await Promise.all([
    redisClient.hGetAll(metaKey),
    redisClient.hGet(floorsKey, '1'),
  ]);

  if (
    existingMeta.schemaVersion !== undefined &&
    existingMeta.activeFloor !== undefined &&
    existingFloor1 !== undefined
  ) {
    return;
  }

  const effectiveMeta = parseStoredLotMeta(existingMeta, defaults);
  const seeded1 = generateSeededFloor(effectiveMeta.seed, 1, {
    gridCols: effectiveMeta.gridCols,
    gridRows: effectiveMeta.gridRows,
  });
  const floor1Record: StoredFloorRecord = {
    floorNumber: 1,
    seed: seeded1.seed,
    elevatorCell: seeded1.elevatorCell,
    obstacles: seeded1.obstacles,
    vehicles: [],
    remainingStalls: seeded1.remainingStalls,
    status: 'LIVE',
    lastSpotHero: null,
  };

  // hSetNX per field guarantees concurrent lazy initializers never overwrite live progress.
  await redisClient.hSetNX(floorsKey, '1', JSON.stringify(floor1Record));
  await redisClient.hSetNX(metaKey, 'schemaVersion', String(LOT_SCHEMA_VERSION));
  await redisClient.hSetNX(metaKey, 'puzzleDate', effectiveMeta.puzzleDate);
  await redisClient.hSetNX(metaKey, 'seed', effectiveMeta.seed);
  await redisClient.hSetNX(metaKey, 'gridCols', String(effectiveMeta.gridCols));
  await redisClient.hSetNX(metaKey, 'gridRows', String(effectiveMeta.gridRows));
  await redisClient.hSetNX(metaKey, 'activeFloor', '1');
  await redisClient.hSetNX(metaKey, 'floorCount', '1');
  await redisClient.hSetNX(metaKey, 'revision', '0');
}

export async function readLotSummarySnapshot(
  redisClient: RedisClient,
  postId: string,
  defaults: PostSeedDefaults,
): Promise<LotSummaryResponse> {
  await ensurePostLotInitialized(redisClient, postId, defaults);
  const [metaKey, floorsKey] = buildPostScopedLotKeys(postId);
  const meta = parseStoredLotMeta(await redisClient.hGetAll(metaKey), defaults);
  const rawFloor = await redisClient.hGet(floorsKey, String(meta.activeFloor));
  const storedFloor =
    parseStoredFloorRecord(rawFloor, meta.activeFloor, `${meta.seed}:floor:${meta.activeFloor}`) ?? {
      floorNumber: meta.activeFloor,
      seed: `${meta.seed}:floor:${meta.activeFloor}`,
      elevatorCell: 0,
      obstacles: [],
      vehicles: [],
      remainingStalls: 0,
      status: 'LIVE' as const,
      lastSpotHero: null,
    };
  const floorView = buildFloorView(storedFloor, meta.gridCols, meta.gridRows);

  return {
    ok: true,
    postId,
    activeFloor: meta.activeFloor,
    floorCount: meta.floorCount,
    gridCols: meta.gridCols,
    gridRows: meta.gridRows,
    elevatorCell: floorView.elevatorCell,
    occupiedCells: floorView.occupiedCells,
    occupiedCount: floorView.occupiedCells.length,
    totalCells: meta.gridCols * meta.gridRows,
    remainingStalls: floorView.remainingStalls,
    status: floorView.status,
  };
}

export async function readLotStateSnapshot(
  redisClient: RedisClient,
  postId: string,
  authenticatedUserId: string | null,
  requestedFloorNumber: number | undefined,
  defaults: PostSeedDefaults,
): Promise<
  | { readonly ok: true; readonly state: LotStateResponse }
  | { readonly ok: false; readonly reason: 'invalid_floor_query' }
> {
  await ensurePostLotInitialized(redisClient, postId, defaults);
  const [metaKey, floorsKey, placementsKey] = buildPostScopedLotKeys(postId);
  const [rawMeta, rawFloors, rawMyPlacement, rawUserStats] = await Promise.all([
    redisClient.hGetAll(metaKey),
    redisClient.hGetAll(floorsKey),
    authenticatedUserId !== null ? redisClient.hGet(placementsKey, authenticatedUserId) : Promise.resolve(undefined),
    authenticatedUserId !== null
      ? redisClient.hGetAll(buildUserStatsKey(authenticatedUserId))
      : Promise.resolve({} as Record<string, string>),
  ]);

  const meta = parseStoredLotMeta(rawMeta, defaults);
  if (
    requestedFloorNumber !== undefined &&
    (requestedFloorNumber < 1 ||
      requestedFloorNumber > meta.floorCount ||
      rawFloors[String(requestedFloorNumber)] === undefined)
  ) {
    return { ok: false, reason: 'invalid_floor_query' };
  }

  const floorViews = new Map<number, FloorView>();
  const floorsSummary: FloorTabSummary[] = [];
  for (let num = 1; num <= meta.floorCount; num += 1) {
    const parsed = parseStoredFloorRecord(rawFloors[String(num)], num, `${meta.seed}:floor:${num}`);
    if (parsed !== null) {
      const view = buildFloorView(parsed, meta.gridCols, meta.gridRows);
      floorViews.set(num, view);
      const heroVehicle =
        view.lastSpotHero !== null
          ? view.vehicles.find((v) => v.userId === view.lastSpotHero)
          : undefined;
      floorsSummary.push({
        floorNumber: num,
        label: `B${num}`,
        status: view.status,
        remainingStalls: view.remainingStalls,
        vehicleCount: view.vehicles.length,
        lastSpotHero: view.lastSpotHero,
        lastSpotHeroUsername: heroVehicle?.username ?? view.lastSpotHero,
      });
    }
  }

  const liveFloor = floorViews.get(meta.activeFloor);
  if (liveFloor === undefined) return { ok: false, reason: 'invalid_floor_query' };
  const requestedFloor = floorViews.get(requestedFloorNumber ?? meta.activeFloor) ?? liveFloor;
  const viewerMode: ViewerMode = authenticatedUserId !== null ? 'OFFICIAL_LIVE' : 'VISITOR_HOLD';

  return {
    ok: true,
    state: {
      ok: true,
      postId,
      puzzleDate: meta.puzzleDate,
      gridCols: meta.gridCols,
      gridRows: meta.gridRows,
      viewerMode,
      revision: meta.revision,
      activeFloor: meta.activeFloor,
      floorCount: meta.floorCount,
      warmUpBays: generateWarmUpBays(meta.seed),
      assignedVehicle: selectLiveFloorVehicle(
        meta.seed,
        meta.activeFloor,
        liveFloor.occupiedCells,
        meta.gridCols,
        meta.gridRows,
      ),
      liveFloor,
      requestedFloor,
      floorsSummary,
      myPlacement: authenticatedUserId !== null ? parsePlacementReceipt(rawMyPlacement) : null,
      streak:
        authenticatedUserId !== null
          ? parseUserStreakStats(rawUserStats)
          : { currentStreak: 0, bestStreak: 0, totalShifts: 0, lastPlayedPuzzleDate: null },
    },
  };
}
