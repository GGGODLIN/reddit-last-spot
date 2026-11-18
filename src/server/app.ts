import type { RedisClient } from '@devvit/redis';
import { context, EntrypointHeight, reddit, redis } from '@devvit/web/server';
import type { TriggerResponse, UiResponse } from '@devvit/web/shared';
import { Hono, type Context as HonoContext } from 'hono';
import { z } from 'zod';
import {
  computeNextUserStreak,
  computeStandardStallCapacity,
  DEFAULT_GRID_COLS,
  DEFAULT_GRID_ROWS,
  evaluatePlacement,
  generateSeededFloor,
  isPresetWindowNoteId,
  LOT_SCHEMA_VERSION,
  type LotSummaryResponse,
  MAX_FLOORS,
  type ParkedVehicle,
  type ParkRequestPayload,
  type ParkResponse,
  type PlacementReceipt,
  type StoredFloorRecord,
  validatePlacementShape,
  type WindowNoteId,
} from '../shared/domain';
import {
  API_ENDPOINTS,
  APP_NAME,
  ERROR_CODES,
  FORM_ENDPOINTS,
  FORM_IDS,
  MENU_ENDPOINTS,
  type ProbeWriteGuardResponse,
  SCHEDULER_TASKS,
  TRIGGER_ENDPOINTS,
} from '../shared/manifest-contract';
import {
  buildCronLockKey,
  buildFloorView,
  buildPostScopedLotKeys,
  buildUserStatsKey,
  CRON_STATUS_KEY,
  ensurePostLotInitialized,
  extractPostSeedDefaults,
  formatSpoilerSafeBattleReport,
  parsePlacementReceipt,
  parseStoredFloorRecord,
  parseStoredLotMeta,
  parseUserStreakStats,
  readLotStateSnapshot,
  readLotSummarySnapshot,
} from './lib/lot-store';
import { runAtomicRedisTransaction } from './lib/redis-tx';

export { buildPostScopedLotKeys };

const DEFAULT_SUMMARY_CACHE_TTL_MS = 5_000;
const MAX_BENIGN_PARK_RETRIES = 3;

export interface RedditApiAdapter {
  submitCustomPost(
    options: Parameters<typeof reddit.submitCustomPost>[0],
  ): Promise<{ readonly id: string }>;
  submitComment(options: {
    readonly id: `t1_${string}` | `t3_${string}`;
    readonly text: string;
    readonly runAs?: 'USER' | 'APP';
  }): Promise<{
    readonly id: `t1_${string}`;
    distinguish(makeSticky?: boolean): Promise<void>;
  }>;
}

export interface AppDependencies {
  readonly redisClient?: RedisClient;
  readonly redditClient?: RedditApiAdapter;
  readonly journeyTelemetrySink?: (event: {
    readonly step: string;
    readonly subroute: string | null;
    readonly postId: string | null;
    readonly mode: string | null;
    readonly receiptStatus?: string;
  }) => Promise<{ readonly receiptStatus?: string } | void>;
  readonly nowMs?: () => number;
  readonly summaryCacheTtlMs?: number;
  readonly retryDelayMs?: () => number;
}

const parkRequestSchema = z
  .object({
    floorNumber: z.number().int().min(1).max(MAX_FLOORS),
    expectedRevision: z.number().int().min(0),
    vehicleType: z.enum(['sedan_2x1', 'van_3x1']),
    cells: z.array(z.number().int()).min(2).max(3),
    warmUpScores: z.tuple([z.number().finite(), z.number().finite()]).optional(),
    windowNoteId: z.string().max(64).optional(),
    clientPreview: z.object({
      wastedStalls: z.number().int().min(0),
      remainingStallsAfter: z.number().int().min(0),
    }),
  })
  .superRefine((payload, ctx) => {
    const expectedCellCount = payload.vehicleType === 'sedan_2x1' ? 2 : 3;
    if (payload.cells.length !== expectedCellCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cells'],
        message: `Vehicle ${payload.vehicleType} requires ${expectedCellCount} cells`,
      });
    }
  });

function isAuthenticatedUserId(userId: string | undefined): userId is string {
  return typeof userId === 'string' && userId.startsWith('t2_') && userId.length > 3;
}

function resolveActivePostId(): string {
  return typeof context.postId === 'string' && context.postId.length > 0
    ? context.postId
    : `t3_default_${context.subredditId ?? 'lot'}`;
}

function parseNonNegativeRevision(rawValue: string | undefined): number {
  if (rawValue === undefined) {
    return 0;
  }
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

async function readJsonRecord(c: HonoContext): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await c.req.json();
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

async function readStrictJsonBody(
  c: HonoContext,
): Promise<{ readonly ok: true; readonly body: unknown } | { readonly ok: false }> {
  try {
    const parsed: unknown = await c.req.json();
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false };
    }
    return { ok: true, body: parsed };
  } catch {
    return { ok: false };
  }
}

function buildDailyLotLogCommentBody(puzzleDate: string, remainingStalls: number): string {
  return [
    `**Daily Lot Log — Last Spot (${puzzleDate})**`,
    '',
    `Official community shift reports land below. Floor B1 opens with ${remainingStalls} standard 2x1 stalls available — exact grid coordinates are omitted from shift reports.`,
  ].join('\n');
}

async function createAndMaterializeSeededPost(params: {
  readonly redisClient: RedisClient;
  readonly redditClient: RedditApiAdapter;
  readonly subredditName: string;
  readonly puzzleDate: string;
  readonly seed: string;
}): Promise<{
  readonly postId: string;
  readonly summaryCommentId: `t1_${string}` | null;
  readonly postDataBytes: number;
  readonly remainingStalls: number;
}> {
  const { redisClient, redditClient, subredditName, puzzleDate, seed } = params;
  const seeded1 = generateSeededFloor(seed, 1, {
    gridCols: DEFAULT_GRID_COLS,
    gridRows: DEFAULT_GRID_ROWS,
  });

  const postData = {
    schemaVersion: LOT_SCHEMA_VERSION,
    puzzleDate,
    seed,
    gridCols: DEFAULT_GRID_COLS,
    gridRows: DEFAULT_GRID_ROWS,
    activeFloor: 1,
    remainingStalls: seeded1.remainingStalls,
    initialObstacleMask: seeded1.obstacles.map((o) => o.cell),
  };
  const postDataBytes = Buffer.byteLength(JSON.stringify(postData), 'utf8');
  if (postDataBytes >= 256) {
    throw new RangeError(`Custom postData exceeded 256-byte limit (${postDataBytes} bytes)`);
  }

  const post = await redditClient.submitCustomPost({
    subredditName,
    title: `Last Spot — Daily Valet Shift (${puzzleDate})`,
    entry: 'default',
    styles: {
      height: EntrypointHeight.TALL,
      backgroundColor: '#F8FAFCFF',
      backgroundColorDark: '#090D16FF',
    },
    postData,
    textFallback: {
      text: 'Last Spot — Daily Shared Community Valet Shift. Open on modern web or mobile app to play.',
    },
  });

  const [metaKey, floorsKey] = buildPostScopedLotKeys(post.id);
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

  await Promise.all([
    redisClient.hSet(floorsKey, { '1': JSON.stringify(floor1Record) }),
    redisClient.hSet(metaKey, {
      schemaVersion: String(LOT_SCHEMA_VERSION),
      puzzleDate,
      seed,
      gridCols: String(DEFAULT_GRID_COLS),
      gridRows: String(DEFAULT_GRID_ROWS),
      activeFloor: '1',
      floorCount: '1',
      revision: '0',
    }),
  ]);

  let summaryCommentId: `t1_${string}` | null = null;
  try {
    const comment = await redditClient.submitComment({
      id: post.id as `t3_${string}`,
      text: buildDailyLotLogCommentBody(puzzleDate, seeded1.remainingStalls),
      runAs: 'APP',
    });
    summaryCommentId = comment.id;
    try {
      await comment.distinguish(true);
    } catch (distinguishError) {
      // Non-mod permission edge cases during playtest must never abort post creation.
      console.warn(
        JSON.stringify({
          event: 'ops.summary_comment_sticky_skipped',
          postId: post.id,
          commentId: comment.id,
          error:
            distinguishError instanceof Error ? distinguishError.message : String(distinguishError),
        }),
      );
    }
    await redisClient.hSet(metaKey, { summaryCommentId: comment.id });
  } catch (commentError) {
    console.warn(
      JSON.stringify({
        event: 'ops.summary_comment_create_failed',
        postId: post.id,
        error: commentError instanceof Error ? commentError.message : String(commentError),
      }),
    );
  }

  return {
    postId: post.id,
    summaryCommentId,
    postDataBytes,
    remainingStalls: seeded1.remainingStalls,
  };
}

function sleepMs(durationMs: number): Promise<void> {
  if (durationMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

type ParkTxAbortReason =
  | 'already_committed'
  | 'floor_not_open'
  | 'spot_taken'
  | 'lot_updated_retry_preview';

export function createApp(deps: AppDependencies = {}): Hono {
  const redisClient = deps.redisClient ?? redis;
  const redditClient: RedditApiAdapter = deps.redditClient ?? reddit;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const summaryCacheTtlMs = deps.summaryCacheTtlMs ?? DEFAULT_SUMMARY_CACHE_TTL_MS;
  const retryDelayMs = deps.retryDelayMs ?? (() => 40 + Math.floor(Math.random() * 81));

  // Keyed solely by postId so inline feed bursts never leak user-specific fields across viewers.
  const summaryCache = new Map<
    string,
    { readonly payload: LotSummaryResponse; readonly expiresAtMs: number }
  >();

  const router = new Hono();

  router.get(API_ENDPOINTS.health, (c) => {
    return c.json(
      {
        ok: true,
        app: APP_NAME,
        authenticated: typeof context.userId === 'string' && context.userId.length > 0,
        subredditName: context.subredditName ?? null,
        postId: context.postId ?? null,
      },
      200,
    );
  });

  router.get(API_ENDPOINTS.lotSummary, async (c) => {
    const postId = resolveActivePostId();
    const currentNow = nowMs();
    const cached = summaryCache.get(postId);
    if (cached !== undefined && currentNow < cached.expiresAtMs) {
      return c.json(cached.payload, 200);
    }

    const defaults = extractPostSeedDefaults(postId, context.postData, currentNow);
    const summary = await readLotSummarySnapshot(redisClient, postId, defaults);
    summaryCache.set(postId, { payload: summary, expiresAtMs: currentNow + summaryCacheTtlMs });
    return c.json(summary, 200);
  });

  router.get(API_ENDPOINTS.lotState, async (c) => {
    const postId = resolveActivePostId();
    const defaults = extractPostSeedDefaults(postId, context.postData, nowMs());
    const authedUserId = isAuthenticatedUserId(context.userId) ? context.userId : null;

    const rawFloorQuery = c.req.query('floor');
    let requestedFloorNumber: number | undefined;
    if (rawFloorQuery !== undefined) {
      if (!/^\d+$/.test(rawFloorQuery)) {
        return c.json({ ok: false, code: ERROR_CODES.invalidFloorQuery }, 400);
      }
      requestedFloorNumber = Number.parseInt(rawFloorQuery, 10);
    }

    const result = await readLotStateSnapshot(
      redisClient,
      postId,
      authedUserId,
      requestedFloorNumber,
      defaults,
    );
    if (!result.ok) {
      return c.json({ ok: false, code: ERROR_CODES.invalidFloorQuery }, 400);
    }
    return c.json(result.state, 200);
  });

  router.post(API_ENDPOINTS.park, async (c) => {
    const userId = context.userId;
    if (!isAuthenticatedUserId(userId)) {
      return c.json<ParkResponse>({ ok: false, code: ERROR_CODES.loginRequiredForOfficialSpot }, 401);
    }

    const rawJsonResult = await readStrictJsonBody(c);
    if (!rawJsonResult.ok) {
      return c.json<ParkResponse>({ ok: false, code: ERROR_CODES.invalidParkPayload }, 400);
    }

    const parsedBodyResult = parkRequestSchema.safeParse(rawJsonResult.body);
    if (!parsedBodyResult.success) {
      return c.json<ParkResponse>({ ok: false, code: ERROR_CODES.invalidParkPayload }, 400);
    }

    const body: ParkRequestPayload = {
      ...parsedBodyResult.data,
      windowNoteId: isPresetWindowNoteId(parsedBodyResult.data.windowNoteId)
        ? parsedBodyResult.data.windowNoteId
        : null,
    };
    const postId = resolveActivePostId();
    const defaults = extractPostSeedDefaults(postId, context.postData, nowMs());
    await ensurePostLotInitialized(redisClient, postId, defaults);

    const [metaKey, floorsKey, placementsKey, lbKey] = buildPostScopedLotKeys(postId);
    const userStatsKey = buildUserStatsKey(userId);

    const [preRawMeta, prePlacementRaw] = await Promise.all([
      redisClient.hGetAll(metaKey),
      redisClient.hGet(placementsKey, userId),
    ]);
    const preMeta = parseStoredLotMeta(preRawMeta, defaults);

    const shapeValidation = validatePlacementShape(
      preMeta.gridCols,
      preMeta.gridRows,
      body.vehicleType,
      body.cells,
    );
    if (!shapeValidation.ok) {
      return c.json(
        { ok: false, code: ERROR_CODES.invalidParkPayload, reason: shapeValidation.reason },
        400,
      );
    }

    // Fast pre-watch exit avoids consuming one of Devvit's 20 installation transaction slots on duplicate clicks.
    const preExistingReceipt = parsePlacementReceipt(prePlacementRaw);
    if (preExistingReceipt !== null) {
      const latest = await readLotStateSnapshot(redisClient, postId, userId, undefined, defaults);
      return c.json<ParkResponse>(
        {
          ok: true,
          alreadyCommitted: true,
          receipt: preExistingReceipt,
          latestLotState: latest.ok ? latest.state : null,
        },
        200,
      );
    }

    const normalizedCells = shapeValidation.normalizedCells;
    const safeWindowNoteId = body.windowNoteId ?? null;
    let existingReceiptFromWatch: PlacementReceipt | null = null;

    for (let attempt = 0; attempt <= MAX_BENIGN_PARK_RETRIES; attempt += 1) {
      const txResult = await runAtomicRedisTransaction<
        {
          readonly rawMeta: Record<string, string>;
          readonly rawFloors: Record<string, string>;
          readonly rawExistingPlacement: string | undefined;
          readonly rawUserStats: Record<string, string>;
        },
        { readonly receipt: PlacementReceipt },
        ParkTxAbortReason
      >({
        redis: redisClient,
        watchedKeys: [metaKey, floorsKey, placementsKey, lbKey, userStatsKey],
        readAfterWatch: async () => {
          const [rawMeta, rawFloors, rawExistingPlacement, rawUserStats] = await Promise.all([
            redisClient.hGetAll(metaKey),
            redisClient.hGetAll(floorsKey),
            redisClient.hGet(placementsKey, userId),
            redisClient.hGetAll(userStatsKey),
          ]);
          return { rawMeta, rawFloors, rawExistingPlacement, rawUserStats };
        },
        planTransaction: (snapshot) => {
          const insideExisting = parsePlacementReceipt(snapshot.rawExistingPlacement);
          if (insideExisting !== null) {
            existingReceiptFromWatch = insideExisting;
            return { kind: 'abort', reason: 'already_committed' };
          }

          const meta = parseStoredLotMeta(snapshot.rawMeta, defaults);
          if (body.floorNumber > meta.floorCount) {
            return { kind: 'abort', reason: 'floor_not_open' };
          }
          if (body.floorNumber !== meta.activeFloor) {
            return { kind: 'abort', reason: 'spot_taken' };
          }

          const activeFloorNum = meta.activeFloor;
          const storedLiveFloor = parseStoredFloorRecord(
            snapshot.rawFloors[String(activeFloorNum)],
            activeFloorNum,
            `${meta.seed}:floor:${activeFloorNum}`,
          );
          if (storedLiveFloor === null || storedLiveFloor.status !== 'LIVE') {
            return { kind: 'abort', reason: 'spot_taken' };
          }

          const liveFloorView = buildFloorView(storedLiveFloor, meta.gridCols, meta.gridRows);
          const occupiedSet = new Set<number>(liveFloorView.occupiedCells);
          for (const cell of normalizedCells) {
            if (occupiedSet.has(cell)) {
              return { kind: 'abort', reason: 'spot_taken' };
            }
          }

          const evalResult = evaluatePlacement(
            meta.gridCols,
            meta.gridRows,
            occupiedSet,
            liveFloorView.elevatorCell,
            body.vehicleType,
            normalizedCells,
          );

          if (
            meta.revision !== body.expectedRevision &&
            evalResult.wastedStalls > body.clientPreview.wastedStalls
          ) {
            return { kind: 'abort', reason: 'lot_updated_retry_preview' };
          }

          const commitIso = new Date(nowMs()).toISOString();
          const nextRevision = meta.revision + 1;
          const totalShiftScore = evalResult.stepScore;
          const parkedVehicle: ParkedVehicle = {
            userId,
            username: context.username ?? userId,
            snoovatar: context.snoovatar ?? null,
            vehicleType: body.vehicleType,
            cells: normalizedCells,
            wastedStalls: evalResult.wastedStalls,
            elevatorBonus: evalResult.elevatorBonus,
            stepScore: evalResult.stepScore,
            windowNoteId: safeWindowNoteId,
            parkedAtIso: commitIso,
          };

          const crownedLastSpotHero = evalResult.remainingStallsAfter === 0;
          const updatedCurrentFloor: StoredFloorRecord = {
            floorNumber: activeFloorNum,
            seed: storedLiveFloor.seed,
            elevatorCell: storedLiveFloor.elevatorCell,
            obstacles: storedLiveFloor.obstacles,
            vehicles: [...storedLiveFloor.vehicles, parkedVehicle],
            remainingStalls: evalResult.remainingStallsAfter,
            status: crownedLastSpotHero ? 'ARCHIVED' : 'LIVE',
            lastSpotHero: crownedLastSpotHero ? userId : storedLiveFloor.lastSpotHero,
          };

          const floorFieldUpdates: Record<string, string> = {
            [String(activeFloorNum)]: JSON.stringify(updatedCurrentFloor),
          };

          let nextActiveFloor = activeFloorNum;
          let nextFloorCount = meta.floorCount;
          let openedOverflowFloor: number | null = null;

          if (crownedLastSpotHero && activeFloorNum < MAX_FLOORS) {
            const overflowFloorNumber = activeFloorNum + 1;
            const seededNext = generateSeededFloor(meta.seed, overflowFloorNumber, {
              gridCols: meta.gridCols,
              gridRows: meta.gridRows,
            });
            const overflowRecord: StoredFloorRecord = {
              floorNumber: overflowFloorNumber,
              seed: seededNext.seed,
              elevatorCell: seededNext.elevatorCell,
              obstacles: seededNext.obstacles,
              vehicles: [],
              remainingStalls: seededNext.remainingStalls,
              status: 'LIVE',
              lastSpotHero: null,
            };
            floorFieldUpdates[String(overflowFloorNumber)] = JSON.stringify(overflowRecord);
            nextActiveFloor = overflowFloorNumber;
            nextFloorCount = Math.max(meta.floorCount, overflowFloorNumber);
            openedOverflowFloor = overflowFloorNumber;
          }

          const nextStreak = computeNextUserStreak(
            parseUserStreakStats(snapshot.rawUserStats),
            meta.puzzleDate,
          );

          const receipt: PlacementReceipt = {
            postId,
            puzzleDate: meta.puzzleDate,
            userId,
            username: parkedVehicle.username,
            snoovatar: parkedVehicle.snoovatar,
            floorNumber: activeFloorNum,
            revision: nextRevision,
            vehicleType: body.vehicleType,
            cells: normalizedCells,
            wastedStalls: evalResult.wastedStalls,
            elevatorBonus: evalResult.elevatorBonus,
            stepScore: evalResult.stepScore,
            totalShiftScore,
            remainingStallsBefore: evalResult.remainingStallsBefore,
            remainingStallsAfter: evalResult.remainingStallsAfter,
            ghostPairsAfter: evalResult.ghostPairsAfter,
            deadSpotsAfter: evalResult.deadSpotsAfter,
            crownedLastSpotHero,
            openedOverflowFloor,
            windowNoteId: safeWindowNoteId,
            parkedAtIso: commitIso,
            streak: nextStreak,
          };

          return {
            kind: 'commit',
            previousRevision: meta.revision,
            expectedCmdCount: 6,
            revisionReplyIndex: 0,
            value: { receipt },
            queueCommands: async (txn) => {
              await txn.hIncrBy(metaKey, 'revision', 1);
              await txn.hSet(metaKey, {
                activeFloor: String(nextActiveFloor),
                floorCount: String(nextFloorCount),
              });
              await txn.hSet(floorsKey, floorFieldUpdates);
              await txn.hSet(placementsKey, { [userId]: JSON.stringify(receipt) });
              await txn.zAdd(lbKey, { member: userId, score: totalShiftScore });
              await txn.hSet(userStatsKey, {
                currentStreak: String(nextStreak.currentStreak),
                bestStreak: String(nextStreak.bestStreak),
                totalShifts: String(nextStreak.totalShifts),
                lastPlayedPuzzleDate: nextStreak.lastPlayedPuzzleDate ?? '',
              });
            },
          };
        },
      });

      if (txResult.status === 'committed') {
        const latest = await readLotStateSnapshot(redisClient, postId, userId, undefined, defaults);
        console.info(
          JSON.stringify({
            event: 'lot.park_committed',
            postId,
            userId,
            floorNumber: txResult.value.receipt.floorNumber,
            revision: txResult.revision,
            wastedStalls: txResult.value.receipt.wastedStalls,
            totalShiftScore: txResult.value.receipt.totalShiftScore,
            crownedLastSpotHero: txResult.value.receipt.crownedLastSpotHero,
            openedOverflowFloor: txResult.value.receipt.openedOverflowFloor,
          }),
        );
        return c.json<ParkResponse>(
          {
            ok: true,
            alreadyCommitted: false,
            receipt: txResult.value.receipt,
            latestLotState: latest.ok ? latest.state : null,
          },
          200,
        );
      }

      if (txResult.status === 'aborted') {
        if (txResult.reason === 'already_committed' && existingReceiptFromWatch !== null) {
          const latest = await readLotStateSnapshot(redisClient, postId, userId, undefined, defaults);
          return c.json<ParkResponse>(
            {
              ok: true,
              alreadyCommitted: true,
              receipt: existingReceiptFromWatch,
              latestLotState: latest.ok ? latest.state : null,
            },
            200,
          );
        }
        if (txResult.reason === 'floor_not_open') {
          return c.json<ParkResponse>({ ok: false, code: ERROR_CODES.invalidParkPayload }, 400);
        }
        const latest = await readLotStateSnapshot(redisClient, postId, userId, undefined, defaults);
        const conflictCode =
          txResult.reason === 'spot_taken'
            ? ERROR_CODES.spotTaken
            : ERROR_CODES.lotUpdatedRetryPreview;
        return c.json<ParkResponse>(
          { ok: false, code: conflictCode, latestLotState: latest.ok ? latest.state : null },
          409,
        );
      }

      if (attempt < MAX_BENIGN_PARK_RETRIES) {
        await sleepMs(retryDelayMs());
      }
    }

    const latest = await readLotStateSnapshot(redisClient, postId, userId, undefined, defaults);
    return c.json<ParkResponse>(
      {
        ok: false,
        code: ERROR_CODES.concurrentConflictRetryExhausted,
        latestLotState: latest.ok ? latest.state : null,
      },
      409,
    );
  });

  router.post(API_ENDPOINTS.probeWriteGuard, async (c) => {
    const userId = context.userId;
    // Logged-out visitors run in Visitor Hold; rejecting before key interpolation prevents writing `:undefined` keys.
    if (
      typeof userId !== 'string' ||
      !userId.startsWith('t2_') ||
      userId.length <= 3
    ) {
      console.info(
        JSON.stringify({
          event: 'gate.probe_write_guard_receipt',
          ok: false,
          authenticated: false,
          status: 401,
          code: ERROR_CODES.loginRequiredForOfficialSpot,
          subredditName: context.subredditName ?? null,
          postId: context.postId ?? null,
        }),
      );
      return c.json<ProbeWriteGuardResponse>(
        {
          ok: false,
          code: ERROR_CODES.loginRequiredForOfficialSpot,
        },
        401,
      );
    }

    const probeUserKey = `probe:write-guard:${userId}`;
    await redisClient.hSet(probeUserKey, {
      userId,
      checkedAt: new Date().toISOString(),
    });

    console.info(
      JSON.stringify({
        event: 'gate.probe_write_guard_receipt',
        ok: true,
        authenticated: true,
        status: 200,
        userId,
        key: probeUserKey,
        subredditName: context.subredditName ?? null,
        postId: context.postId ?? null,
      }),
    );

    return c.json<ProbeWriteGuardResponse>(
      {
        ok: true,
        userId,
        key: probeUserKey,
      },
      200,
    );
  });

  router.post(API_ENDPOINTS.shareComment, async (c) => {
    const userId = context.userId;
    if (!isAuthenticatedUserId(userId)) {
      return c.json({ ok: false, code: ERROR_CODES.loginRequiredForOfficialSpot }, 401);
    }

    const parsedBody = await readStrictJsonBody(c);
    if (!parsedBody.ok) {
      return c.json({ ok: false, code: ERROR_CODES.invalidWindowNote }, 400);
    }

    const rawWindowNoteId = (parsedBody.body as Record<string, unknown>).windowNoteId;
    if (
      rawWindowNoteId !== undefined &&
      rawWindowNoteId !== null &&
      (typeof rawWindowNoteId !== 'string' || !isPresetWindowNoteId(rawWindowNoteId))
    ) {
      return c.json({ ok: false, code: ERROR_CODES.invalidWindowNote }, 400);
    }

    const postId = resolveActivePostId();
    const [metaKey, , placementsKey] = buildPostScopedLotKeys(postId);
    const [rawMeta, rawPlacement] = await Promise.all([
      redisClient.hGetAll(metaKey),
      redisClient.hGet(placementsKey, userId),
    ]);

    const receipt = parsePlacementReceipt(rawPlacement);
    if (receipt === null) {
      return c.json({ ok: false, code: ERROR_CODES.placementNotFound }, 404);
    }

    const effectiveNoteId: WindowNoteId | null =
      rawWindowNoteId === undefined
        ? receipt.windowNoteId
        : isPresetWindowNoteId(rawWindowNoteId)
          ? rawWindowNoteId
          : null;

    const formattedReport = formatSpoilerSafeBattleReport(receipt, effectiveNoteId);
    const targetId: `t1_${string}` | `t3_${string}` =
      typeof rawMeta.summaryCommentId === 'string' &&
      rawMeta.summaryCommentId.startsWith('t1_') &&
      rawMeta.summaryCommentId.length > 3
        ? (rawMeta.summaryCommentId as `t1_${string}`)
        : (postId as `t3_${string}`);

    const shareField = `share:${userId}`;
    const inserted = await redisClient.hSetNX(metaKey, shareField, 'pending');
    if (inserted !== 1) {
      const existingVal = await redisClient.hGet(metaKey, shareField);
      if (typeof existingVal === 'string' && existingVal.startsWith('t1_')) {
        console.info(
          JSON.stringify({
            event: 'lot.battle_report_duplicate',
            postId,
            userId,
            commentId: existingVal,
            parentCommentId: targetId,
            fellBackToAppAccount: true,
          }),
        );
        return c.json(
          {
            ok: true,
            posted: true,
            alreadyShared: true,
            commentId: existingVal,
            parentCommentId: targetId,
            fellBackToClipboard: false,
            fellBackToAppAccount: true,
            formattedReport,
          },
          200,
        );
      }

      return c.json(
        {
          ok: true,
          posted: false,
          alreadyShared: true,
          commentId: null,
          parentCommentId: targetId,
          fellBackToClipboard: true,
          fellBackToAppAccount: true,
          formattedReport,
        },
        200,
      );
    }

    try {
      const comment = await redditClient.submitComment({
        id: targetId,
        text: formattedReport,
        runAs: 'APP',
      });
      await redisClient.hSet(metaKey, { [shareField]: comment.id });
      console.info(
        JSON.stringify({
          event: 'lot.battle_report_shared',
          postId,
          userId,
          commentId: comment.id,
          parentCommentId: targetId,
          fellBackToAppAccount: true,
        }),
      );
      return c.json(
        {
          ok: true,
          posted: true,
          alreadyShared: false,
          commentId: comment.id,
          parentCommentId: targetId,
          fellBackToClipboard: false,
          fellBackToAppAccount: true,
          formattedReport,
        },
        200,
      );
    } catch (error) {
      await redisClient.hDel(metaKey, [shareField]);
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        JSON.stringify({
          event: 'lot.battle_report_share_fallback',
          postId,
          userId,
          parentCommentId: targetId,
          fellBackToClipboard: true,
          fellBackToAppAccount: true,
          error: message,
        }),
      );
      return c.json(
        {
          ok: true,
          posted: false,
          alreadyShared: false,
          commentId: null,
          parentCommentId: targetId,
          fellBackToClipboard: true,
          fellBackToAppAccount: true,
          formattedReport,
        },
        200,
      );
    }
  });

  const handleJourneyTelemetry = async (c: HonoContext) => {
    const parsedResult = await readStrictJsonBody(c);
    if (!parsedResult.ok) {
      console.warn(
        JSON.stringify({
          event: 'telemetry.journey_malformed_receipt',
          reason: 'malformed_json_or_non_object',
          path: c.req.path,
          postId: context.postId ?? null,
        }),
      );
      return c.json({ ok: true, accepted: false, receiptStatus: 'IGNORED_INVALID' }, 200);
    }

    const record = parsedResult.body as Record<string, unknown>;
    const rawStep = record.step;
    if (typeof rawStep !== 'string' || rawStep.trim().length === 0) {
      console.warn(
        JSON.stringify({
          event: 'telemetry.journey_malformed_receipt',
          reason: 'missing_or_empty_step',
          path: c.req.path,
          postId: context.postId ?? null,
        }),
      );
      return c.json({ ok: true, accepted: false, receiptStatus: 'IGNORED_INVALID' }, 200);
    }

    if (
      record.receiptStatus !== undefined &&
      (typeof record.receiptStatus !== 'string' || record.receiptStatus.trim().length === 0)
    ) {
      console.warn(
        JSON.stringify({
          event: 'telemetry.journey_malformed_receipt',
          reason: 'invalid_receipt_status',
          path: c.req.path,
          step: rawStep.trim(),
        }),
      );
      return c.json({ ok: true, accepted: false, receiptStatus: 'IGNORED_INVALID' }, 200);
    }

    const step = rawStep.trim();
    const subroute =
      c.req.path.length > API_ENDPOINTS.journeyTelemetry.length
        ? c.req.path.slice(API_ENDPOINTS.journeyTelemetry.length + 1)
        : null;
    const effectivePostId =
      typeof record.postId === 'string' && record.postId.length > 0
        ? record.postId
        : (context.postId ?? null);
    const effectiveMode =
      typeof record.mode === 'string' && record.mode.length > 0 ? record.mode : null;
    const clientReportedStatus =
      typeof record.receiptStatus === 'string' ? record.receiptStatus.trim() : undefined;

    let resolvedStatus = clientReportedStatus ?? 'RECORDED';
    if (deps.journeyTelemetrySink !== undefined) {
      try {
        const sinkReply = await deps.journeyTelemetrySink({
          step,
          subroute,
          postId: effectivePostId,
          mode: effectiveMode,
          receiptStatus: clientReportedStatus,
        });
        if (typeof sinkReply?.receiptStatus === 'string' && sinkReply.receiptStatus.length > 0) {
          resolvedStatus = sinkReply.receiptStatus;
        }
      } catch (sinkError) {
        console.warn(
          JSON.stringify({
            event: 'telemetry.journey_sink_error',
            step,
            postId: effectivePostId,
            error: sinkError instanceof Error ? sinkError.message : String(sinkError),
          }),
        );
        return c.json({ ok: true, accepted: false, receiptStatus: 'SINK_ERROR' }, 200);
      }
    }

    if (resolvedStatus === 'INVALID' || resolvedStatus === 'JOURNEY_RECEIPT_INVALID') {
      console.warn(
        JSON.stringify({
          event: 'telemetry.journey_malformed_receipt',
          reason: 'upstream_invalid_receipt',
          step,
          postId: effectivePostId,
          receiptStatus: resolvedStatus,
        }),
      );
      return c.json({ ok: true, accepted: false, receiptStatus: 'IGNORED_INVALID' }, 200);
    }

    if (
      resolvedStatus === 'DENIED_PLAYTEST' ||
      resolvedStatus === 'DENIED_NOT_ALLOWLISTED' ||
      resolvedStatus === 'JOURNEY_RECEIPT_DENIED_PLAYTEST' ||
      resolvedStatus === 'JOURNEY_RECEIPT_DENIED_NOT_ALLOWLISTED'
    ) {
      console.info(
        JSON.stringify({
          event: 'telemetry.journey_denied_nonblocking',
          step,
          subroute,
          postId: effectivePostId,
          mode: effectiveMode,
          receiptStatus: resolvedStatus,
        }),
      );
      return c.json({ ok: true, accepted: false, receiptStatus: resolvedStatus }, 200);
    }

    console.info(
      JSON.stringify({
        event: 'telemetry.journey_forwarded',
        step,
        subroute,
        postId: effectivePostId,
        mode: effectiveMode,
        userId: context.userId ?? null,
        receiptStatus: resolvedStatus,
      }),
    );
    return c.json({ ok: true, accepted: true, receiptStatus: resolvedStatus, step }, 200);
  };

  router.post(API_ENDPOINTS.journeyTelemetry, handleJourneyTelemetry);
  router.post(`${API_ENDPOINTS.journeyTelemetry}/*`, handleJourneyTelemetry);

  router.post(MENU_ENDPOINTS.postCreate, async (c) => {
    const currentNow = nowMs();
    const puzzleDate = new Date(currentNow).toISOString().slice(0, 10);
    const subredditName = context.subredditName ?? 'lastspot';
    const seed = `m:${puzzleDate}:${(currentNow % 1_000_000_000).toString(36)}`;

    try {
      const created = await createAndMaterializeSeededPost({
        redisClient,
        redditClient,
        subredditName,
        puzzleDate,
        seed,
      });
      console.info(
        JSON.stringify({
          event: 'ops.menu_post_create',
          postId: created.postId,
          summaryCommentId: created.summaryCommentId,
          postDataBytes: created.postDataBytes,
          subredditName,
        }),
      );
      return c.json<UiResponse>(
        {
          navigateTo: `https://reddit.com/r/${subredditName}/comments/${created.postId}`,
        },
        200,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({
          event: 'ops.menu_post_create_failed',
          error: message,
        }),
      );
      return c.json<UiResponse>(
        {
          showToast: 'Failed to create Last Spot post',
        },
        400,
      );
    }
  });

  router.post(MENU_ENDPOINTS.opsHealth, async (c) => {
    const subredditLabel = context.subredditName ?? 'unknown';
    const postDataBytes = Buffer.byteLength(JSON.stringify(context.postData ?? {}), 'utf8');
    const postDataUnder2048 = postDataBytes < 2048;
    const cronStatus = await redisClient.hGetAll(CRON_STATUS_KEY);
    const postId =
      typeof context.postId === 'string' && context.postId.length > 0 ? context.postId : null;

    if (postId === null) {
      const emptyProbe = computeStandardStallCapacity(DEFAULT_GRID_COLS, DEFAULT_GRID_ROWS, []);
      const matchInvariantOk = emptyProbe.remainingStalls === 18;
      console.info(
        JSON.stringify({
          event: 'ops.health_receipt',
          ok: matchInvariantOk && postDataUnder2048,
          matchInvariantOk,
          postDataBytes,
          postDataUnder2048,
          cronStatus,
          postId: null,
          activeFloor: null,
          revision: null,
          remainingStalls: emptyProbe.remainingStalls,
        }),
      );
      return c.json<UiResponse>(
        {
          showToast: `Last Spot healthy in r/${subredditLabel}`,
        },
        200,
      );
    }

    const defaults = extractPostSeedDefaults(postId, context.postData, nowMs());
    await ensurePostLotInitialized(redisClient, postId, defaults);
    const [metaKey, floorsKey] = buildPostScopedLotKeys(postId);
    const [rawMeta, rawFloors] = await Promise.all([
      redisClient.hGetAll(metaKey),
      redisClient.hGetAll(floorsKey),
    ]);
    const meta = parseStoredLotMeta(rawMeta, defaults);
    const storedFloor = parseStoredFloorRecord(
      rawFloors[String(meta.activeFloor)],
      meta.activeFloor,
      `${meta.seed}:floor:${meta.activeFloor}`,
    );

    const occupiedSet = new Set<number>();
    let occupiedEntryCount = 0;
    if (storedFloor !== null) {
      for (const obs of storedFloor.obstacles) {
        occupiedSet.add(obs.cell);
        occupiedEntryCount += 1;
      }
      for (const vehicle of storedFloor.vehicles) {
        for (const cell of vehicle.cells) {
          occupiedSet.add(cell);
          occupiedEntryCount += 1;
        }
      }
    }

    const recomputed = computeStandardStallCapacity(meta.gridCols, meta.gridRows, occupiedSet);
    const matchInvariantOk =
      storedFloor !== null &&
      occupiedEntryCount === occupiedSet.size &&
      recomputed.remainingStalls === storedFloor.remainingStalls;

    console.info(
      JSON.stringify({
        event: 'ops.health_receipt',
        ok: matchInvariantOk && postDataUnder2048,
        matchInvariantOk,
        postDataBytes,
        postDataUnder2048,
        cronStatus,
        postId,
        activeFloor: meta.activeFloor,
        revision: meta.revision,
        remainingStalls: recomputed.remainingStalls,
      }),
    );
    return c.json<UiResponse>(
      {
        showToast: matchInvariantOk
          ? `Last Spot healthy (${postId} B${meta.activeFloor}: ${recomputed.remainingStalls} stalls)`
          : `Last Spot invariant drift detected on ${postId}`,
      },
      200,
    );
  });

  router.post(MENU_ENDPOINTS.opsResetLot, (c) => {
    return c.json<UiResponse>(
      {
        showForm: {
          name: FORM_IDS.opsResetLotForm,
          form: {
            title: 'Reset Shared Parking Lot',
            description:
              'Confirm resetting the canonical post-scoped lot keys for this post.',
            fields: [
              {
                name: 'confirmPhrase',
                label: 'Type RESET to confirm',
                type: 'string',
                required: true,
              },
            ],
          },
        },
      },
      200,
    );
  });

  router.post(FORM_ENDPOINTS.opsResetLotForm, async (c) => {
    const payload = await readJsonRecord(c);
    const confirmPhrase =
      typeof payload.confirmPhrase === 'string'
        ? payload.confirmPhrase.trim()
        : '';

    if (confirmPhrase !== 'RESET') {
      return c.json<UiResponse>(
        {
          showToast: 'Lot reset skipped (confirmation phrase did not match RESET)',
        },
        200,
      );
    }

    const postId = context.postId;
    if (typeof postId !== 'string' || postId.length === 0) {
      return c.json<UiResponse>(
        {
          showToast: 'No post context found to reset',
        },
        200,
      );
    }

    await redisClient.del(...buildPostScopedLotKeys(postId));
    summaryCache.delete(postId);
    console.info(
      JSON.stringify({
        event: 'ops.lot_reset_completed',
        postId,
        actorUserId: context.userId ?? null,
      }),
    );
    return c.json<UiResponse>(
      {
        showToast: `Reset shared parking lot for ${postId}`,
      },
      200,
    );
  });

  router.post(MENU_ENDPOINTS.probeTx, async (c) => {
    const scopeId = context.postId ?? context.subredditId ?? 'default';
    const probeKey = `probe:tx:${scopeId}`;
    const actorLabel = context.userId ?? 'anonymous_mod';

    const commitCycle = await runAtomicRedisTransaction({
      redis: redisClient,
      watchedKeys: [probeKey],
      readAfterWatch: () => redisClient.hGetAll(probeKey),
      planTransaction: (rawState) => {
        const previousRevision = parseNonNegativeRevision(rawState.revision);
        return {
          kind: 'commit',
          previousRevision,
          expectedCmdCount: 2,
          revisionReplyIndex: 0,
          value: { actorLabel },
          queueCommands: async (txn) => {
            await txn.hIncrBy(probeKey, 'revision', 1);
            await txn.hSet(probeKey, { updatedBy: actorLabel });
          },
        };
      },
    });

    // Out-of-band top-level write after watch() dirties the watched key on a separate connection so exec() aborts.
    const conflictCycle = await runAtomicRedisTransaction({
      redis: redisClient,
      watchedKeys: [probeKey],
      readAfterWatch: () => redisClient.hGetAll(probeKey),
      beforeMultiHook: async () => {
        await redisClient.hSet(probeKey, {
          contendedTouch: new Date().toISOString(),
        });
      },
      planTransaction: (rawState) => {
        const previousRevision = parseNonNegativeRevision(rawState.revision);
        return {
          kind: 'commit',
          previousRevision,
          expectedCmdCount: 1,
          revisionReplyIndex: 0,
          value: { attemptedRevision: previousRevision + 1 },
          queueCommands: async (txn) => {
            await txn.hIncrBy(probeKey, 'revision', 1);
          },
        };
      },
    });

    const earlyExitCycle = await runAtomicRedisTransaction({
      redis: redisClient,
      watchedKeys: [probeKey],
      readAfterWatch: () => redisClient.hGetAll(probeKey),
      planTransaction: () => ({
        kind: 'abort' as const,
        reason: 'early_validation_guard_probe' as const,
      }),
    });

    const finalState = await redisClient.hGetAll(probeKey);
    const finalRevision = parseNonNegativeRevision(finalState.revision);
    const probePassed =
      commitCycle.committed &&
      !conflictCycle.committed &&
      conflictCycle.status === 'conflict' &&
      !earlyExitCycle.committed &&
      earlyExitCycle.status === 'aborted' &&
      finalRevision === commitCycle.revision;

    const receipt = {
      event: 'gate.probe_tx_receipt',
      probeKey,
      probePassed,
      finalRevision,
      subredditName: context.subredditName ?? null,
      postId: context.postId ?? null,
      commitCycle,
      conflictCycle,
      earlyExitCycle,
    };

    console.info(JSON.stringify(receipt));

    return c.json<UiResponse>(
      {
        showToast: `Probe tx rev=${finalRevision} conflict=${conflictCycle.status}`,
      },
      200,
    );
  });

  const ensureDailyPostSeeded = async (): Promise<
    | {
        readonly ok: true;
        readonly outcome: 'created' | 'skipped_already_created' | 'skipped_locked';
        readonly puzzleDate: string;
        readonly postId: string | null;
        readonly summaryCommentId: `t1_${string}` | null;
        readonly postDataBytes: number | null;
      }
    | {
        readonly ok: false;
        readonly puzzleDate: string;
        readonly error: string;
      }
  > => {
    const currentNow = nowMs();
    const runAtIso = new Date(currentNow).toISOString();
    const puzzleDate = runAtIso.slice(0, 10);
    const subredditName = context.subredditName ?? 'lastspot';

    const priorStatus = await redisClient.hGetAll(CRON_STATUS_KEY);
    if (
      priorStatus.lastCreatedPuzzleDate === puzzleDate &&
      typeof priorStatus.lastPostId === 'string' &&
      priorStatus.lastPostId.length > 0
    ) {
      await redisClient.hSet(CRON_STATUS_KEY, {
        lastRunAtIso: runAtIso,
        lastStatus: 'skipped_already_created',
        lastPuzzleDate: puzzleDate,
      });
      return {
        ok: true,
        outcome: 'skipped_already_created',
        puzzleDate,
        postId: priorStatus.lastPostId,
        summaryCommentId: null,
        postDataBytes: null,
      };
    }

    const cronLockKey = buildCronLockKey(puzzleDate);
    const lockReply = await redisClient.set(cronLockKey, '1', {
      nx: true,
      expiration: new Date(Math.max(Date.now(), currentNow) + 120_000),
    });

    if (lockReply !== 'OK') {
      await redisClient.hSet(CRON_STATUS_KEY, {
        lastRunAtIso: runAtIso,
        lastStatus: 'skipped_locked',
        lastPuzzleDate: puzzleDate,
      });
      return {
        ok: true,
        outcome: 'skipped_locked',
        puzzleDate,
        postId: null,
        summaryCommentId: null,
        postDataBytes: null,
      };
    }

    try {
      const created = await createAndMaterializeSeededPost({
        redisClient,
        redditClient,
        subredditName,
        puzzleDate,
        seed: `d:${puzzleDate}`,
      });
      await redisClient.hSet(CRON_STATUS_KEY, {
        lastRunAtIso: runAtIso,
        lastStatus: 'created',
        lastPostId: created.postId,
        lastPuzzleDate: puzzleDate,
        lastCreatedPuzzleDate: puzzleDate,
        lastError: '',
      });
      return {
        ok: true,
        outcome: 'created',
        puzzleDate,
        postId: created.postId,
        summaryCommentId: created.summaryCommentId,
        postDataBytes: created.postDataBytes,
      };
    } catch (error) {
      await redisClient.del(cronLockKey);
      const message = error instanceof Error ? error.message : String(error);
      await redisClient.hSet(CRON_STATUS_KEY, {
        lastRunAtIso: runAtIso,
        lastStatus: 'failed',
        lastPuzzleDate: puzzleDate,
        lastError: message,
      });
      return {
        ok: false,
        puzzleDate,
        error: message,
      };
    }
  };

  router.post(TRIGGER_ENDPOINTS.onAppInstall, async (c) => {
    const payload = await readJsonRecord(c);
    const seeded = await ensureDailyPostSeeded();
    console.info(
      JSON.stringify({
        event: 'lifecycle.on_app_install',
        subredditName: context.subredditName ?? null,
        triggerType: typeof payload.type === 'string' ? payload.type : 'AppInstall',
        initialPostOutcome: seeded.ok ? seeded.outcome : 'failed',
        initialPostId: seeded.ok ? seeded.postId : null,
      }),
    );
    return c.json<TriggerResponse>(
      {
        status: 'success',
        message: `Installed ${APP_NAME} in ${context.subredditName ?? 'subreddit'}`,
      },
      200,
    );
  });

  router.post(TRIGGER_ENDPOINTS.onPostDelete, async (c) => {
    const payload = await readJsonRecord(c);
    const nestedDelete =
      payload.postDelete !== null &&
      typeof payload.postDelete === 'object' &&
      !Array.isArray(payload.postDelete)
        ? (payload.postDelete as Record<string, unknown>)
        : undefined;
    const deletedPostId =
      typeof payload.postId === 'string' && payload.postId.length > 0
        ? payload.postId
        : typeof nestedDelete?.postId === 'string' && nestedDelete.postId.length > 0
          ? nestedDelete.postId
          : (context.postId ?? undefined);

    if (typeof deletedPostId === 'string' && deletedPostId.length > 0) {
      await redisClient.del(...buildPostScopedLotKeys(deletedPostId));
      summaryCache.delete(deletedPostId);
    }

    console.info(
      JSON.stringify({
        event: 'lifecycle.on_post_delete',
        postId: deletedPostId ?? null,
        subredditName: context.subredditName ?? null,
      }),
    );

    return c.json<TriggerResponse>(
      {
        status: 'success',
        message: 'Cleaned up post-scoped state',
      },
      200,
    );
  });

  router.post(SCHEDULER_TASKS.dailyPost.endpoint, async (c) => {
    await readJsonRecord(c);
    const seeded = await ensureDailyPostSeeded();
    if (seeded.ok) {
      console.info(
        JSON.stringify({
          event: 'scheduler.daily_post_tick',
          task: SCHEDULER_TASKS.dailyPost.name,
          outcome: seeded.outcome,
          puzzleDate: seeded.puzzleDate,
          postId: seeded.postId,
          summaryCommentId: seeded.summaryCommentId,
          postDataBytes: seeded.postDataBytes,
          subredditName: context.subredditName ?? null,
        }),
      );
      return c.json(
        {
          status: 'ok',
          task: SCHEDULER_TASKS.dailyPost.name,
          outcome: seeded.outcome,
          postId: seeded.postId,
          summaryCommentId: seeded.summaryCommentId,
          puzzleDate: seeded.puzzleDate,
        },
        200,
      );
    }

    console.error(
      JSON.stringify({
        event: 'scheduler.daily_post_failed',
        task: SCHEDULER_TASKS.dailyPost.name,
        puzzleDate: seeded.puzzleDate,
        error: seeded.error,
      }),
    );
    return c.json(
      {
        status: 'error',
        task: SCHEDULER_TASKS.dailyPost.name,
        outcome: 'failed',
        puzzleDate: seeded.puzzleDate,
        error: seeded.error,
      },
      500,
    );
  });

  return router;
}

export const app = createApp();
