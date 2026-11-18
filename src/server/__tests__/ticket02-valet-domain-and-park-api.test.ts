import { Header } from '@devvit/shared-types/Header.js';
import { createDevvitTest } from '@devvit/test/server/vitest';
import { Context, redis, runWithContext as devvitRunWithContext } from '@devvit/web/server';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  computeStandardStallCapacity,
  evaluatePlacement,
  generateSeededFloor,
  generateWarmUpBays,
  isPerimeterCell,
  listValidPlacements,
  type LotStateResponse,
  type LotSummaryResponse,
  type PlacementEvaluation,
  type PlacementReceipt,
  type StandardStallCapacityResult,
  type StoredFloorRecord,
  type VehicleType,
} from '../../shared/domain';
import { API_ENDPOINTS, ERROR_CODES } from '../../shared/manifest-contract';
import { buildPostScopedLotKeys, createApp } from '../app';
import { createConflictAwareRedisWrapper } from './helpers/conflict-redis-wrapper';

const USER_SPECIFIC_KEYS = new Set([
  'userId',
  'username',
  'snoovatar',
  'myPlacement',
  'streak',
  'vehicles',
  'lastSpotHero',
]);

function hasUserSpecificField(payload: Record<string, unknown>): boolean {
  return Object.keys(payload).some((key) => USER_SPECIFIC_KEYS.has(key));
}

function hasContentHashKey(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => hasContentHashKey(item));
  for (const [key, child] of Object.entries(value)) {
    if (/sha256|md5|checksum|digest/i.test(key) || hasContentHashKey(child)) return true;
  }
  return false;
}

/**
 * Independent test-only exact recursive backtracking domino packer on <= 24 empty cells.
 * Branches on lowest-index remaining cell with memoization over 24-bit integer masks.
 */
function exactDominoPackingOracle(
  gridCols: number,
  gridRows: number,
  occupiedCells: Iterable<number>,
): number {
  const totalCells = gridCols * gridRows;
  const occupied = new Set<number>(occupiedCells);
  const emptyCells: number[] = [];
  const cellToEmptyIndex = new Map<number, number>();
  for (let cell = 0; cell < totalCells; cell += 1) {
    if (!occupied.has(cell)) {
      cellToEmptyIndex.set(cell, emptyCells.length);
      emptyCells.push(cell);
    }
  }
  const emptyCount = emptyCells.length;
  if (emptyCount < 2) return 0;
  if (emptyCount > 24) {
    throw new RangeError(`Exact oracle restricted to <= 24 empty cells, received ${emptyCount}`);
  }

  const neighborMasks = emptyCells.map((cell) => {
    const r = Math.floor(cell / gridCols);
    const c = cell % gridCols;
    let mask = 0;
    for (const [nr, nc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]] as const) {
      if (nr >= 0 && nr < gridRows && nc >= 0 && nc < gridCols) {
        const neighborIdx = cellToEmptyIndex.get(nr * gridCols + nc);
        if (neighborIdx !== undefined) mask |= 1 << neighborIdx;
      }
    }
    return mask;
  });

  const memo = new Map<number, number>();
  const solve = (remainingMask: number): number => {
    if (remainingMask === 0) return 0;
    const cached = memo.get(remainingMask);
    if (cached !== undefined) return cached;

    const lowestBit = remainingMask & -remainingMask;
    const firstIdx = Math.clz32(lowestBit) ^ 31;
    const restAfterSkip = remainingMask ^ lowestBit;
    let best = solve(restAfterSkip);

    let availNeighbors = (neighborMasks[firstIdx] ?? 0) & restAfterSkip;
    while (availNeighbors !== 0) {
      const nBit = availNeighbors & -availNeighbors;
      availNeighbors ^= nBit;
      const candidate = 1 + solve(restAfterSkip ^ nBit);
      if (candidate > best) best = candidate;
    }
    memo.set(remainingMask, best);
    return best;
  };

  return solve((1 << emptyCount) - 1);
}

function enumerateOraclePlacements(
  gridCols: number,
  gridRows: number,
  occupied: ReadonlySet<number>,
  vehicleType: VehicleType,
): number[][] {
  const result: number[][] = [];
  const length = vehicleType === 'sedan_2x1' ? 2 : 3;
  for (let r = 0; r < gridRows; r += 1) {
    for (let c = 0; c <= gridCols - length; c += 1) {
      const cells = Array.from({ length }, (_, k) => r * gridCols + c + k);
      if (cells.every((cell) => !occupied.has(cell))) result.push(cells);
    }
  }
  for (let r = 0; r <= gridRows - length; r += 1) {
    for (let c = 0; c < gridCols; c += 1) {
      const cells = Array.from({ length }, (_, k) => (r + k) * gridCols + c);
      if (cells.every((cell) => !occupied.has(cell))) result.push(cells);
    }
  }
  return result;
}

function computeOraclePlacementMetrics(
  gridCols: number,
  gridRows: number,
  occupied: ReadonlySet<number>,
  elevatorCell: number,
  vehicleType: VehicleType,
  cells: readonly number[],
): {
  readonly wastedStalls: number;
  readonly remainingAfter: number;
  readonly elevatorBonus: number;
  readonly stepScore: number;
} {
  const before = exactDominoPackingOracle(gridCols, gridRows, occupied);
  let minDelta = Number.POSITIVE_INFINITY;
  for (const move of enumerateOraclePlacements(gridCols, gridRows, occupied, vehicleType)) {
    const delta = before - exactDominoPackingOracle(gridCols, gridRows, [...occupied, ...move]);
    if (delta < minDelta) minDelta = delta;
  }
  const remainingAfter = exactDominoPackingOracle(gridCols, gridRows, [...occupied, ...cells]);
  const wastedStalls = before - remainingAfter - minDelta;

  const elevRow = Math.floor(elevatorCell / gridCols);
  const elevCol = elevatorCell % gridCols;
  let minDist = Number.POSITIVE_INFINITY;
  for (const cell of cells) {
    const d = Math.abs(Math.floor(cell / gridCols) - elevRow) + Math.abs((cell % gridCols) - elevCol);
    if (d < minDist) minDist = d;
  }
  const elevatorBonus = wastedStalls === 0 ? (gridRows - 1 + (gridCols - 1) + 1 - minDist) * 2 : 0;
  const stepScore = Math.max(0, 100 - wastedStalls * 45) + elevatorBonus;
  return { wastedStalls, remainingAfter, elevatorBonus, stepScore };
}

function checkInvariantP1(
  gridCols: number,
  gridRows: number,
  occupiedCells: ReadonlySet<number>,
  result: StandardStallCapacityResult,
): boolean {
  const totalCells = gridCols * gridRows;
  let emptyCount = 0;
  for (let c = 0; c < totalCells; c += 1) {
    if (!occupiedCells.has(c)) emptyCount += 1;
  }
  if (result.remainingStalls !== exactDominoPackingOracle(gridCols, gridRows, occupiedCells)) return false;
  if (result.ghostPairs.length !== result.remainingStalls) return false;

  const pairedCells = new Set<number>();
  for (const [u, v] of result.ghostPairs) {
    if (
      !Number.isSafeInteger(u) ||
      !Number.isSafeInteger(v) ||
      u < 0 ||
      u >= totalCells ||
      v < 0 ||
      v >= totalCells ||
      u === v ||
      occupiedCells.has(u) ||
      occupiedCells.has(v) ||
      pairedCells.has(u) ||
      pairedCells.has(v)
    ) {
      return false;
    }
    const manhattan =
      Math.abs(Math.floor(u / gridCols) - Math.floor(v / gridCols)) +
      Math.abs((u % gridCols) - (v % gridCols));
    if (manhattan !== 1) return false;
    pairedCells.add(u);
    pairedCells.add(v);
  }

  if (result.deadSpots.length !== emptyCount - 2 * result.remainingStalls) return false;
  const deadSet = new Set<number>();
  for (const spot of result.deadSpots) {
    if (
      !Number.isSafeInteger(spot) ||
      spot < 0 ||
      spot >= totalCells ||
      occupiedCells.has(spot) ||
      pairedCells.has(spot) ||
      deadSet.has(spot)
    ) {
      return false;
    }
    deadSet.add(spot);
  }
  return pairedCells.size + deadSet.size === emptyCount;
}

function checkInvariantP2(
  vehicleType: VehicleType,
  evaluations: ReadonlyArray<Pick<PlacementEvaluation, 'wastedStalls' | 'elevatorBonus' | 'stepScore'>>,
  options: { readonly requirePositiveWasteChoice?: boolean; readonly requireFullVanSpread?: boolean } = {},
): boolean {
  if (evaluations.length === 0) return false;
  const maxAllowedWaste = vehicleType === 'sedan_2x1' ? 1 : 2;
  let sawZeroWaste = false;
  const distinctWaste = new Set<number>();

  for (const ev of evaluations) {
    if (!Number.isSafeInteger(ev.wastedStalls) || ev.wastedStalls < 0 || ev.wastedStalls > maxAllowedWaste) {
      return false;
    }
    distinctWaste.add(ev.wastedStalls);
    if (ev.wastedStalls === 0) {
      sawZeroWaste = true;
      if (!Number.isSafeInteger(ev.elevatorBonus) || ev.elevatorBonus <= 0) return false;
    } else if (ev.elevatorBonus !== 0) {
      return false;
    }
    if (ev.stepScore !== Math.max(0, 100 - ev.wastedStalls * 45) + ev.elevatorBonus) return false;
  }

  if (!sawZeroWaste) return false;
  if (options.requirePositiveWasteChoice === true && distinctWaste.size < 2) return false;
  if (
    options.requireFullVanSpread === true &&
    (!distinctWaste.has(0) || !distinctWaste.has(1) || !distinctWaste.has(2))
  ) {
    return false;
  }
  return true;
}

function checkInvariantP3(
  gridCols: number,
  gridRows: number,
  floors: ReadonlyArray<StoredFloorRecord>,
  placementsMap: Readonly<Record<string, PlacementReceipt>>,
  lbScores: ReadonlyMap<string, number>,
): boolean {
  const seenUsersAcrossFloors = new Set<string>();
  const totalCells = gridCols * gridRows;

  for (const floor of floors) {
    const runningOccupied = new Set<number>();
    for (const obs of floor.obstacles) {
      if (obs.cell < 0 || obs.cell >= totalCells || runningOccupied.has(obs.cell)) return false;
      runningOccupied.add(obs.cell);
    }

    for (const vehicle of floor.vehicles) {
      if (seenUsersAcrossFloors.has(vehicle.userId)) return false;
      seenUsersAcrossFloors.add(vehicle.userId);
      const receipt = placementsMap[vehicle.userId];
      if (receipt === undefined) return false;

      if (totalCells - runningOccupied.size <= 24) {
        const oracle = computeOraclePlacementMetrics(
          gridCols,
          gridRows,
          runningOccupied,
          floor.elevatorCell,
          vehicle.vehicleType,
          vehicle.cells,
        );
        if (
          vehicle.wastedStalls !== oracle.wastedStalls ||
          receipt.wastedStalls !== oracle.wastedStalls ||
          receipt.elevatorBonus !== oracle.elevatorBonus ||
          receipt.stepScore !== oracle.stepScore ||
          receipt.totalShiftScore !== oracle.stepScore
        ) {
          return false;
        }
      }

      if (lbScores.get(vehicle.userId) !== receipt.totalShiftScore) return false;
      for (const cell of vehicle.cells) {
        if (cell < 0 || cell >= totalCells || runningOccupied.has(cell)) return false;
        runningOccupied.add(cell);
      }
    }
  }

  const placementUserIds = Object.keys(placementsMap);
  if (placementUserIds.length !== seenUsersAcrossFloors.size || lbScores.size !== seenUsersAcrossFloors.size) {
    return false;
  }
  return placementUserIds.every((uid) => seenUsersAcrossFloors.has(uid));
}

function checkInvariantP4(
  gridCols: number,
  gridRows: number,
  activeFloor: number,
  floorCount: number,
  floors: ReadonlyArray<StoredFloorRecord>,
  maxFloors: number = 50,
): boolean {
  if (floors.length !== floorCount || activeFloor < 1 || activeFloor > floorCount) return false;

  for (const floor of floors) {
    const occupied = new Set<number>([
      ...floor.obstacles.map((o) => o.cell),
      ...floor.vehicles.flatMap((v) => v.cells),
    ]);
    const cap = computeStandardStallCapacity(gridCols, gridRows, occupied);
    if (floor.remainingStalls !== cap.remainingStalls) return false;

    if (cap.remainingStalls === 0) {
      const lastVehicle = floor.vehicles[floor.vehicles.length - 1];
      if (floor.status !== 'ARCHIVED' || lastVehicle === undefined || floor.lastSpotHero !== lastVehicle.userId) {
        return false;
      }
      if (floor.floorNumber < maxFloors) {
        const nextFloor = floors.find((f) => f.floorNumber === floor.floorNumber + 1);
        if (nextFloor === undefined) return false;
        const nextCap = computeStandardStallCapacity(
          gridCols,
          gridRows,
          nextFloor.obstacles.map((o) => o.cell),
        );
        if (nextCap.remainingStalls < 6) return false;
      }
    } else if (floor.floorNumber === activeFloor && (floor.status !== 'LIVE' || floor.lastSpotHero !== null)) {
      return false;
    }
  }
  return true;
}

function checkInvariantP5(params: {
  readonly currentRevision: number;
  readonly persistedPlacementCount: number;
  readonly txnGetCalls: number;
  readonly expectedSlotCleanups: number;
  readonly actualSlotCleanups: number;
}): boolean {
  return (
    params.currentRevision === params.persistedPlacementCount &&
    params.txnGetCalls === 0 &&
    params.actualSlotCleanups >= params.expectedSlotCleanups
  );
}

function buildPostContext(
  baseHeaders: Record<string, string | undefined>,
  options: {
    postId: `t3_${string}`;
    userId?: `t2_${string}` | null;
    username?: string | null;
    snoovatar?: string | null;
    postData?: Record<string, unknown>;
  },
) {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseHeaders)) {
    if (v !== undefined) merged[k] = v;
  }
  merged[Header.Post] = options.postId;

  if (options.userId === null) {
    delete merged[Header.User];
    delete merged[Header.Username];
    delete merged[Header.AppUser];
    delete merged[Header.UserSnoovatarUrl];
  } else {
    if (options.userId !== undefined) merged[Header.User] = options.userId;
    if (options.username !== undefined && options.username !== null) merged[Header.Username] = options.username;
    if (options.snoovatar !== undefined && options.snoovatar !== null) {
      merged[Header.UserSnoovatarUrl] = options.snoovatar;
    }
  }
  if (options.postData !== undefined) {
    merged[Header.PostData] = JSON.stringify({ developerData: options.postData });
  }
  return Context(merged);
}

function getInContext(
  ctx: ReturnType<typeof Context>,
  targetApp: ReturnType<typeof createApp>,
  path: string,
): Promise<Response> {
  return devvitRunWithContext(ctx, async () => await targetApp.request(path));
}

function postParkInContext(
  ctx: ReturnType<typeof Context>,
  targetApp: ReturnType<typeof createApp>,
  payload: unknown,
): Promise<Response> {
  return devvitRunWithContext(ctx, async () => {
    return await targetApp.request(API_ENDPOINTS.park, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  });
}

const devvitTest = createDevvitTest({
  username: 'driver_one',
  userId: 't2_driver1',
  subredditName: 'lastspot_test_sub',
  subredditId: 't5_lastspottest',
});

describe('Ticket 02 — Role 1: Concrete Seam 1 Capabilities (Valet Shift & Optimistic Park API)', () => {
  devvitTest(
    'GET /api/lot-state lazily and idempotently materializes Floor 1, Warm-Up Bays 1-2, Live Floor vehicle, and OFFICIAL_LIVE vs VISITOR_HOLD viewerMode',
    async ({ headers }) => {
      const wrapper = createConflictAwareRedisWrapper(redis);
      const testApp = createApp({ redisClient: wrapper.client });
      const postId = 't3_lazy_seed_post';

      const officialCtx = buildPostContext(headers, {
        postId,
        userId: 't2_driver1',
        username: 'driver_one',
        postData: { schemaVersion: 1, puzzleDate: '2026-11-18', seed: 'seed-alpha-01', gridCols: 6, gridRows: 6 },
      });

      const firstRes = await getInContext(officialCtx, testApp, API_ENDPOINTS.lotState);
      expect(firstRes.status).toBe(200);
      const firstBody = (await firstRes.json()) as LotStateResponse;

      expect(firstBody.ok).toBe(true);
      expect(firstBody.postId).toBe(postId);
      expect(firstBody.viewerMode).toBe('OFFICIAL_LIVE');
      expect(firstBody.revision).toBe(0);
      expect(firstBody.activeFloor).toBe(1);
      expect(firstBody.floorCount).toBe(1);
      expect(firstBody.myPlacement).toBeNull();
      expect(firstBody.streak).toEqual({
        currentStreak: 0,
        bestStreak: 0,
        totalShifts: 0,
        lastPlayedPuzzleDate: null,
      });

      expect(firstBody.warmUpBays).toHaveLength(2);
      expect(firstBody.warmUpBays[0].bayNumber).toBe(1);
      expect(firstBody.warmUpBays[0].assignedVehicle).toBe('sedan_2x1');
      expect(firstBody.warmUpBays[0].remainingStalls).toBeGreaterThanOrEqual(6);
      expect(firstBody.warmUpBays[0].remainingStalls).toBeLessThanOrEqual(10);

      expect(firstBody.warmUpBays[1].bayNumber).toBe(2);
      expect(firstBody.warmUpBays[1].assignedVehicle).toBe('van_3x1');
      expect(firstBody.warmUpBays[1].remainingStalls).toBeGreaterThanOrEqual(6);
      expect(firstBody.warmUpBays[1].remainingStalls).toBeLessThanOrEqual(10);

      expect(firstBody.liveFloor.floorNumber).toBe(1);
      expect(firstBody.liveFloor.status).toBe('LIVE');
      expect(firstBody.liveFloor.lastSpotHero).toBeNull();
      expect(isPerimeterCell(6, 6, firstBody.liveFloor.elevatorCell)).toBe(true);
      expect(firstBody.liveFloor.remainingStalls).toBeGreaterThanOrEqual(6);
      expect(firstBody.liveFloor.remainingStalls).toBeLessThanOrEqual(10);
      expect(['sedan_2x1', 'van_3x1']).toContain(firstBody.assignedVehicle);

      wrapper.clearRecordedWrites();
      const visitorCtx = buildPostContext(headers, { postId, userId: null });
      const visitorRes = await getInContext(visitorCtx, testApp, API_ENDPOINTS.lotState);
      expect(visitorRes.status).toBe(200);
      const visitorBody = (await visitorRes.json()) as LotStateResponse;
      expect(visitorBody.viewerMode).toBe('VISITOR_HOLD');
      expect(visitorBody.liveFloor.obstacles).toEqual(firstBody.liveFloor.obstacles);
      expect(wrapper.writtenKeys).toEqual([]);
    },
  );

  devvitTest(
    'GET /api/lot-summary serves a 5-second TTL non-personalized cache without leaking user-specific fields',
    async ({ headers }) => {
      expect(hasUserSpecificField({ ok: true, userId: 't2_x' })).toBe(true);
      expect(hasUserSpecificField({ ok: true, postId: 't3_x' })).toBe(false);

      let clockMs = 1_700_000_000_000;
      const wrapper = createConflictAwareRedisWrapper(redis);
      const testApp = createApp({ redisClient: wrapper.client, nowMs: () => clockMs });
      const postId = 't3_summary_cache_post';

      const user1Ctx = buildPostContext(headers, {
        postId,
        userId: 't2_driver1',
        username: 'driver_one',
        snoovatar: 'https://example.test/avatar1.png',
        postData: { schemaVersion: 1, puzzleDate: '2026-11-18', seed: 'seed-summary-01' },
      });

      const initialState = (await (await getInContext(user1Ctx, testApp, API_ENDPOINTS.lotState)).json()) as LotStateResponse;
      const summary1Res = await getInContext(user1Ctx, testApp, API_ENDPOINTS.lotSummary);
      expect(summary1Res.status).toBe(200);
      const summary1 = (await summary1Res.json()) as LotSummaryResponse & Record<string, unknown>;
      expect(summary1.ok).toBe(true);
      expect(summary1.postId).toBe(postId);
      expect(summary1.activeFloor).toBe(1);
      expect(summary1.floorCount).toBe(1);
      expect(summary1.totalCells).toBe(36);
      expect(summary1.remainingStalls).toBe(initialState.liveFloor.remainingStalls);
      expect(summary1.status).toBe('LIVE');
      expect(hasUserSpecificField(summary1)).toBe(false);

      const occupiedSet = new Set(initialState.liveFloor.obstacles.map((o) => o.cell));
      const validSedan = enumerateOraclePlacements(6, 6, occupiedSet, 'sedan_2x1')[0]!;
      const oracleEval = computeOraclePlacementMetrics(
        6,
        6,
        occupiedSet,
        initialState.liveFloor.elevatorCell,
        'sedan_2x1',
        validSedan,
      );

      const parkRes = await postParkInContext(user1Ctx, testApp, {
        floorNumber: 1,
        expectedRevision: initialState.revision,
        vehicleType: 'sedan_2x1',
        cells: validSedan,
        clientPreview: { wastedStalls: oracleEval.wastedStalls, remainingStallsAfter: oracleEval.remainingAfter },
      });
      expect(parkRes.status).toBe(200);

      clockMs += 3_000;
      const readsBeforeCachedHit = wrapper.telemetry.topLevelReadCalls;
      const visitorCtx = buildPostContext(headers, { postId, userId: null });
      const cachedRes = await getInContext(visitorCtx, testApp, API_ENDPOINTS.lotSummary);
      expect(cachedRes.status).toBe(200);
      const cachedSummary = (await cachedRes.json()) as LotSummaryResponse & Record<string, unknown>;
      expect(cachedSummary.remainingStalls).toBe(initialState.liveFloor.remainingStalls);
      expect(wrapper.telemetry.topLevelReadCalls).toBe(readsBeforeCachedHit);
      expect(hasUserSpecificField(cachedSummary)).toBe(false);

      clockMs += 2_500;
      const refreshedRes = await getInContext(visitorCtx, testApp, API_ENDPOINTS.lotSummary);
      expect(refreshedRes.status).toBe(200);
      const refreshedSummary = (await refreshedRes.json()) as LotSummaryResponse & Record<string, unknown>;
      expect(refreshedSummary.remainingStalls).toBe(oracleEval.remainingAfter);
      expect(refreshedSummary.occupiedCells.length).toBe(summary1.occupiedCells.length + 2);
      expect(hasUserSpecificField(refreshedSummary)).toBe(false);
    },
  );

  devvitTest(
    'POST /api/park rejects logged-out requests with 401 LOGIN_REQUIRED_FOR_OFFICIAL_SPOT and malformed/non-collinear/out-of-bounds payloads with 400',
    async ({ headers }) => {
      const wrapper = createConflictAwareRedisWrapper(redis);
      const testApp = createApp({ redisClient: wrapper.client });
      const postId = 't3_validation_post';

      const authedCtx = buildPostContext(headers, {
        postId,
        userId: 't2_driver1',
        username: 'driver_one',
        postData: { puzzleDate: '2026-11-18', seed: 'seed-valid-01' },
      });
      await getInContext(authedCtx, testApp, API_ENDPOINTS.lotState);
      wrapper.clearRecordedWrites();

      const visitorCtx = buildPostContext(headers, { postId, userId: null });
      const unauthedRes = await postParkInContext(visitorCtx, testApp, {
        floorNumber: 1,
        expectedRevision: 0,
        vehicleType: 'sedan_2x1',
        cells: [0, 1],
        clientPreview: { wastedStalls: 0, remainingStallsAfter: 5 },
      });
      expect(unauthedRes.status).toBe(401);
      expect(await unauthedRes.json()).toEqual({
        ok: false,
        code: ERROR_CODES.loginRequiredForOfficialSpot,
      });
      expect(wrapper.writtenKeys).toEqual([]);

      const invalidPayloads: unknown[] = [
        { floorNumber: 1, expectedRevision: 0, vehicleType: 'sedan_2x1', cells: [35, 36], clientPreview: { wastedStalls: 0, remainingStallsAfter: 5 } },
        { floorNumber: 1, expectedRevision: 0, vehicleType: 'sedan_2x1', cells: [5, 6], clientPreview: { wastedStalls: 0, remainingStallsAfter: 5 } },
        { floorNumber: 1, expectedRevision: 0, vehicleType: 'van_3x1', cells: [0, 1, 7], clientPreview: { wastedStalls: 0, remainingStallsAfter: 5 } },
        { floorNumber: 1, expectedRevision: 0, vehicleType: 'van_3x1', cells: [0, 1], clientPreview: { wastedStalls: 0, remainingStallsAfter: 5 } },
      ];

      for (const badBody of invalidPayloads) {
        const badRes = await postParkInContext(authedCtx, testApp, badBody);
        expect(badRes.status).toBe(400);
      }
      expect(wrapper.writtenKeys).toEqual([]);
    },
  );

  devvitTest(
    'POST /api/park commits authoritatively (ignoring tampered client scores, persisting context snoovatar/username with zero content hashes) and returns idempotent alreadyCommitted: true on replay',
    async ({ headers }) => {
      expect(hasContentHashKey({ sha256: 'abc' })).toBe(true);
      expect(hasContentHashKey({ revision: 1 })).toBe(false);

      const wrapper = createConflictAwareRedisWrapper(redis);
      const testApp = createApp({ redisClient: wrapper.client });
      const postId = 't3_commit_idempotent_post';

      const driverCtx = buildPostContext(headers, {
        postId,
        userId: 't2_driver1',
        username: 'valet_ace',
        snoovatar: 'https://i.redd.it/snoovatar/avatars/valet_ace.png',
        postData: { puzzleDate: '2026-11-18', seed: 'seed-commit-01' },
      });

      const lotState = (await (await getInContext(driverCtx, testApp, API_ENDPOINTS.lotState)).json()) as LotStateResponse;
      const occupied = new Set(lotState.liveFloor.obstacles.map((o) => o.cell));
      const moves = enumerateOraclePlacements(6, 6, occupied, 'sedan_2x1');
      const chosenMove =
        moves.find(
          (m) =>
            computeOraclePlacementMetrics(6, 6, occupied, lotState.liveFloor.elevatorCell, 'sedan_2x1', m)
              .wastedStalls === 1,
        ) ?? moves[0]!;
      const expectedOracle = computeOraclePlacementMetrics(
        6,
        6,
        occupied,
        lotState.liveFloor.elevatorCell,
        'sedan_2x1',
        chosenMove,
      );

      const commitRes = await postParkInContext(driverCtx, testApp, {
        floorNumber: 1,
        expectedRevision: 0,
        vehicleType: 'sedan_2x1',
        cells: chosenMove,
        warmUpScores: [999_999, 888_888],
        stepScore: 777_777,
        totalScore: 999_999,
        totalShiftScore: 999_999,
        score: 999_999,
        clientPreview: { wastedStalls: 0, remainingStallsAfter: 99 },
      });
      expect(commitRes.status).toBe(200);
      const commitBody = (await commitRes.json()) as {
        ok: true;
        alreadyCommitted: boolean;
        receipt: PlacementReceipt;
      };
      expect(commitBody.ok).toBe(true);
      expect(commitBody.alreadyCommitted).toBe(false);
      expect(commitBody.receipt.revision).toBe(1);
      expect(commitBody.receipt.username).toBe('valet_ace');
      expect(commitBody.receipt.snoovatar).toBe('https://i.redd.it/snoovatar/avatars/valet_ace.png');
      expect(commitBody.receipt.wastedStalls).toBe(expectedOracle.wastedStalls);
      expect(commitBody.receipt.remainingStallsAfter).toBe(expectedOracle.remainingAfter);
      expect(commitBody.receipt.stepScore).toBe(expectedOracle.stepScore);
      expect(commitBody.receipt.totalShiftScore).toBe(expectedOracle.stepScore);
      expect(hasContentHashKey(commitBody)).toBe(false);

      const [metaKey, , , lbKey] = buildPostScopedLotKeys(postId);
      expect(await redis.zScore(lbKey, 't2_driver1')).toBe(commitBody.receipt.totalShiftScore);
      const metaRaw = await redis.hGetAll(metaKey);
      expect(metaRaw.revision).toBe('1');
      expect(hasContentHashKey(metaRaw)).toBe(false);

      const watchesBeforeReplay = wrapper.telemetry.watchCalls;
      const replayRes = await postParkInContext(driverCtx, testApp, {
        floorNumber: 1,
        expectedRevision: 0,
        vehicleType: 'sedan_2x1',
        cells: chosenMove,
        clientPreview: { wastedStalls: 0, remainingStallsAfter: 5 },
      });
      expect(replayRes.status).toBe(200);
      const replayBody = (await replayRes.json()) as {
        ok: true;
        alreadyCommitted: boolean;
        receipt: PlacementReceipt;
      };
      expect(replayBody.alreadyCommitted).toBe(true);
      expect(replayBody.receipt).toEqual(commitBody.receipt);
      expect(wrapper.telemetry.watchCalls).toBe(watchesBeforeReplay);
      expect((await redis.hGetAll(metaKey)).revision).toBe('1');
    },
  );

  devvitTest(
    'POST /api/park returns 409 SPOT_TAKEN immediately without retry when cells are taken and 409 LOT_UPDATED_RETRY_PREVIEW without consuming turn when revision advances and degrades wastedStalls',
    async ({ headers }) => {
      const wrapper = createConflictAwareRedisWrapper(redis);
      const testApp = createApp({ redisClient: wrapper.client, retryDelayMs: () => 0 });
      const postId = 't3_race_conflict_post';

      const allowedEmpty = new Set([0, 1, 2, 3, 4, 10, 18, 19, 21, 22, 30, 31]);
      const obstacles = Array.from({ length: 36 }, (_, cell) => cell)
        .filter((cell) => !allowedEmpty.has(cell))
        .map((cell) => ({ cell, kind: 'pillar' as const }));

      const [metaKey, floorsKey, placementsKey] = buildPostScopedLotKeys(postId);
      await redis.hSet(metaKey, {
        schemaVersion: '1',
        puzzleDate: '2026-11-18',
        seed: 'seed-race-01',
        gridCols: '6',
        gridRows: '6',
        activeFloor: '1',
        floorCount: '1',
        revision: '0',
      });
      await redis.hSet(floorsKey, {
        '1': JSON.stringify({
          floorNumber: 1,
          seed: 'seed-race-01:floor:1',
          elevatorCell: 0,
          obstacles,
          vehicles: [],
          remainingStalls: 6,
          status: 'LIVE',
          lastSpotHero: null,
        }),
      });

      const user1Ctx = buildPostContext(headers, { postId, userId: 't2_user1', username: 'user_one' });
      const u1Res = await postParkInContext(user1Ctx, testApp, {
        floorNumber: 1,
        expectedRevision: 0,
        vehicleType: 'sedan_2x1',
        cells: [4, 10],
        clientPreview: { wastedStalls: 0, remainingStallsAfter: 5 },
      });
      expect(u1Res.status).toBe(200);

      const user2Ctx = buildPostContext(headers, { postId, userId: 't2_user2', username: 'user_two' });
      const watchesBeforeTaken = wrapper.telemetry.watchCalls;
      const spotTakenRes = await postParkInContext(user2Ctx, testApp, {
        floorNumber: 1,
        expectedRevision: 0,
        vehicleType: 'sedan_2x1',
        cells: [4, 10],
        clientPreview: { wastedStalls: 0, remainingStallsAfter: 5 },
      });
      expect(spotTakenRes.status).toBe(409);
      const spotTakenBody = (await spotTakenRes.json()) as {
        ok: false;
        code: string;
        latestLotState: LotStateResponse;
      };
      expect(spotTakenBody.code).toBe(ERROR_CODES.spotTaken);
      expect(spotTakenBody.latestLotState.revision).toBe(1);
      expect(wrapper.telemetry.watchCalls).toBe(watchesBeforeTaken + 1);

      const degradedRes = await postParkInContext(user2Ctx, testApp, {
        floorNumber: 1,
        expectedRevision: 0,
        vehicleType: 'sedan_2x1',
        cells: [1, 2],
        clientPreview: { wastedStalls: 0, remainingStallsAfter: 5 },
      });
      expect(degradedRes.status).toBe(409);
      const degradedBody = (await degradedRes.json()) as {
        ok: false;
        code: string;
        latestLotState: LotStateResponse;
      };
      expect(degradedBody.code).toBe(ERROR_CODES.lotUpdatedRetryPreview);
      expect(degradedBody.latestLotState.revision).toBe(1);
      expect(await redis.hGet(placementsKey, 't2_user2')).toBeUndefined();

      const retrySuccessRes = await postParkInContext(user2Ctx, testApp, {
        floorNumber: 1,
        expectedRevision: 1,
        vehicleType: 'sedan_2x1',
        cells: [0, 1],
        clientPreview: { wastedStalls: 0, remainingStallsAfter: 4 },
      });
      expect(retrySuccessRes.status).toBe(200);
    },
  );

  devvitTest(
    'crowns lastSpotHero, seals B1 as ARCHIVED, atomically opens B2 with >= 6 stalls when remainingStalls hits 0, and deduplicates streaks across posts on the same puzzleDate',
    async ({ headers }) => {
      const wrapper = createConflictAwareRedisWrapper(redis);
      const testApp = createApp({ redisClient: wrapper.client });
      const postA = 't3_overflow_post_a';
      const postB = 't3_streak_post_b';
      const postNextDay = 't3_streak_post_c';

      const baseCtxA = buildPostContext(headers, {
        postId: postA,
        userId: 't2_driver0',
        username: 'driver_0',
        postData: { puzzleDate: '2026-11-18', seed: 'seed-hero-01' },
      });

      let currentState = (await (await getInContext(baseCtxA, testApp, API_ENDPOINTS.lotState)).json()) as LotStateResponse;
      let stepIndex = 0;
      let heroUserId = '';
      while (currentState.activeFloor === 1 && stepIndex < 15) {
        const uid = `t2_hero_${stepIndex}` as const;
        const playerCtx = buildPostContext(headers, { postId: postA, userId: uid, username: `hero_${stepIndex}` });
        const occupied = new Set<number>(currentState.liveFloor.occupiedCells);
        const moves = enumerateOraclePlacements(6, 6, occupied, 'sedan_2x1');
        expect(moves.length).toBeGreaterThan(0);
        const chosen = moves[0]!;
        const preview = computeOraclePlacementMetrics(
          6,
          6,
          occupied,
          currentState.liveFloor.elevatorCell,
          'sedan_2x1',
          chosen,
        );

        const parkRes = await postParkInContext(playerCtx, testApp, {
          floorNumber: 1,
          expectedRevision: currentState.revision,
          vehicleType: 'sedan_2x1',
          cells: chosen,
          clientPreview: { wastedStalls: preview.wastedStalls, remainingStallsAfter: preview.remainingAfter },
        });
        expect(parkRes.status).toBe(200);
        heroUserId = uid;

        currentState = (await (await getInContext(playerCtx, testApp, API_ENDPOINTS.lotState)).json()) as LotStateResponse;
        stepIndex += 1;
      }

      expect(currentState.activeFloor).toBe(2);
      expect(currentState.floorCount).toBe(2);
      expect(currentState.liveFloor.floorNumber).toBe(2);
      expect(currentState.liveFloor.status).toBe('LIVE');
      expect(currentState.liveFloor.remainingStalls).toBeGreaterThanOrEqual(6);

      const floor1Res = await getInContext(baseCtxA, testApp, `${API_ENDPOINTS.lotState}?floor=1`);
      expect(floor1Res.status).toBe(200);
      const floor1State = (await floor1Res.json()) as LotStateResponse;
      expect(floor1State.requestedFloor.floorNumber).toBe(1);
      expect(floor1State.requestedFloor.status).toBe('ARCHIVED');
      expect(floor1State.requestedFloor.remainingStalls).toBe(0);
      expect(floor1State.requestedFloor.lastSpotHero).toBe(heroUserId);

      const sameDayCtxB = buildPostContext(headers, {
        postId: postB,
        userId: heroUserId as `t2_${string}`,
        username: 'streak_tester',
        postData: { puzzleDate: '2026-11-18', seed: 'seed-post-b' },
      });
      const stateB = (await (await getInContext(sameDayCtxB, testApp, API_ENDPOINTS.lotState)).json()) as LotStateResponse;
      expect(stateB.streak.currentStreak).toBe(1);

      const moveB = enumerateOraclePlacements(6, 6, new Set(stateB.liveFloor.occupiedCells), 'sedan_2x1')[0]!;
      const parkBRes = await postParkInContext(sameDayCtxB, testApp, {
        floorNumber: 1,
        expectedRevision: 0,
        vehicleType: 'sedan_2x1',
        cells: moveB,
        clientPreview: { wastedStalls: 1, remainingStallsAfter: 5 },
      });
      expect(parkBRes.status).toBe(200);
      const parkBBody = (await parkBRes.json()) as { receipt: PlacementReceipt };
      expect(parkBBody.receipt.streak).toEqual({
        currentStreak: 1,
        bestStreak: 1,
        totalShifts: 2,
        lastPlayedPuzzleDate: '2026-11-18',
      });

      const nextDayCtxC = buildPostContext(headers, {
        postId: postNextDay,
        userId: heroUserId as `t2_${string}`,
        username: 'streak_tester',
        postData: { puzzleDate: '2026-11-19', seed: 'seed-post-c' },
      });
      const stateC = (await (await getInContext(nextDayCtxC, testApp, API_ENDPOINTS.lotState)).json()) as LotStateResponse;
      const moveC = enumerateOraclePlacements(6, 6, new Set(stateC.liveFloor.occupiedCells), 'sedan_2x1')[0]!;
      const parkCRes = await postParkInContext(nextDayCtxC, testApp, {
        floorNumber: 1,
        expectedRevision: 0,
        vehicleType: 'sedan_2x1',
        cells: moveC,
        clientPreview: { wastedStalls: 1, remainingStallsAfter: 5 },
      });
      expect(parkCRes.status).toBe(200);
      const parkCBody = (await parkCRes.json()) as { receipt: PlacementReceipt };
      expect(parkCBody.receipt.streak).toEqual({
        currentStreak: 2,
        bestStreak: 2,
        totalShifts: 3,
        lastPlayedPuzzleDate: '2026-11-19',
      });
    },
  );
});

describe('Ticket 02 — Role 2: Safety Property Guardians (fast-check P1..P5)', () => {
  it('P1 (Standard Stall Capacity & Dead Spot Exactness): matches exact backtracking domino oracle on 6x6 grids with <= 24 empty cells', () => {
    const occupied6x6Arb = fc
      .shuffledSubarray(Array.from({ length: 36 }, (_, idx) => idx), { minLength: 12, maxLength: 36 })
      .map((cells) => new Set<number>(cells));

    fc.assert(
      fc.property(occupied6x6Arb, (occupiedSet) => {
        return checkInvariantP1(6, 6, occupiedSet, computeStandardStallCapacity(6, 6, occupiedSet));
      }),
      { numRuns: 100 },
    );
  });

  it('P2 (Wasted Stalls Bounds & Zero-Waste Existence): holds across generated Warm-Up Bays and seeded 6x6/7x6 Live Floors', () => {
    const seedAndFloorArb = fc.record({
      seed: fc.string({ minLength: 1, maxLength: 32 }),
      floorNumber: fc.integer({ min: 1, max: 50 }),
      gridCols: fc.constantFrom(6, 7),
    });

    fc.assert(
      fc.property(seedAndFloorArb, ({ seed, floorNumber, gridCols }) => {
        const [bay1, bay2] = generateWarmUpBays(seed);
        if (
          bay1.remainingStalls < 6 ||
          bay1.remainingStalls > 10 ||
          bay2.remainingStalls < 6 ||
          bay2.remainingStalls > 10
        ) {
          return false;
        }

        const bay1Occ = bay1.obstacles.map((o) => o.cell);
        const bay1OccSet = new Set(bay1Occ);
        const bay1Evals = listValidPlacements(6, 6, bay1Occ, 'sedan_2x1').map((cells) => {
          const prod = evaluatePlacement(6, 6, bay1Occ, bay1.elevatorCell, 'sedan_2x1', cells);
          const oracle = computeOraclePlacementMetrics(6, 6, bay1OccSet, bay1.elevatorCell, 'sedan_2x1', cells);
          if (prod.wastedStalls !== oracle.wastedStalls || prod.stepScore !== oracle.stepScore) {
            throw new Error('P2 oracle mismatch on Warm-Up Bay 1');
          }
          return prod;
        });
        if (!checkInvariantP2('sedan_2x1', bay1Evals, { requirePositiveWasteChoice: true })) return false;

        const bay2Occ = bay2.obstacles.map((o) => o.cell);
        const bay2OccSet = new Set(bay2Occ);
        const bay2Evals = listValidPlacements(6, 6, bay2Occ, 'van_3x1').map((cells) => {
          const prod = evaluatePlacement(6, 6, bay2Occ, bay2.elevatorCell, 'van_3x1', cells);
          const oracle = computeOraclePlacementMetrics(6, 6, bay2OccSet, bay2.elevatorCell, 'van_3x1', cells);
          if (prod.wastedStalls !== oracle.wastedStalls || prod.stepScore !== oracle.stepScore) {
            throw new Error('P2 oracle mismatch on Warm-Up Bay 2');
          }
          return prod;
        });
        if (
          !checkInvariantP2('van_3x1', bay2Evals, {
            requirePositiveWasteChoice: true,
            requireFullVanSpread: true,
          })
        ) {
          return false;
        }

        const seededFloor = generateSeededFloor(seed, floorNumber, { gridCols, gridRows: 6 });
        if (
          seededFloor.remainingStalls < 6 ||
          seededFloor.remainingStalls > 10 ||
          !isPerimeterCell(gridCols, 6, seededFloor.elevatorCell)
        ) {
          return false;
        }

        const liveOcc = seededFloor.obstacles.map((o) => o.cell);
        const liveSedanEvals = listValidPlacements(gridCols, 6, liveOcc, 'sedan_2x1').map((cells) =>
          evaluatePlacement(gridCols, 6, liveOcc, seededFloor.elevatorCell, 'sedan_2x1', cells),
        );
        if (!checkInvariantP2('sedan_2x1', liveSedanEvals, { requirePositiveWasteChoice: true })) return false;

        const liveVanPlacements = listValidPlacements(gridCols, 6, liveOcc, 'van_3x1');
        if (liveVanPlacements.length > 0) {
          const liveVanEvals = liveVanPlacements.map((cells) =>
            evaluatePlacement(gridCols, 6, liveOcc, seededFloor.elevatorCell, 'van_3x1', cells),
          );
          if (!checkInvariantP2('van_3x1', liveVanEvals)) return false;
        }
        return true;
      }),
      { numRuns: 60 },
    );
  });

  devvitTest(
    'P3, P4, and P5 hold step-by-step across multi-player POST /api/park sequences with fault injection, tampering, and concurrent interleavings',
    async ({ headers }) => {
      type ActionSpec =
        | {
            readonly kind: 'valid_commit';
            readonly playerIdx: number;
            readonly preferVan: boolean;
            readonly moveSelector: number;
            readonly tamperScores: boolean;
            readonly transientFault: 'none' | 'empty_reply' | 'throw_error';
          }
        | { readonly kind: 'exhaust_conflict_abort'; readonly playerIdx: number }
        | { readonly kind: 'overlapping_spot_taken'; readonly playerIdx: number }
        | { readonly kind: 'invalid_cells'; readonly playerIdx: number }
        | { readonly kind: 'duplicate_replay'; readonly playerIdx: number }
        | { readonly kind: 'concurrent_pair'; readonly playerA: number; readonly playerB: number; readonly sameCells: boolean };

      const actionArb: fc.Arbitrary<ActionSpec> = fc.oneof(
        fc.record({
          kind: fc.constant('valid_commit' as const),
          playerIdx: fc.integer({ min: 0, max: 11 }),
          preferVan: fc.boolean(),
          moveSelector: fc.integer({ min: 0, max: 20 }),
          tamperScores: fc.boolean(),
          transientFault: fc.constantFrom('none' as const, 'empty_reply' as const, 'throw_error' as const),
        }),
        fc.record({ kind: fc.constant('exhaust_conflict_abort' as const), playerIdx: fc.integer({ min: 0, max: 11 }) }),
        fc.record({ kind: fc.constant('overlapping_spot_taken' as const), playerIdx: fc.integer({ min: 0, max: 11 }) }),
        fc.record({ kind: fc.constant('invalid_cells' as const), playerIdx: fc.integer({ min: 0, max: 11 }) }),
        fc.record({ kind: fc.constant('duplicate_replay' as const), playerIdx: fc.integer({ min: 0, max: 11 }) }),
        fc.record({
          kind: fc.constant('concurrent_pair' as const),
          playerA: fc.integer({ min: 0, max: 5 }),
          playerB: fc.integer({ min: 6, max: 11 }),
          sameCells: fc.boolean(),
        }),
      );

      const scenarioArb = fc.record({
        seedLabel: fc.stringOf(fc.constantFrom('a', 'b', 'c', 'd', '1', '2', '3'), { minLength: 3, maxLength: 10 }),
        gridCols: fc.constantFrom(6, 7),
        actions: fc.array(actionArb, { minLength: 5, maxLength: 10 }),
      });

      let runCounter = 0;
      let totalAppliedCommits = 0;
      let totalBlockedActions = 0;
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      try {
        await fc.assert(
          fc.asyncProperty(scenarioArb, async ({ seedLabel, gridCols, actions }) => {
            runCounter += 1;
            const postId = `t3_pbt_post_${runCounter}` as const;
            const wrapper = createConflictAwareRedisWrapper(redis);
            const pbtApp = createApp({ redisClient: wrapper.client, retryDelayMs: () => 0 });

            const initCtx = buildPostContext(headers, {
              postId,
              userId: 't2_pbt_0',
              username: 'pbt_0',
              postData: { puzzleDate: '2026-11-18', seed: `pbt-${seedLabel}-${runCounter}`, gridCols, gridRows: 6 },
            });

            const initRes = await getInContext(initCtx, pbtApp, API_ENDPOINTS.lotState);
            if (initRes.status !== 200) return false;
            let latestState = (await initRes.json()) as LotStateResponse;

            if (gridCols === 6 && latestState.liveFloor.occupiedCells.length >= 12) {
              if (
                !checkInvariantP1(6, 6, new Set(latestState.liveFloor.occupiedCells), {
                  remainingStalls: latestState.liveFloor.remainingStalls,
                  ghostPairs: latestState.liveFloor.ghostPairs,
                  deadSpots: latestState.liveFloor.deadSpots,
                })
              ) {
                return false;
              }
            }

            const committedUsers = new Set<string>();
            let expectedSlotCleanups = 0;

            const verifyAllPostInvariants = async (): Promise<boolean> => {
              const [metaKey, floorsKey, placementsKey, lbKey] = buildPostScopedLotKeys(postId);
              const [rawMeta, rawFloors, rawPlacements, lbMembers] = await Promise.all([
                redis.hGetAll(metaKey),
                redis.hGetAll(floorsKey),
                redis.hGetAll(placementsKey),
                redis.zRange(lbKey, 0, -1),
              ]);
              if (hasContentHashKey(rawMeta) || hasContentHashKey(rawFloors) || hasContentHashKey(rawPlacements)) {
                return false;
              }

              const currentRevision = Number(rawMeta.revision ?? '0');
              const activeFloor = Number(rawMeta.activeFloor ?? '1');
              const floorCount = Number(rawMeta.floorCount ?? '1');

              const floors: StoredFloorRecord[] = [];
              for (let f = 1; f <= floorCount; f += 1) {
                const rawFloor = rawFloors[String(f)];
                if (rawFloor === undefined) return false;
                floors.push(JSON.parse(rawFloor) as StoredFloorRecord);
              }

              const placementsMap: Record<string, PlacementReceipt> = {};
              for (const [uid, json] of Object.entries(rawPlacements)) {
                placementsMap[uid] = JSON.parse(json) as PlacementReceipt;
              }
              const lbScores = new Map<string, number>(lbMembers.map((e) => [e.member, e.score]));

              if (!checkInvariantP3(gridCols, 6, floors, placementsMap, lbScores)) return false;
              if (!checkInvariantP4(gridCols, 6, activeFloor, floorCount, floors)) return false;
              if (
                !checkInvariantP5({
                  currentRevision,
                  persistedPlacementCount: committedUsers.size,
                  txnGetCalls: wrapper.telemetry.txnGetCalls,
                  expectedSlotCleanups,
                  actualSlotCleanups: wrapper.telemetry.unwatchCalls + wrapper.telemetry.discardCalls,
                })
              ) {
                return false;
              }

              const stateCheckRes = await getInContext(initCtx, pbtApp, API_ENDPOINTS.lotState);
              if (stateCheckRes.status !== 200) return false;
              latestState = (await stateCheckRes.json()) as LotStateResponse;
              return true;
            };

            for (const action of actions) {
              const occupiedSet = new Set(latestState.liveFloor.occupiedCells);

              if (action.kind === 'valid_commit') {
                const uid = `t2_pbt_${action.playerIdx}` as const;
                const playerCtx = buildPostContext(headers, { postId, userId: uid, username: `pbt_${action.playerIdx}` });
                const vanMoves = listValidPlacements(gridCols, 6, occupiedSet, 'van_3x1');
                const sedanMoves = listValidPlacements(gridCols, 6, occupiedSet, 'sedan_2x1');
                const chosenType: VehicleType = action.preferVan && vanMoves.length > 0 ? 'van_3x1' : 'sedan_2x1';
                const pool = chosenType === 'van_3x1' ? vanMoves : sedanMoves;
                if (pool.length === 0) continue;
                const chosenCells = pool[action.moveSelector % pool.length]!;
                const evalMove = evaluatePlacement(
                  gridCols,
                  6,
                  occupiedSet,
                  latestState.liveFloor.elevatorCell,
                  chosenType,
                  chosenCells,
                );

                if (action.transientFault !== 'none' && !committedUsers.has(uid)) {
                  wrapper.injectNextExecFault(action.transientFault);
                  if (action.transientFault === 'throw_error') expectedSlotCleanups += 1;
                }

                const res = await postParkInContext(playerCtx, pbtApp, {
                  floorNumber: latestState.activeFloor,
                  expectedRevision: latestState.revision,
                  vehicleType: chosenType,
                  cells: chosenCells,
                  ...(action.tamperScores
                    ? { warmUpScores: [500_000, 500_000], score: 999_999, stepScore: 999_999, totalShiftScore: 999_999 }
                    : {}),
                  clientPreview: {
                    wastedStalls: evalMove.wastedStalls,
                    remainingStallsAfter: evalMove.remainingStallsAfter,
                  },
                });
                if (res.status !== 200) return false;
                const body = (await res.json()) as { alreadyCommitted: boolean };
                if (committedUsers.has(uid)) {
                  if (!body.alreadyCommitted) return false;
                } else {
                  if (body.alreadyCommitted) return false;
                  committedUsers.add(uid);
                  totalAppliedCommits += 1;
                }
              } else if (action.kind === 'exhaust_conflict_abort') {
                const uid = `t2_pbt_${action.playerIdx}` as const;
                if (committedUsers.has(uid)) continue;
                const sedanMoves = listValidPlacements(gridCols, 6, occupiedSet, 'sedan_2x1');
                if (sedanMoves.length === 0) continue;

                let remainingFaults = 4;
                const faultClient = new Proxy(wrapper.client, {
                  get(target, prop, receiver) {
                    if (prop === 'watch') {
                      return async (...keys: string[]) => {
                        if (remainingFaults > 0) {
                          remainingFaults -= 1;
                          wrapper.injectNextExecFault('throw_error');
                        }
                        return await target.watch(...keys);
                      };
                    }
                    return Reflect.get(target, prop, receiver);
                  },
                });
                const faultApp = createApp({ redisClient: faultClient, retryDelayMs: () => 0 });
                const playerCtx = buildPostContext(headers, { postId, userId: uid, username: `pbt_${action.playerIdx}` });
                expectedSlotCleanups += 4;
                const res = await postParkInContext(playerCtx, faultApp, {
                  floorNumber: latestState.activeFloor,
                  expectedRevision: latestState.revision,
                  vehicleType: 'sedan_2x1',
                  cells: sedanMoves[0]!,
                  clientPreview: { wastedStalls: 1, remainingStallsAfter: 5 },
                });
                if (res.status !== 409) return false;
                totalBlockedActions += 1;
              } else if (action.kind === 'overlapping_spot_taken') {
                const uid = `t2_pbt_${action.playerIdx}` as const;
                if (committedUsers.has(uid)) continue;
                const obstacleCell = latestState.liveFloor.obstacles[0]?.cell ?? 0;
                const neighborCell = (obstacleCell % gridCols) + 1 < gridCols ? obstacleCell + 1 : obstacleCell - 1;
                const playerCtx = buildPostContext(headers, { postId, userId: uid, username: `pbt_${action.playerIdx}` });
                expectedSlotCleanups += 1;
                const res = await postParkInContext(playerCtx, pbtApp, {
                  floorNumber: latestState.activeFloor,
                  expectedRevision: latestState.revision,
                  vehicleType: 'sedan_2x1',
                  cells: [obstacleCell, neighborCell],
                  clientPreview: { wastedStalls: 0, remainingStallsAfter: 5 },
                });
                if (res.status !== 409) return false;
                totalBlockedActions += 1;
              } else if (action.kind === 'invalid_cells') {
                const uid = `t2_pbt_${action.playerIdx}` as const;
                const playerCtx = buildPostContext(headers, { postId, userId: uid, username: `pbt_${action.playerIdx}` });
                const res = await postParkInContext(playerCtx, pbtApp, {
                  floorNumber: latestState.activeFloor,
                  expectedRevision: latestState.revision,
                  vehicleType: 'van_3x1',
                  cells: [0, 1, gridCols + 1],
                  clientPreview: { wastedStalls: 0, remainingStallsAfter: 5 },
                });
                if (res.status !== 400) return false;
                totalBlockedActions += 1;
              } else if (action.kind === 'duplicate_replay') {
                const existingUid = [...committedUsers][0];
                if (existingUid === undefined) continue;
                const cells = listValidPlacements(gridCols, 6, occupiedSet, 'sedan_2x1')[0] ?? [0, 1];
                const playerCtx = buildPostContext(headers, {
                  postId,
                  userId: existingUid as `t2_${string}`,
                  username: 'replay_driver',
                });
                const res = await postParkInContext(playerCtx, pbtApp, {
                  floorNumber: latestState.activeFloor,
                  expectedRevision: latestState.revision,
                  vehicleType: 'sedan_2x1',
                  cells,
                  clientPreview: { wastedStalls: 1, remainingStallsAfter: 5 },
                });
                if (res.status !== 200) return false;
                const body = (await res.json()) as { alreadyCommitted: boolean };
                if (!body.alreadyCommitted) return false;
              } else if (action.kind === 'concurrent_pair') {
                const uidA = `t2_pbt_${action.playerA}` as const;
                const uidB = `t2_pbt_${action.playerB}` as const;
                if (committedUsers.has(uidA) || committedUsers.has(uidB)) continue;
                const sedanMoves = listValidPlacements(gridCols, 6, occupiedSet, 'sedan_2x1');
                if (sedanMoves.length < 2) continue;
                const cellsA = sedanMoves[0]!;
                const cellsB = action.sameCells
                  ? cellsA
                  : (sedanMoves.find((m) => !m.includes(cellsA[0]!) && !m.includes(cellsA[1]!)) ?? cellsA);

                const ctxA = buildPostContext(headers, { postId, userId: uidA, username: `pbt_${action.playerA}` });
                const ctxB = buildPostContext(headers, { postId, userId: uidB, username: `pbt_${action.playerB}` });

                const [resA, resB] = await Promise.all([
                  postParkInContext(ctxA, pbtApp, {
                    floorNumber: latestState.activeFloor,
                    expectedRevision: latestState.revision,
                    vehicleType: 'sedan_2x1',
                    cells: cellsA,
                    clientPreview: { wastedStalls: 1, remainingStallsAfter: 0 },
                  }),
                  postParkInContext(ctxB, pbtApp, {
                    floorNumber: latestState.activeFloor,
                    expectedRevision: latestState.revision,
                    vehicleType: 'sedan_2x1',
                    cells: cellsB,
                    clientPreview: { wastedStalls: 1, remainingStallsAfter: 0 },
                  }),
                ]);

                if (resA.status === 200) {
                  committedUsers.add(uidA);
                  totalAppliedCommits += 1;
                } else if (resA.status === 409) {
                  totalBlockedActions += 1;
                } else {
                  return false;
                }

                if (resB.status === 200) {
                  committedUsers.add(uidB);
                  totalAppliedCommits += 1;
                } else if (resB.status === 409) {
                  totalBlockedActions += 1;
                } else {
                  return false;
                }
              }

              if (!(await verifyAllPostInvariants())) return false;
            }
            return true;
          }),
          { numRuns: 25 },
        );
      } finally {
        infoSpy.mockRestore();
      }

      expect(totalAppliedCommits).toBeGreaterThan(0);
      expect(totalBlockedActions).toBeGreaterThan(0);
    },
  );
});

describe('Ticket 02 — Role 3: Oracle Calibration & Individual Fault Sensitivity', () => {
  it('calibrates P1 oracle individually against mutated remainingStalls, overlapping ghostPairs, and dropped deadSpots', () => {
    const occupied = new Set<number>(Array.from({ length: 31 }, (_, idx) => idx + 5));
    const validCapacity = computeStandardStallCapacity(6, 6, occupied);
    expect(checkInvariantP1(6, 6, occupied, validCapacity)).toBe(true);

    expect(
      checkInvariantP1(6, 6, occupied, { ...validCapacity, remainingStalls: validCapacity.remainingStalls + 1 }),
    ).toBe(false);
    expect(
      checkInvariantP1(6, 6, occupied, { remainingStalls: 2, ghostPairs: [[0, 1], [1, 2]], deadSpots: [3, 4] }),
    ).toBe(false);
    expect(checkInvariantP1(6, 6, occupied, { ...validCapacity, deadSpots: [] })).toBe(false);
  });

  it('calibrates P2 oracle individually against missing zero-waste moves, out-of-range wastedStalls, and nonzero elevatorBonus on wasteful moves', () => {
    const [bay1, bay2] = generateWarmUpBays('calibration-seed');
    const bay1Occupied = bay1.obstacles.map((o) => o.cell);
    const validSedanEvals = listValidPlacements(6, 6, bay1Occupied, 'sedan_2x1').map((cells) =>
      evaluatePlacement(6, 6, bay1Occupied, bay1.elevatorCell, 'sedan_2x1', cells),
    );
    expect(checkInvariantP2('sedan_2x1', validSedanEvals)).toBe(true);

    const noZeroWaste = validSedanEvals.map((ev) => ({ ...ev, wastedStalls: 1, elevatorBonus: 0, stepScore: 55 }));
    expect(checkInvariantP2('sedan_2x1', noZeroWaste)).toBe(false);

    expect(
      checkInvariantP2('sedan_2x1', [
        validSedanEvals.find((e) => e.wastedStalls === 0)!,
        { wastedStalls: 2, elevatorBonus: 0, stepScore: 10 },
      ]),
    ).toBe(false);

    const bay2Occupied = bay2.obstacles.map((o) => o.cell);
    const validVanEvals = listValidPlacements(6, 6, bay2Occupied, 'van_3x1').map((cells) =>
      evaluatePlacement(6, 6, bay2Occupied, bay2.elevatorCell, 'van_3x1', cells),
    );
    expect(checkInvariantP2('van_3x1', validVanEvals, { requireFullVanSpread: true })).toBe(true);
    expect(
      checkInvariantP2('van_3x1', [
        validVanEvals.find((e) => e.wastedStalls === 0)!,
        { wastedStalls: 3, elevatorBonus: 0, stepScore: 0 },
      ]),
    ).toBe(false);

    expect(
      checkInvariantP2('sedan_2x1', [
        validSedanEvals.find((e) => e.wastedStalls === 0)!,
        { wastedStalls: 1, elevatorBonus: 8, stepScore: 63 },
      ]),
    ).toBe(false);
  });

  it('calibrates P3, P4, and P5 predicates individually against tampered scores, unarchived zero-capacity floors, and ghost revision increments', () => {
    const seeded = generateSeededFloor('cal-p345', 1);
    const occupied = new Set(seeded.obstacles.map((o) => o.cell));
    const move = listValidPlacements(6, 6, occupied, 'sedan_2x1')[0]!;
    const evalMove = evaluatePlacement(6, 6, occupied, seeded.elevatorCell, 'sedan_2x1', move);

    const validFloor: StoredFloorRecord = {
      floorNumber: 1,
      seed: seeded.seed,
      elevatorCell: seeded.elevatorCell,
      obstacles: seeded.obstacles,
      vehicles: [
        {
          userId: 't2_u1',
          username: 'u1',
          snoovatar: null,
          vehicleType: 'sedan_2x1',
          cells: move,
          wastedStalls: evalMove.wastedStalls,
          elevatorBonus: evalMove.elevatorBonus,
          stepScore: evalMove.stepScore,
          windowNoteId: null,
          parkedAtIso: '2026-11-18T00:00:00.000Z',
        },
      ],
      remainingStalls: evalMove.remainingStallsAfter,
      status: 'LIVE',
      lastSpotHero: null,
    };

    const validReceipt: PlacementReceipt = {
      postId: 't3_cal',
      puzzleDate: '2026-11-18',
      userId: 't2_u1',
      username: 'u1',
      snoovatar: null,
      floorNumber: 1,
      revision: 1,
      vehicleType: 'sedan_2x1',
      cells: move,
      wastedStalls: evalMove.wastedStalls,
      elevatorBonus: evalMove.elevatorBonus,
      stepScore: evalMove.stepScore,
      totalShiftScore: evalMove.stepScore,
      remainingStallsBefore: evalMove.remainingStallsBefore,
      remainingStallsAfter: evalMove.remainingStallsAfter,
      ghostPairsAfter: evalMove.ghostPairsAfter,
      deadSpotsAfter: evalMove.deadSpotsAfter,
      crownedLastSpotHero: false,
      openedOverflowFloor: null,
      windowNoteId: null,
      parkedAtIso: '2026-11-18T00:00:00.000Z',
      streak: { currentStreak: 1, bestStreak: 1, totalShifts: 1, lastPlayedPuzzleDate: '2026-11-18' },
    };

    expect(checkInvariantP3(6, 6, [validFloor], { t2_u1: validReceipt }, new Map([['t2_u1', evalMove.stepScore]]))).toBe(
      true,
    );
    expect(
      checkInvariantP3(
        6,
        6,
        [validFloor],
        { t2_u1: { ...validReceipt, totalShiftScore: 999_999 } },
        new Map([['t2_u1', 999_999]]),
      ),
    ).toBe(false);

    const fullObstacles = Array.from({ length: 34 }, (_, idx) => ({ cell: idx + 2, kind: 'pillar' as const }));
    const unsealedFullFloor: StoredFloorRecord = {
      floorNumber: 1,
      seed: 's',
      elevatorCell: 0,
      obstacles: fullObstacles,
      vehicles: [
        {
          userId: 't2_u1',
          username: 'u1',
          snoovatar: null,
          vehicleType: 'sedan_2x1',
          cells: [0, 1],
          wastedStalls: 0,
          elevatorBonus: 22,
          stepScore: 122,
          windowNoteId: null,
          parkedAtIso: '2026-11-18T00:00:00.000Z',
        },
      ],
      remainingStalls: 0,
      status: 'LIVE',
      lastSpotHero: null,
    };
    expect(checkInvariantP4(6, 6, 1, 1, [unsealedFullFloor])).toBe(false);

    expect(
      checkInvariantP5({
        currentRevision: 1,
        persistedPlacementCount: 1,
        txnGetCalls: 0,
        expectedSlotCleanups: 1,
        actualSlotCleanups: 1,
      }),
    ).toBe(true);
    expect(
      checkInvariantP5({
        currentRevision: 2,
        persistedPlacementCount: 1,
        txnGetCalls: 0,
        expectedSlotCleanups: 0,
        actualSlotCleanups: 0,
      }),
    ).toBe(false);
    expect(
      checkInvariantP5({
        currentRevision: 1,
        persistedPlacementCount: 1,
        txnGetCalls: 1,
        expectedSlotCleanups: 0,
        actualSlotCleanups: 0,
      }),
    ).toBe(false);
  });
});
