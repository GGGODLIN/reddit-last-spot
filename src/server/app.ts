import type { RedisClient } from '@devvit/redis';
import { context, reddit, redis } from '@devvit/web/server';
import type { TriggerResponse, UiResponse } from '@devvit/web/shared';
import { Hono, type Context as HonoContext } from 'hono';
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
import { runAtomicRedisTransaction } from './lib/redis-tx';

export interface AppDependencies {
  readonly redisClient?: RedisClient;
}

function parseNonNegativeRevision(rawValue: string | undefined): number {
  if (rawValue === undefined) {
    return 0;
  }
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function buildPostScopedLotKeys(postId: string): [string, string, string, string] {
  return [
    `post:${postId}:meta`,
    `post:${postId}:floors`,
    `post:${postId}:placements`,
    `post:${postId}:lb`,
  ];
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

export function createApp(deps: AppDependencies = {}): Hono {
  const redisClient = deps.redisClient ?? redis;
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
