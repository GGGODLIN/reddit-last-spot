import { Header } from '@devvit/shared-types/Header.js';
import { createDevvitTest } from '@devvit/test/server/vitest';
import {
  Context,
  context,
  EntrypointHeight,
  redis,
  runWithContext as devvitRunWithContext,
} from '@devvit/web/server';
import { describe, expect, vi } from 'vitest';
import {
  computeStandardStallCapacity,
  evaluatePlacement,
  listValidPlacements,
  type LotStateResponse,
  type LotSummaryResponse,
  type PlacementReceipt,
  type StoredFloorRecord,
  WINDOW_NOTE_LABELS,
} from '../../shared/domain';
import {
  API_ENDPOINTS,
  ERROR_CODES,
  FORM_ENDPOINTS,
  MENU_ENDPOINTS,
  SCHEDULER_TASKS,
  TRIGGER_ENDPOINTS,
} from '../../shared/manifest-contract';
import {
  buildPostScopedLotKeys,
  createApp,
  type RedditApiAdapter,
} from '../app';
import { createConflictAwareRedisWrapper } from './helpers/conflict-redis-wrapper';

function createFakeRedditAdapter(options: {
  shouldFailPostCreate?: () => Error | null;
  shouldFailCommentSubmit?: (targetId: string) => Error | null;
  shouldFailDistinguish?: () => Error | null;
} = {}) {
  const submittedPosts: Array<{
    readonly options: Parameters<RedditApiAdapter['submitCustomPost']>[0];
    readonly postId: `t3_${string}`;
  }> = [];
  const submittedComments: Array<{
    readonly id: `t1_${string}` | `t3_${string}`;
    readonly text: string;
    readonly runAs?: 'USER' | 'APP';
    readonly commentId: `t1_${string}`;
    distinguishedSticky: boolean;
  }> = [];
  let postCounter = 0;
  let commentCounter = 0;

  const adapter: RedditApiAdapter = {
    async submitCustomPost(postOptions) {
      const err = options.shouldFailPostCreate?.() ?? null;
      if (err !== null) {
        throw err;
      }
      postCounter += 1;
      const postId = `t3_created_post_${postCounter}` as const;
      submittedPosts.push({ options: postOptions, postId });
      return { id: postId };
    },
    async submitComment(commentOptions) {
      const err = options.shouldFailCommentSubmit?.(commentOptions.id) ?? null;
      if (err !== null) {
        throw err;
      }
      commentCounter += 1;
      const commentId = `t1_created_comment_${commentCounter}` as const;
      const record = {
        id: commentOptions.id,
        text: commentOptions.text,
        runAs: commentOptions.runAs,
        commentId,
        distinguishedSticky: false,
      };
      submittedComments.push(record);
      return {
        id: commentId,
        async distinguish(makeSticky?: boolean) {
          const distErr = options.shouldFailDistinguish?.() ?? null;
          if (distErr !== null) {
            throw distErr;
          }
          record.distinguishedSticky = makeSticky === true;
        },
      };
    },
  };

  return { adapter, submittedPosts, submittedComments };
}

function buildTestContext(
  baseHeaders: Record<string, string | undefined>,
  options: {
    postId?: `t3_${string}` | null;
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

  if (options.postId === null) {
    delete merged[Header.Post];
  } else if (options.postId !== undefined) {
    merged[Header.Post] = options.postId;
  }

  if (options.userId === null) {
    delete merged[Header.User];
    delete merged[Header.Username];
    delete merged[Header.AppUser];
    delete merged[Header.UserSnoovatarUrl];
  } else {
    if (options.userId !== undefined) merged[Header.User] = options.userId;
    if (options.username !== undefined && options.username !== null) {
      merged[Header.Username] = options.username;
    }
    if (options.snoovatar !== undefined && options.snoovatar !== null) {
      merged[Header.UserSnoovatarUrl] = options.snoovatar;
    }
  }

  if (options.postData !== undefined) {
    merged[Header.PostData] = JSON.stringify({ developerData: options.postData });
  }
  return Context(merged);
}

function parseStructuredSpyEvents(
  spy: { mock: { calls: unknown[][] } },
  eventName: string,
): Array<Record<string, unknown>> {
  const matches: Array<Record<string, unknown>> = [];
  for (const call of spy.mock.calls) {
    const raw = call[0];
    if (typeof raw !== 'string' || raw.includes('\n')) continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.event === eventName) {
        matches.push(parsed);
      }
    } catch {
      // Ignore non-JSON log lines from third-party libraries.
    }
  }
  return matches;
}

function containsLeakedCoordinates(text: string, cells: readonly number[]): boolean {
  const withoutDates = text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '');
  for (const cell of cells) {
    const tokenPattern = new RegExp(`(?:\\bcell\\s*#?\\s*${cell}\\b|\\[\\s*${cell}\\s*,|,\\s*${cell}\\s*\\]|\\bidx\\s*${cell}\\b)`, 'i');
    if (tokenPattern.test(withoutDates)) return true;
    if (cell >= 14 && new RegExp(`\\b${cell}\\b`).test(withoutDates)) return true;
  }
  return false;
}

const devvitTest = createDevvitTest({
  username: 'ops_mod',
  userId: 't2_opsmod',
  subredditName: 'lastspot_ops_sub',
  subredditId: 't5_lastspotops',
});

describe('Ticket 03 — Battle Reports, Journeys Anti-Corruption Adapter, and Moderator Ops Diagnostics', () => {
  devvitTest(
    'materializes Floor 1, TALL 8-digit styles, < 256B postData, and stickied Daily Lot Log on post-create & daily-post scheduler with nx lock and cron_status persistence without context.postId',
    async ({ headers }) => {
      let failDistinguishOnce = true;
      let failPostCreate = false;
      const fakeReddit = createFakeRedditAdapter({
        shouldFailPostCreate: () => (failPostCreate ? new Error('Upstream post submit outage') : null),
        shouldFailDistinguish: () =>
          failDistinguishOnce ? new Error('Playtest non-mod sticky denied') : null,
      });

      let clockMs = Date.parse('2026-11-18T08:00:00.000Z');
      const wrapper = createConflictAwareRedisWrapper(redis);
      const testApp = createApp({
        redisClient: wrapper.client,
        redditClient: fakeReddit.adapter,
        nowMs: () => clockMs,
      });

      // 1. Manual moderator post creation survives non-mod distinguish error, configures TALL + 8-digit colors + <256B postData, and materializes Floor 1 + summaryCommentId.
      const modCtx = buildTestContext(headers, { postId: null, userId: 't2_opsmod', username: 'ops_mod' });
      const createRes = await devvitRunWithContext(modCtx, async () => {
        return await testApp.request(MENU_ENDPOINTS.postCreate, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
      });
      expect(createRes.status).toBe(200);
      const createUi = (await createRes.json()) as { navigateTo?: string };
      expect(createUi.navigateTo).toBe('https://reddit.com/r/lastspot_ops_sub/comments/t3_created_post_1');

      expect(fakeReddit.submittedPosts).toHaveLength(1);
      const firstPostCall = fakeReddit.submittedPosts[0]!;
      expect(firstPostCall.options.entry).toBe('default');
      expect(firstPostCall.options.styles).toEqual(
        expect.objectContaining({
          height: EntrypointHeight.TALL,
          backgroundColor: '#F8FAFCFF',
          backgroundColorDark: '#090D16FF',
        }),
      );

      const postDataJson = JSON.stringify(firstPostCall.options.postData);
      const postDataBytes = Buffer.byteLength(postDataJson, 'utf8');
      expect(postDataBytes).toBeGreaterThan(40);
      expect(postDataBytes).toBeLessThan(256);
      expect(firstPostCall.options.postData).toEqual(
        expect.objectContaining({
          schemaVersion: 1,
          puzzleDate: '2026-11-18',
          gridCols: 6,
          gridRows: 6,
          activeFloor: 1,
        }),
      );

      const [modMetaKey, modFloorsKey] = buildPostScopedLotKeys('t3_created_post_1');
      const modMeta = await redis.hGetAll(modMetaKey);
      expect(modMeta.summaryCommentId).toBe('t1_created_comment_1');
      expect(modMeta.puzzleDate).toBe('2026-11-18');
      expect(modMeta.activeFloor).toBe('1');
      const modFloor1 = JSON.parse((await redis.hGet(modFloorsKey, '1')) ?? '{}') as StoredFloorRecord;
      expect(modFloor1.floorNumber).toBe(1);
      expect(modFloor1.status).toBe('LIVE');
      expect(modFloor1.remainingStalls).toBeGreaterThanOrEqual(6);
      expect(modFloor1.obstacles.length).toBeGreaterThan(0);

      // 2. Daily scheduler runs with context.postId === undefined, distinguishes sticky comment, guards re-entry via nx lock, and persists s1:ops:cron_status.
      failDistinguishOnce = false;
      const schedulerCtx = buildTestContext(headers, { postId: null, userId: null });
      const cronRes1 = await devvitRunWithContext(schedulerCtx, async () => {
        expect(context.postId).toBeUndefined();
        return await testApp.request(SCHEDULER_TASKS.dailyPost.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
      });
      expect(cronRes1.status).toBe(200);
      const cronBody1 = (await cronRes1.json()) as Record<string, unknown>;
      expect(cronBody1).toEqual(
        expect.objectContaining({
          status: 'ok',
          task: SCHEDULER_TASKS.dailyPost.name,
          postId: 't3_created_post_2',
          puzzleDate: '2026-11-18',
        }),
      );
      expect(fakeReddit.submittedPosts).toHaveLength(2);
      expect(fakeReddit.submittedComments[1]?.distinguishedSticky).toBe(true);

      const cronStatusAfterCreate = await redis.hGetAll('s1:ops:cron_status');
      expect(cronStatusAfterCreate).toEqual(
        expect.objectContaining({
          lastStatus: 'created',
          lastPostId: 't3_created_post_2',
          lastPuzzleDate: '2026-11-18',
          lastRunAtIso: '2026-11-18T08:00:00.000Z',
        }),
      );

      // Duplicate tick on the same puzzleDate is idempotently skipped without creating a third post.
      clockMs += 5_000;
      const cronResDup = await devvitRunWithContext(schedulerCtx, async () => {
        return await testApp.request(SCHEDULER_TASKS.dailyPost.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
      });
      expect(cronResDup.status).toBe(200);
      expect(fakeReddit.submittedPosts).toHaveLength(2);

      // Next-day nx lock pre-held skips re-entry cleanly and records lock skip in cron_status.
      clockMs = Date.parse('2026-11-19T00:00:00.000Z');
      await redis.set('s1:ops:cron_lock:2026-11-19', '1', {
        nx: true,
        expiration: new Date(Date.now() + 60_000),
      });
      const cronResLocked = await devvitRunWithContext(schedulerCtx, async () => {
        return await testApp.request(SCHEDULER_TASKS.dailyPost.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
      });
      expect(cronResLocked.status).toBe(200);
      expect(fakeReddit.submittedPosts).toHaveLength(2);
      expect((await redis.hGetAll('s1:ops:cron_status')).lastStatus).toContain('skipped');

      // Failure on a subsequent unlocked day still persists lastStatus/lastError in s1:ops:cron_status and releases nx lock.
      clockMs = Date.parse('2026-11-20T00:00:00.000Z');
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      failPostCreate = true;
      const cronResFail = await devvitRunWithContext(schedulerCtx, async () => {
        return await testApp.request(SCHEDULER_TASKS.dailyPost.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
      });
      errSpy.mockRestore();
      expect(cronResFail.status).toBeGreaterThanOrEqual(400);
      const cronStatusAfterFail = await redis.hGetAll('s1:ops:cron_status');
      expect(cronStatusAfterFail.lastStatus).toBe('failed');
      expect(cronStatusAfterFail.lastPuzzleDate).toBe('2026-11-20');
      expect(cronStatusAfterFail.lastError).toContain('Upstream post submit outage');
      expect(await redis.exists('s1:ops:cron_lock:2026-11-20')).toBe(0);
    },
  );

  devvitTest(
    'formats spoiler-safe Battle Reports on POST /api/share-comment from authoritative placements, enforces preset windowNoteId, suppresses duplicates via hSetNX, and releases pending lock with clipboard fallback on 429',
    async ({ headers }) => {
      // Calibrate spoiler coordinate detector with positive control before negative assertion.
      expect(containsLeakedCoordinates('Parked at [27, 28]', [27, 28])).toBe(true);
      expect(containsLeakedCoordinates('Report (2026-11-18) Floor B1 | 2x1 Sedan | Wasted Stalls: 0 | Shift Score: 108', [27, 28])).toBe(
        false,
      );

      let rateLimitCommentSubmit = false;
      const fakeReddit = createFakeRedditAdapter({
        shouldFailCommentSubmit: (targetId) =>
          rateLimitCommentSubmit && targetId === 't1_sticky_log_99'
            ? new Error('429 Too Many Requests: RATELIMIT')
            : null,
      });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const wrapper = createConflictAwareRedisWrapper(redis);
      const testApp = createApp({
        redisClient: wrapper.client,
        redditClient: fakeReddit.adapter,
      });

      const postId = 't3_share_report_post';
      // Construct a tight 1-stall floor where cells [27, 28] crown Last Spot Hero cleanly.
      const obstacles = Array.from({ length: 36 }, (_, cell) => cell)
        .filter((cell) => cell !== 27 && cell !== 28)
        .map((cell) => ({ cell, kind: 'pillar' as const }));
      const [metaKey, floorsKey] = buildPostScopedLotKeys(postId);
      await redis.hSet(metaKey, {
        schemaVersion: '1',
        puzzleDate: '2026-11-18',
        seed: 'seed-share-hero',
        gridCols: '6',
        gridRows: '6',
        activeFloor: '1',
        floorCount: '1',
        revision: '0',
        summaryCommentId: 't1_sticky_log_99',
      });
      await redis.hSet(floorsKey, {
        '1': JSON.stringify({
          floorNumber: 1,
          seed: 'seed-share-hero:floor:1',
          elevatorCell: 0,
          obstacles,
          vehicles: [],
          remainingStalls: 1,
          status: 'LIVE',
          lastSpotHero: null,
        }),
      });

      // 1. Logged-out caller receives 401.
      const anonCtx = buildTestContext(headers, { postId, userId: null });
      const unauthedShare = await devvitRunWithContext(anonCtx, async () => {
        return await testApp.request(API_ENDPOINTS.shareComment, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ windowNoteId: 'clutch_park' }),
        });
      });
      expect(unauthedShare.status).toBe(401);
      expect(await unauthedShare.json()).toEqual({
        ok: false,
        code: ERROR_CODES.loginRequiredForOfficialSpot,
      });

      // 2. Authenticated caller without placement receives 404 PLACEMENT_NOT_FOUND; invalid/freeform windowNoteId receives 400 INVALID_WINDOW_NOTE.
      const playerCtx = buildTestContext(headers, {
        postId,
        userId: 't2_clutch_driver',
        username: 'clutch_driver',
      });

      for (const badNote of ['', 'freeform_injection_attempt', 'DROP TABLE']) {
        const badRes = await devvitRunWithContext(playerCtx, async () => {
          return await testApp.request(API_ENDPOINTS.shareComment, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ windowNoteId: badNote }),
          });
        });
        expect(badRes.status).toBe(400);
        expect(await badRes.json()).toEqual({
          ok: false,
          code: ERROR_CODES.invalidWindowNote,
        });
      }

      const missingPlacementRes = await devvitRunWithContext(playerCtx, async () => {
        return await testApp.request(API_ENDPOINTS.shareComment, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ windowNoteId: 'clutch_park' }),
        });
      });
      expect(missingPlacementRes.status).toBe(404);
      expect(await missingPlacementRes.json()).toEqual({
        ok: false,
        code: ERROR_CODES.placementNotFound,
      });

      // 3. Commit official placement at [27, 28] (crowns Last Spot Hero).
      const parkRes = await devvitRunWithContext(playerCtx, async () => {
        return await testApp.request(API_ENDPOINTS.park, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            floorNumber: 1,
            expectedRevision: 0,
            vehicleType: 'sedan_2x1',
            cells: [27, 28],
            clientPreview: { wastedStalls: 0, remainingStallsAfter: 0 },
          }),
        });
      });
      expect(parkRes.status).toBe(200);
      const parkJson = (await parkRes.json()) as { receipt: PlacementReceipt };
      expect(parkJson.receipt.crownedLastSpotHero).toBe(true);

      // 4. Simulate 429 rate-limit first: returns 200 with fellBackToClipboard: true, formattedReport intact, and releases 'pending' lock via hDel!
      rateLimitCommentSubmit = true;
      const fallbackRes = await devvitRunWithContext(playerCtx, async () => {
        return await testApp.request(API_ENDPOINTS.shareComment, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            windowNoteId: 'clutch_park',
            totalShiftScore: 999_999,
            wastedStalls: 99,
          }),
        });
      });
      expect(fallbackRes.status).toBe(200);
      const fallbackJson = (await fallbackRes.json()) as {
        ok: boolean;
        posted: boolean;
        alreadyShared: boolean;
        commentId: string | null;
        parentCommentId: string;
        fellBackToClipboard: boolean;
        fellBackToAppAccount: boolean;
        formattedReport: string;
      };
      expect(fallbackJson).toEqual(
        expect.objectContaining({
          ok: true,
          posted: false,
          alreadyShared: false,
          commentId: null,
          parentCommentId: 't1_sticky_log_99',
          fellBackToClipboard: true,
          fellBackToAppAccount: true,
        }),
      );
      expect(fallbackJson.formattedReport).toContain('u/clutch_driver');
      expect(fallbackJson.formattedReport).toContain('B1');
      expect(fallbackJson.formattedReport).toContain('Last Spot Hero');
      expect(fallbackJson.formattedReport).toContain(WINDOW_NOTE_LABELS.clutch_park);
      expect(fallbackJson.formattedReport).toContain(String(parkJson.receipt.totalShiftScore));
      expect(fallbackJson.formattedReport.includes('999999')).toBe(false);
      expect(containsLeakedCoordinates(fallbackJson.formattedReport, [27, 28])).toBe(false);
      expect(await redis.hGet(metaKey, 'share:t2_clutch_driver')).toBeUndefined();

      // 5. Retry after 429 clears: succeeds under summaryCommentId, persists commentId, logs fellBackToAppAccount: true, and suppresses subsequent duplicate!
      rateLimitCommentSubmit = false;
      const successRes = await devvitRunWithContext(playerCtx, async () => {
        return await testApp.request(API_ENDPOINTS.shareComment, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            windowNoteId: 'clutch_park',
            totalShiftScore: 999_999,
          }),
        });
      });
      expect(successRes.status).toBe(200);
      const successJson = (await successRes.json()) as typeof fallbackJson;
      expect(successJson).toEqual({
        ok: true,
        posted: true,
        alreadyShared: false,
        commentId: 't1_created_comment_1',
        parentCommentId: 't1_sticky_log_99',
        fellBackToClipboard: false,
        fellBackToAppAccount: true,
        formattedReport: fallbackJson.formattedReport,
      });
      expect(fakeReddit.submittedComments).toHaveLength(1);
      expect(fakeReddit.submittedComments[0]).toEqual(
        expect.objectContaining({
          id: 't1_sticky_log_99',
          text: fallbackJson.formattedReport,
          runAs: 'APP',
        }),
      );

      const shareLogs = parseStructuredSpyEvents(infoSpy, 'lot.battle_report_shared');
      expect(shareLogs).toHaveLength(1);
      expect(shareLogs[0]).toEqual(
        expect.objectContaining({
          postId,
          userId: 't2_clutch_driver',
          commentId: 't1_created_comment_1',
          parentCommentId: 't1_sticky_log_99',
          fellBackToAppAccount: true,
        }),
      );

      // Duplicate submission is suppressed via hSetNX without calling submitComment a second time.
      const dupRes = await devvitRunWithContext(playerCtx, async () => {
        return await testApp.request(API_ENDPOINTS.shareComment, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ windowNoteId: 'clutch_park' }),
        });
      });
      expect(dupRes.status).toBe(200);
      const dupJson = (await dupRes.json()) as typeof fallbackJson;
      expect(dupJson).toEqual({
        ok: true,
        posted: true,
        alreadyShared: true,
        commentId: 't1_created_comment_1',
        parentCommentId: 't1_sticky_log_99',
        fellBackToClipboard: false,
        fellBackToAppAccount: true,
        formattedReport: fallbackJson.formattedReport,
      });
      expect(fakeReddit.submittedComments).toHaveLength(1);

      infoSpy.mockRestore();
      warnSpy.mockRestore();
    },
  );

  devvitTest(
    'forwards Journeys lifecycle events via Express-free Hono routes, treats DENIED_PLAYTEST and DENIED_NOT_ALLOWLISTED as non-blocking 200 responses, and logs malformed receipt warnings',
    async ({ headers }) => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const forwardedSteps: string[] = [];

      const testApp = createApp({
        journeyTelemetrySink: async (evt) => {
          forwardedSteps.push(evt.step);
          if (evt.step === 'playtest_step') return { receiptStatus: 'DENIED_PLAYTEST' };
          if (evt.step === 'unallowlisted_step') return { receiptStatus: 'DENIED_NOT_ALLOWLISTED' };
          return { receiptStatus: evt.receiptStatus ?? 'RECORDED' };
        },
      });

      const postId = 't3_telemetry_post';
      const playerCtx = buildTestContext(headers, {
        postId,
        userId: 't2_telemetry_driver',
        username: 'telemetry_driver',
        postData: { puzzleDate: '2026-11-18', seed: 'seed-telemetry-01' },
      });

      // 1. Valid lifecycle events on root and wildcard subroute succeed with 200.
      const okRootRes = await devvitRunWithContext(playerCtx, async () => {
        return await testApp.request(API_ENDPOINTS.journeyTelemetry, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ step: 'shift_started', postId, mode: 'OFFICIAL_LIVE' }),
        });
      });
      expect(okRootRes.status).toBe(200);
      expect(await okRootRes.json()).toEqual(
        expect.objectContaining({
          ok: true,
          accepted: true,
          receiptStatus: 'RECORDED',
        }),
      );

      const okSubrouteRes = await devvitRunWithContext(playerCtx, async () => {
        return await testApp.request(`${API_ENDPOINTS.journeyTelemetry}/progress`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ step: 'warmup_bay_1_done', postId, mode: 'OFFICIAL_LIVE' }),
        });
      });
      expect(okSubrouteRes.status).toBe(200);
      expect(await okSubrouteRes.json()).toEqual(
        expect.objectContaining({
          ok: true,
          accepted: true,
          receiptStatus: 'RECORDED',
        }),
      );
      expect(forwardedSteps).toEqual(['shift_started', 'warmup_bay_1_done']);

      // 2. DENIED_PLAYTEST and DENIED_NOT_ALLOWLISTED (via sink or client receipt report) never return 4xx/5xx or block gameplay.
      for (const [step, deniedCode] of [
        ['playtest_step', 'DENIED_PLAYTEST'],
        ['unallowlisted_step', 'DENIED_NOT_ALLOWLISTED'],
        ['reported_playtest', 'DENIED_PLAYTEST'],
      ] as const) {
        const deniedRes = await devvitRunWithContext(playerCtx, async () => {
          return await testApp.request(API_ENDPOINTS.journeyTelemetry, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              step,
              postId,
              receiptStatus: step === 'reported_playtest' ? deniedCode : undefined,
            }),
          });
        });
        expect(deniedRes.status).toBe(200);
        expect(await deniedRes.json()).toEqual(
          expect.objectContaining({
            ok: true,
            accepted: false,
            receiptStatus: deniedCode,
          }),
        );
      }

      // Gameplay remains completely unblocked right after denied telemetry receipts.
      const lotStateRes = await devvitRunWithContext(playerCtx, async () => {
        return await testApp.request(API_ENDPOINTS.lotState);
      });
      expect(lotStateRes.status).toBe(200);
      const lotState = (await lotStateRes.json()) as LotStateResponse;
      expect(lotState.ok).toBe(true);
      expect(lotState.liveFloor.remainingStalls).toBeGreaterThanOrEqual(6);

      // 3. Malformed JSON and missing/blank step emit structured telemetry.journey_malformed_receipt warnings and still return 200 IGNORED_INVALID.
      const malformedJsonRes = await devvitRunWithContext(playerCtx, async () => {
        return await testApp.request(API_ENDPOINTS.journeyTelemetry, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{broken_json',
        });
      });
      expect(malformedJsonRes.status).toBe(200);
      expect(await malformedJsonRes.json()).toEqual({
        ok: true,
        accepted: false,
        receiptStatus: 'IGNORED_INVALID',
      });

      const missingStepRes = await devvitRunWithContext(playerCtx, async () => {
        return await testApp.request(`${API_ENDPOINTS.journeyTelemetry}/end`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ step: '   ', postId }),
        });
      });
      expect(missingStepRes.status).toBe(200);
      expect(await missingStepRes.json()).toEqual({
        ok: true,
        accepted: false,
        receiptStatus: 'IGNORED_INVALID',
      });

      const malformedLogs = parseStructuredSpyEvents(warnSpy, 'telemetry.journey_malformed_receipt');
      expect(malformedLogs.length).toBeGreaterThanOrEqual(2);

      warnSpy.mockRestore();
      infoSpy.mockRestore();
    },
  );

  devvitTest(
    'recomputes active-floor stall capacity in /internal/menu/ops-health emitting single-line ops.health_receipt JSON and isolates /internal/form/ops-reset-lot and onPostDelete to the target postId',
    async ({ headers }) => {
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const fakeReddit = createFakeRedditAdapter();
      const wrapper = createConflictAwareRedisWrapper(redis);
      const testApp = createApp({
        redisClient: wrapper.client,
        redditClient: fakeReddit.adapter,
        nowMs: () => Date.parse('2026-11-18T12:00:00.000Z'),
      });

      // Seed cron_status via a real scheduler tick first.
      const cronCtx = buildTestContext(headers, { postId: null, userId: null });
      await devvitRunWithContext(cronCtx, async () => {
        await testApp.request(SCHEDULER_TASKS.dailyPost.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
      });

      const postTarget = 't3_ops_target_post';
      const postSibling = 't3_ops_sibling_post';
      const postDeleted = 't3_ops_deleted_post';

      const seedPlayablePostWithParkAndShare = async (
        targetPostId: `t3_${string}`,
        driverId: `t2_${string}`,
        driverName: string,
        seedName: string,
      ) => {
        const postData = {
          schemaVersion: 1,
          puzzleDate: '2026-11-18',
          seed: seedName,
          gridCols: 6,
          gridRows: 6,
        };
        const ctx = buildTestContext(headers, {
          postId: targetPostId,
          userId: driverId,
          username: driverName,
          postData,
        });
        const stateRes = await devvitRunWithContext(ctx, async () => await testApp.request(API_ENDPOINTS.lotState));
        const state = (await stateRes.json()) as LotStateResponse;
        const occupied = new Set(state.liveFloor.occupiedCells);
        const cells = listValidPlacements(6, 6, occupied, 'sedan_2x1')[0]!;
        const evalMove = evaluatePlacement(6, 6, occupied, state.liveFloor.elevatorCell, 'sedan_2x1', cells);

        const parkRes = await devvitRunWithContext(ctx, async () => {
          return await testApp.request(API_ENDPOINTS.park, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              floorNumber: 1,
              expectedRevision: 0,
              vehicleType: 'sedan_2x1',
              cells,
              clientPreview: {
                wastedStalls: evalMove.wastedStalls,
                remainingStallsAfter: evalMove.remainingStallsAfter,
              },
            }),
          });
        });
        expect(parkRes.status).toBe(200);

        const shareRes = await devvitRunWithContext(ctx, async () => {
          return await testApp.request(API_ENDPOINTS.shareComment, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ windowNoteId: 'zero_waste' }),
          });
        });
        expect(shareRes.status).toBe(200);

        // Warm summaryCache for this post after parking.
        const sumRes = await devvitRunWithContext(ctx, async () => await testApp.request(API_ENDPOINTS.lotSummary));
        expect(sumRes.status).toBe(200);
        return { ctx, postData, summaryAfterPark: (await sumRes.json()) as LotSummaryResponse };
      };

      const targetSeeded = await seedPlayablePostWithParkAndShare(
        postTarget,
        't2_target_driver',
        'target_driver',
        'seed-ops-target',
      );
      const siblingSeeded = await seedPlayablePostWithParkAndShare(
        postSibling,
        't2_sibling_driver',
        'sibling_driver',
        'seed-ops-sibling',
      );
      await seedPlayablePostWithParkAndShare(
        postDeleted,
        't2_deleted_driver',
        'deleted_driver',
        'seed-ops-deleted',
      );

      // 1. /internal/menu/ops-health recomputes ν(G) on postTarget, checks postData < 2048 & cronStatus, and emits single-line ops.health_receipt JSON.
      infoSpy.mockClear();
      const healthRes = await devvitRunWithContext(targetSeeded.ctx, async () => {
        return await testApp.request(MENU_ENDPOINTS.opsHealth, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
      });
      expect(healthRes.status).toBe(200);
      const healthToast = (await healthRes.json()) as { showToast?: string };
      expect(typeof healthToast.showToast).toBe('string');

      const healthReceipts = parseStructuredSpyEvents(infoSpy, 'ops.health_receipt');
      expect(healthReceipts).toHaveLength(1);
      const [, targetFloorsKey] = buildPostScopedLotKeys(postTarget);
      const storedTargetFloor = JSON.parse((await redis.hGet(targetFloorsKey, '1')) ?? '{}') as StoredFloorRecord;
      const expectedOracleCap = computeStandardStallCapacity(6, 6, [
        ...storedTargetFloor.obstacles.map((o) => o.cell),
        ...storedTargetFloor.vehicles.flatMap((v) => v.cells),
      ]);
      expect(healthReceipts[0]).toEqual(
        expect.objectContaining({
          event: 'ops.health_receipt',
          ok: true,
          matchInvariantOk: true,
          postDataUnder2048: true,
          postId: postTarget,
          activeFloor: 1,
          revision: 1,
          remainingStalls: expectedOracleCap.remainingStalls,
          cronStatus: expect.objectContaining({
            lastStatus: 'created',
            lastPuzzleDate: '2026-11-18',
          }),
        }),
      );
      expect(Number(healthReceipts[0]!.postDataBytes)).toBeGreaterThan(10);
      expect(Number(healthReceipts[0]!.postDataBytes)).toBeLessThan(2048);

      // Calibrate matchInvariantOk sensitivity: corrupting storedFloor.remainingStalls makes matchInvariantOk === false!
      await redis.hSet(targetFloorsKey, {
        '1': JSON.stringify({
          ...storedTargetFloor,
          remainingStalls: expectedOracleCap.remainingStalls + 3,
        }),
      });
      infoSpy.mockClear();
      await devvitRunWithContext(targetSeeded.ctx, async () => {
        await testApp.request(MENU_ENDPOINTS.opsHealth, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
      });
      const corruptedReceipts = parseStructuredSpyEvents(infoSpy, 'ops.health_receipt');
      expect(corruptedReceipts).toHaveLength(1);
      expect(corruptedReceipts[0]!.matchInvariantOk).toBe(false);
      expect(corruptedReceipts[0]!.ok).toBe(false);

      // 2. Resetting postTarget via /internal/form/ops-reset-lot deletes ONLY postTarget's 4 canonical keys and evicts summaryCache, leaving postSibling untouched.
      const resetRes = await devvitRunWithContext(targetSeeded.ctx, async () => {
        return await testApp.request(FORM_ENDPOINTS.opsResetLotForm, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirmPhrase: 'RESET' }),
        });
      });
      expect(resetRes.status).toBe(200);
      expect(await redis.exists(...buildPostScopedLotKeys(postTarget))).toBe(0);

      // Re-reading lot-summary on postTarget immediately (within 5s cache window!) reflects fresh unparked Floor 1 because summaryCache was evicted.
      const freshTargetSummaryRes = await devvitRunWithContext(targetSeeded.ctx, async () => {
        return await testApp.request(API_ENDPOINTS.lotSummary);
      });
      const freshTargetSummary = (await freshTargetSummaryRes.json()) as LotSummaryResponse;
      expect(freshTargetSummary.occupiedCount).toBe(targetSeeded.summaryAfterPark.occupiedCount - 2);

      // 3. Deleting postDeleted via /internal/triggers/on-post-delete removes all 4 postDeleted keys while leaving postSibling completely intact.
      const deleteTriggerRes = await devvitRunWithContext(cronCtx, async () => {
        return await testApp.request(TRIGGER_ENDPOINTS.onPostDelete, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ postId: postDeleted }),
        });
      });
      expect(deleteTriggerRes.status).toBe(200);
      expect(await redis.exists(...buildPostScopedLotKeys(postDeleted))).toBe(0);

      // Verify postSibling retains all 4 canonical keys + committed receipt + share record!
      const [siblingMetaKey] = buildPostScopedLotKeys(postSibling);
      expect(await redis.exists(...buildPostScopedLotKeys(postSibling))).toBe(4);
      const siblingStateAfter = (await (
        await devvitRunWithContext(siblingSeeded.ctx, async () => await testApp.request(API_ENDPOINTS.lotState))
      ).json()) as LotStateResponse;
      expect(siblingStateAfter.revision).toBe(1);
      expect(siblingStateAfter.myPlacement?.username).toBe('sibling_driver');
      expect(await redis.hGet(siblingMetaKey, 'share:t2_sibling_driver')).toMatch(/^t1_/);

      infoSpy.mockRestore();
    },
  );
});
