import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Header } from '@devvit/shared-types/Header.js';
import { createDevvitTest } from '@devvit/test/server/vitest';
import { Context, context, redis, runWithContext } from '@devvit/web/server';
import { describe, expect, vi } from 'vitest';
import {
  ALL_INTERNAL_ENDPOINTS,
  API_ENDPOINTS,
  APP_NAME,
  CLIENT_ENTRYPOINTS,
  CLIENT_POST_DIR,
  ERROR_CODES,
  FORM_ENDPOINTS,
  FORM_IDS,
  MENU_ENDPOINTS,
  SCHEDULER_TASKS,
  SERVER_BUNDLE,
  TRIGGER_ENDPOINTS,
} from '../../shared/manifest-contract';
import { app, createApp } from '../app';
import { runAtomicRedisTransaction } from '../lib/redis-tx';
import { createConflictAwareRedisWrapper } from './helpers/conflict-redis-wrapper';

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CURRENT_DIR, '../../..');

interface ParsedDevvitManifest {
  $schema?: string;
  name: string;
  post: {
    dir: string;
    entrypoints: {
      default: { inline?: boolean; entry: string; height?: string };
      game: { entry: string };
    };
  };
  server: {
    dir: string;
    entry: string;
  };
  permissions: {
    redis?: boolean;
    reddit?: boolean | { enable?: boolean };
  };
  menu: {
    items: Array<{
      label: string;
      location: string | string[];
      forUserType?: string;
      endpoint: string;
    }>;
  };
  forms: Record<string, string>;
  triggers: Record<string, string>;
  scheduler: {
    tasks: Record<string, string | { endpoint: string; cron?: string }>;
  };
  scripts?: Record<string, string>;
}

function hasUndefinedKeySegment(keys: readonly string[]): boolean {
  return keys.some((key) => /(?:^|:)undefined(?::|$)/.test(key));
}

function extractManifestEndpoints(manifest: ParsedDevvitManifest): string[] {
  const menuEndpoints = manifest.menu.items.map((item) => item.endpoint);
  const formEndpoints = Object.values(manifest.forms);
  const triggerEndpoints = Object.values(manifest.triggers);
  const schedulerEndpoints = Object.values(manifest.scheduler.tasks).map(
    (task) => (typeof task === 'string' ? task : task.endpoint),
  );
  return [
    ...menuEndpoints,
    ...formEndpoints,
    ...triggerEndpoints,
    ...schedulerEndpoints,
  ];
}

const devvitTest = createDevvitTest({
  username: 'valet_mod',
  userId: 't2_valetmod',
  subredditName: 'lastspot_probe_sub',
  subredditId: 't5_lastspotprobe',
});

describe('Ticket 01 Gate — Devvit Manifest Bijection, Auth Guard, and Atomic Redis Tx Probe', () => {
  devvitTest(
    'enforces manifest schema validity, dual HTML entrypoints, zero publish scripts, and non-404 Hono route bijection',
    async () => {
      const manifestRaw = fs.readFileSync(
        path.join(REPO_ROOT, 'devvit.json'),
        'utf-8',
      );
      const manifest = JSON.parse(manifestRaw) as ParsedDevvitManifest;

      const schemaRaw = fs.readFileSync(
        path.join(
          REPO_ROOT,
          'node_modules/@devvit/shared-types/schemas/config-file.v1.json',
        ),
        'utf-8',
      );
      const schema = JSON.parse(schemaRaw) as {
        properties: Record<string, unknown>;
      };

      const allowedTopLevelKeys = new Set(Object.keys(schema.properties));
      for (const topKey of Object.keys(manifest)) {
        expect(allowedTopLevelKeys.has(topKey)).toBe(true);
      }

      const packageJson = JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'),
      ) as { license?: string; scripts?: Record<string, string> };
      expect(packageJson.license).toBe('Apache-2.0');
      expect(packageJson.scripts?.publish).toBeUndefined();
      const allScriptCommands = Object.values(packageJson.scripts ?? {}).join(
        '\n',
      );
      expect(allScriptCommands.includes('devvit publish')).toBe(false);

      expect(manifest.name).toBe(APP_NAME);
      expect(manifest.server).toEqual(SERVER_BUNDLE);
      expect(manifest.server.entry).toBe('index.cjs');
      expect(manifest.post.dir).toBe(CLIENT_POST_DIR);
      expect(manifest.post.entrypoints.default).toEqual(
        CLIENT_ENTRYPOINTS.default,
      );
      expect(manifest.post.entrypoints.game).toEqual(CLIENT_ENTRYPOINTS.game);
      expect(manifest.permissions.redis).toBe(true);
      expect(manifest.permissions.reddit).toEqual({ enable: true });

      const splashHtmlPath = path.join(
        REPO_ROOT,
        'src/client',
        manifest.post.entrypoints.default.entry,
      );
      const gameHtmlPath = path.join(
        REPO_ROOT,
        'src/client',
        manifest.post.entrypoints.game.entry,
      );
      expect(fs.existsSync(splashHtmlPath)).toBe(true);
      expect(fs.existsSync(gameHtmlPath)).toBe(true);
      expect(fs.readFileSync(splashHtmlPath, 'utf-8')).toContain('splash.tsx');
      expect(fs.readFileSync(gameHtmlPath, 'utf-8')).toContain('game.tsx');

      expect(manifest.forms[FORM_IDS.opsResetLotForm]).toBe(
        FORM_ENDPOINTS.opsResetLotForm,
      );
      expect(manifest.triggers.onAppInstall).toBe(
        TRIGGER_ENDPOINTS.onAppInstall,
      );
      expect(manifest.triggers.onPostDelete).toBe(
        TRIGGER_ENDPOINTS.onPostDelete,
      );
      expect(manifest.scheduler.tasks[SCHEDULER_TASKS.dailyPost.name]).toEqual({
        endpoint: SCHEDULER_TASKS.dailyPost.endpoint,
        cron: SCHEDULER_TASKS.dailyPost.cron,
      });

      const manifestEndpoints = extractManifestEndpoints(manifest);
      expect(manifestEndpoints).toHaveLength(8);
      expect([...manifestEndpoints].sort()).toEqual(
        [...ALL_INTERNAL_ENDPOINTS].sort(),
      );

      for (const endpoint of manifestEndpoints) {
        expect(endpoint.startsWith('/internal/')).toBe(true);
        const response = await app.request(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });

        expect(
          response.status,
          `Expected mounted non-404 route for ${endpoint}`,
        ).not.toBe(404);
        expect(response.status).toBe(200);

        const body = (await response.json()) as Record<string, unknown>;
        if (endpoint === MENU_ENDPOINTS.postCreate) {
          expect(typeof body.navigateTo).toBe('string');
          expect(String(body.navigateTo)).toContain('lastspot_probe_sub');
        } else if (endpoint === MENU_ENDPOINTS.opsResetLot) {
          expect(body.showForm).toEqual(
            expect.objectContaining({ name: FORM_IDS.opsResetLotForm }),
          );
        } else if (
          endpoint === MENU_ENDPOINTS.opsHealth ||
          endpoint === MENU_ENDPOINTS.probeTx ||
          endpoint === FORM_ENDPOINTS.opsResetLotForm
        ) {
          expect(typeof body.showToast).toBe('string');
        } else if (
          endpoint === TRIGGER_ENDPOINTS.onAppInstall ||
          endpoint === TRIGGER_ENDPOINTS.onPostDelete
        ) {
          expect(body.status).toBe('success');
        } else if (endpoint === SCHEDULER_TASKS.dailyPost.endpoint) {
          expect(body).toEqual(
            expect.objectContaining({
              status: 'ok',
              task: SCHEDULER_TASKS.dailyPost.name,
            }),
          );
        }
      }
    },
  );

  devvitTest(
    'guards POST /api/probe-write-guard with 401 LOGIN_REQUIRED_FOR_OFFICIAL_SPOT when context.userId is undefined and writes zero undefined Redis keys',
    async ({ headers }) => {
      // Without calibrating the negative matcher first, a broken regex could pass vacuously forever.
      expect(hasUndefinedKeySegment(['probe:write-guard:undefined'])).toBe(
        true,
      );
      expect(hasUndefinedKeySegment(['probe:write-guard:t2_valetmod'])).toBe(
        false,
      );

      const wrapper = createConflictAwareRedisWrapper(redis);
      const guardedApp = createApp({ redisClient: wrapper.client });

      await wrapper.client.hSet('probe:write-guard:baseline', {
        status: 'intact',
      });
      wrapper.clearRecordedWrites();

      const authedResponse = await guardedApp.request(
        API_ENDPOINTS.probeWriteGuard,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        },
      );
      expect(authedResponse.status).toBe(200);
      const authedJson = (await authedResponse.json()) as Record<
        string,
        unknown
      >;
      expect(authedJson).toEqual({
        ok: true,
        userId: 't2_valetmod',
        key: 'probe:write-guard:t2_valetmod',
      });
      expect(wrapper.writtenKeys).toEqual(['probe:write-guard:t2_valetmod']);
      const persistedAuthed = await redis.hGetAll(
        'probe:write-guard:t2_valetmod',
      );
      expect(persistedAuthed.userId).toBe('t2_valetmod');

      wrapper.clearRecordedWrites();

      // createDevvitTest defaults userId to t2_testuser unless user headers are stripped from Context.
      const loggedOutHeaders: Record<string, string> = {};
      for (const [headerName, headerValue] of Object.entries(headers)) {
        if (
          headerValue !== undefined &&
          headerName !== Header.User &&
          headerName !== Header.Username &&
          headerName !== Header.AppUser
        ) {
          loggedOutHeaders[headerName] = headerValue;
        }
      }
      const loggedOutContext = Context(loggedOutHeaders);
      expect(loggedOutContext.userId).toBeUndefined();

      const unauthedResponse = await runWithContext(
        loggedOutContext,
        async () => {
          expect(context.userId).toBeUndefined();
          return await guardedApp.request(API_ENDPOINTS.probeWriteGuard, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
        },
      );

      expect(unauthedResponse.status).toBe(401);
      const unauthedJson = await unauthedResponse.json();
      expect(unauthedJson).toEqual({
        ok: false,
        code: ERROR_CODES.loginRequiredForOfficialSpot,
      });
      expect(wrapper.writtenKeys).toEqual([]);
      expect(hasUndefinedKeySegment(wrapper.writtenKeys)).toBe(false);
      expect(await redis.exists('probe:write-guard:undefined')).toBe(0);
      expect(await redis.hGetAll('probe:write-guard:baseline')).toEqual({
        status: 'intact',
      });
    },
  );

  devvitTest(
    'executes /internal/menu/probe-tx commit, concurrent conflict, and early-exit unwatch cycles with structured gate.probe_tx_receipt',
    async () => {
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const wrapper = createConflictAwareRedisWrapper(redis);
      const probeApp = createApp({ redisClient: wrapper.client });

      const response = await probeApp.request(MENU_ENDPOINTS.probeTx, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      expect(response.status).toBe(200);
      const uiBody = (await response.json()) as { showToast?: string };
      expect(uiBody.showToast).toContain('rev=1');

      expect(wrapper.telemetry.txnGetCalls).toBe(0);
      expect(wrapper.telemetry.topLevelReadCalls).toBeGreaterThanOrEqual(3);
      expect(wrapper.telemetry.unwatchCalls).toBe(1);

      const receiptPayloads = infoSpy.mock.calls
        .map((call) => {
          const firstArg = call[0];
          if (typeof firstArg !== 'string') return null;
          try {
            return JSON.parse(firstArg) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter(
          (entry): entry is Record<string, unknown> =>
            entry !== null && entry.event === 'gate.probe_tx_receipt',
        );

      expect(receiptPayloads).toHaveLength(1);
      const receipt = receiptPayloads[0]!;
      expect(receipt.probePassed).toBe(true);
      expect(receipt.finalRevision).toBe(1);
      expect(receipt.commitCycle).toEqual(
        expect.objectContaining({
          status: 'committed',
          committed: true,
          previousRevision: 0,
          revision: 1,
          replyCount: 2,
          expectedCmdCount: 2,
        }),
      );
      expect(receipt.conflictCycle).toEqual(
        expect.objectContaining({
          status: 'conflict',
          committed: false,
          previousRevision: 1,
          replyCount: 0,
          expectedCmdCount: 1,
          reason: 'empty_or_short_exec_reply',
        }),
      );
      expect(receipt.earlyExitCycle).toEqual(
        expect.objectContaining({
          status: 'aborted',
          committed: false,
          cleanup: 'unwatch',
        }),
      );
    },
  );

  devvitTest(
    'releases transaction slots via discard() when exec() throws and rejects empty or mismatched revision replies without ghost-committing',
    async () => {
      const wrapper = createConflictAwareRedisWrapper(redis);
      const probeKey = 'probe:tx:unit-faults';
      await wrapper.client.hSet(probeKey, { revision: '4', label: 'seeded' });

      wrapper.injectNextExecFault('throw_error');
      const thrownOutcome = await runAtomicRedisTransaction({
        redis: wrapper.client,
        watchedKeys: [probeKey],
        readAfterWatch: () => wrapper.client.hGetAll(probeKey),
        planTransaction: (raw) => {
          const prevRev = Number(raw.revision ?? '0');
          return {
            kind: 'commit',
            previousRevision: prevRev,
            expectedCmdCount: 1,
            revisionReplyIndex: 0,
            value: { nextRevision: prevRev + 1 },
            queueCommands: async (txn) => {
              await txn.hIncrBy(probeKey, 'revision', 1);
            },
          };
        },
      });

      expect(thrownOutcome).toEqual(
        expect.objectContaining({
          status: 'conflict',
          committed: false,
          previousRevision: 4,
          replyCount: 0,
          expectedCmdCount: 1,
          cleanup: 'discard',
          reason: 'exec_threw',
        }),
      );
      expect(wrapper.telemetry.discardCalls).toBe(1);
      expect((await redis.hGetAll(probeKey)).revision).toBe('4');

      wrapper.injectNextExecFault('corrupt_revision');
      const corruptOutcome = await runAtomicRedisTransaction({
        redis: wrapper.client,
        watchedKeys: [probeKey],
        readAfterWatch: () => wrapper.client.hGetAll(probeKey),
        planTransaction: (raw) => {
          const prevRev = Number(raw.revision ?? '0');
          return {
            kind: 'commit',
            previousRevision: prevRev,
            expectedCmdCount: 1,
            revisionReplyIndex: 0,
            value: { nextRevision: prevRev + 1 },
            queueCommands: async (txn) => {
              await txn.hIncrBy(probeKey, 'revision', 1);
            },
          };
        },
      });

      expect(corruptOutcome).toEqual({
        status: 'conflict',
        committed: false,
        previousRevision: 4,
        replyCount: 1,
        expectedCmdCount: 1,
        cleanup: 'none',
        reason: 'revision_mismatch',
      });
      expect((await redis.hGetAll(probeKey)).revision).toBe('4');

      const cleanOutcome = await runAtomicRedisTransaction({
        redis: wrapper.client,
        watchedKeys: [probeKey],
        readAfterWatch: () => wrapper.client.hGetAll(probeKey),
        planTransaction: (raw) => {
          const prevRev = Number(raw.revision ?? '0');
          return {
            kind: 'commit',
            previousRevision: prevRev,
            expectedCmdCount: 1,
            revisionReplyIndex: 0,
            value: { nextRevision: prevRev + 1 },
            queueCommands: async (txn) => {
              await txn.hIncrBy(probeKey, 'revision', 1);
            },
          };
        },
      });

      expect(cleanOutcome).toEqual({
        status: 'committed',
        committed: true,
        previousRevision: 4,
        revision: 5,
        replyCount: 1,
        expectedCmdCount: 1,
        cleanup: 'none',
        value: { nextRevision: 5 },
      });
      expect((await redis.hGetAll(probeKey)).revision).toBe('5');
      expect(wrapper.telemetry.txnGetCalls).toBe(0);
    },
  );
});
