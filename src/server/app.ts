import type { RedisClient } from '@devvit/redis';
import { context, reddit, redis } from '@devvit/web/server';
import type { TriggerResponse, UiResponse } from '@devvit/web/shared';
import { Hono, type Context as HonoContext } from 'hono';
import { z } from 'zod';
import {
  computeNextUserStreak,
  evaluatePlacement,
  generateSeededFloor,
  isPresetWindowNoteId,
  type LotSummaryResponse,
  MAX_FLOORS,
  type ParkedVehicle,
  type PlacementReceipt,
  type StoredFloorRecord,
  validatePlacementShape,
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
  buildFloorView,
  buildPostScopedLotKeys,
  buildUserStatsKey,
  ensurePostLotInitialized,
  extractPostSeedDefaults,
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

export interface AppDependencies {
  readonly redisClient?: RedisClient;
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
      return c.json({ ok: false, code: ERROR_CODES.loginRequiredForOfficialSpot }, 401);
    }

    const rawJsonResult = await readStrictJsonBody(c);
    if (!rawJsonResult.ok) {
      return c.json({ ok: false, code: ERROR_CODES.invalidParkPayload }, 400);
    }

    const parsedBodyResult = parkRequestSchema.safeParse(rawJsonResult.body);
    if (!parsedBodyResult.success) {
      return c.json({ ok: false, code: ERROR_CODES.invalidParkPayload }, 400);
    }

    const body = parsedBodyResult.data;
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
      return c.json(
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
    const safeWindowNoteId = isPresetWindowNoteId(body.windowNoteId) ? body.windowNoteId : null;
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
        return c.json(
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
          return c.json(
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
          return c.json({ ok: false, code: ERROR_CODES.invalidParkPayload }, 400);
        }
        const latest = await readLotStateSnapshot(redisClient, postId, userId, undefined, defaults);
        const conflictCode =
          txResult.reason === 'spot_taken'
            ? ERROR_CODES.spotTaken
            : ERROR_CODES.lotUpdatedRetryPreview;
        return c.json(
          { ok: false, code: conflictCode, latestLotState: latest.ok ? latest.state : null },
          409,
        );
      }

      if (attempt < MAX_BENIGN_PARK_RETRIES) {
        await sleepMs(retryDelayMs());
      }
    }

    const latest = await readLotStateSnapshot(redisClient, postId, userId, undefined, defaults);
    return c.json(
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

  router.post(MENU_ENDPOINTS.postCreate, async (c) => {
    try {
      const post = await reddit.submitCustomPost({
        title: 'Last Spot — Community Valet Shift',
      });
      const subredditName = context.subredditName ?? 'reddit';
      console.info(
        JSON.stringify({
          event: 'ops.menu_post_create',
          postId: post.id,
          subredditName,
        }),
      );
      return c.json<UiResponse>(
        {
          navigateTo: `https://reddit.com/r/${subredditName}/comments/${post.id}`,
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
    const pingCount = await redisClient.exists('ops:health:ping');
    const subredditLabel = context.subredditName ?? 'unknown';
    console.info(
      JSON.stringify({
        event: 'ops.health_check',
        ok: true,
        pingCount,
        subredditName: context.subredditName ?? null,
        postId: context.postId ?? null,
        userId: context.userId ?? null,
      }),
    );
    return c.json<UiResponse>(
      {
        showToast: `Last Spot healthy in r/${subredditLabel}`,
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

  router.post(TRIGGER_ENDPOINTS.onAppInstall, async (c) => {
    const payload = await readJsonRecord(c);
    console.info(
      JSON.stringify({
        event: 'lifecycle.on_app_install',
        subredditName: context.subredditName ?? null,
        triggerType: typeof payload.type === 'string' ? payload.type : 'AppInstall',
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
    const deletedPostId =
      typeof payload.postId === 'string'
        ? payload.postId
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
    console.info(
      JSON.stringify({
        event: 'scheduler.daily_post_tick',
        task: SCHEDULER_TASKS.dailyPost.name,
        subredditName: context.subredditName ?? null,
      }),
    );
    return c.json(
      {
        status: 'ok',
        task: SCHEDULER_TASKS.dailyPost.name,
      },
      200,
    );
  });

  return router;
}

export const app = createApp();
