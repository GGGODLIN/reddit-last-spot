import type { RedisClient, TxClientLike } from '@devvit/redis';

export type InjectedExecFault =
  | 'none'
  | 'empty_reply'
  | 'throw_error'
  | 'corrupt_revision';

export interface RedisWrapperTelemetry {
  watchCalls: number;
  multiCalls: number;
  execCalls: number;
  unwatchCalls: number;
  discardCalls: number;
  txnGetCalls: number;
  topLevelReadCalls: number;
}

const TOP_LEVEL_READ_METHODS = new Set<string>([
  'get',
  'getBuffer',
  'exists',
  'type',
  'getRange',
  'strLen',
  'mGet',
  'expireTime',
  'zCard',
  'zScore',
  'zRank',
  'zRange',
  'zScan',
  'hGet',
  'hMGet',
  'hGetAll',
  'hScan',
  'hKeys',
  'hLen',
]);

function extractKeysFromWriteCall(method: string, args: unknown[]): string[] {
  switch (method) {
    case 'set':
    case 'incrBy':
    case 'setRange':
    case 'expire':
    case 'zAdd':
    case 'zIncrBy':
    case 'zRem':
    case 'zRemRangeByLex':
    case 'zRemRangeByRank':
    case 'zRemRangeByScore':
    case 'hSet':
    case 'hSetNX':
    case 'hDel':
    case 'hIncrBy':
    case 'bitfield': {
      const first = args[0];
      return typeof first === 'string' ? [first] : [];
    }
    case 'rename': {
      return args.filter((item): item is string => typeof item === 'string');
    }
    case 'del': {
      return args.filter((item): item is string => typeof item === 'string');
    }
    case 'mSet': {
      const record = args[0];
      if (record !== null && typeof record === 'object') {
        return Object.keys(record);
      }
      return [];
    }
    default:
      return [];
  }
}

export function createConflictAwareRedisWrapper(baseRedis: RedisClient) {
  const keyVersions = new Map<string, number>();
  const writtenKeys: string[] = [];
  let nextExecFault: InjectedExecFault = 'none';

  const telemetry: RedisWrapperTelemetry = {
    watchCalls: 0,
    multiCalls: 0,
    execCalls: 0,
    unwatchCalls: 0,
    discardCalls: 0,
    txnGetCalls: 0,
    topLevelReadCalls: 0,
  };

  const bumpKeys = (keys: readonly string[]) => {
    for (const key of keys) {
      writtenKeys.push(key);
      keyVersions.set(key, (keyVersions.get(key) ?? 0) + 1);
    }
  };

  const wrapTxClient = (
    innerTxn: TxClientLike,
    initialWatchedKeys: readonly string[],
  ): TxClientLike => {
    const watchedSnapshots = new Map<string, number>();
    for (const key of initialWatchedKeys) {
      watchedSnapshots.set(key, keyVersions.get(key) ?? 0);
    }
    const queuedWriteKeys: string[] = [];

    const proxy: TxClientLike = new Proxy(innerTxn, {
      get(target, prop, receiver) {
        if (typeof prop !== 'string') {
          return Reflect.get(target, prop, receiver);
        }

        if (prop === 'watch') {
          return async (...keys: string[]) => {
            telemetry.watchCalls += 1;
            for (const key of keys) {
              watchedSnapshots.set(key, keyVersions.get(key) ?? 0);
            }
            await target.watch(...keys);
            return proxy;
          };
        }

        if (prop === 'unwatch') {
          return async () => {
            telemetry.unwatchCalls += 1;
            watchedSnapshots.clear();
            await target.unwatch();
            return proxy;
          };
        }

        if (prop === 'multi') {
          return async () => {
            telemetry.multiCalls += 1;
            await target.multi();
          };
        }

        if (prop === 'discard') {
          return async () => {
            telemetry.discardCalls += 1;
            watchedSnapshots.clear();
            queuedWriteKeys.length = 0;
            await target.discard();
          };
        }

        if (prop === 'get') {
          return async (key: string) => {
            telemetry.txnGetCalls += 1;
            await target.get(key);
            return proxy;
          };
        }

        if (prop === 'exec') {
          return async () => {
            telemetry.execCalls += 1;
            const fault = nextExecFault;
            nextExecFault = 'none';

            if (fault === 'throw_error') {
              // Leave innerTxn open so the caller's finally block must invoke discard().
              throw new Error('Simulated Redis EXEC transport failure');
            }

            if (fault === 'empty_reply') {
              await target.discard();
              watchedSnapshots.clear();
              queuedWriteKeys.length = 0;
              return [];
            }

            if (fault === 'corrupt_revision') {
              await target.discard();
              watchedSnapshots.clear();
              queuedWriteKeys.length = 0;
              return [0];
            }

            // RedisMock.Exec skips watched-key dirty checks; enforce real Redis WATCH semantics here.
            for (const [key, snapshotVersion] of watchedSnapshots.entries()) {
              const currentVersion = keyVersions.get(key) ?? 0;
              if (currentVersion !== snapshotVersion) {
                await target.discard();
                watchedSnapshots.clear();
                queuedWriteKeys.length = 0;
                return [];
              }
            }

            const replies = await target.exec();
            bumpKeys(queuedWriteKeys);
            watchedSnapshots.clear();
            queuedWriteKeys.length = 0;
            return replies;
          };
        }

        const original = Reflect.get(target, prop, target);
        if (typeof original !== 'function') {
          return original;
        }

        return async (...args: unknown[]) => {
          const mutated = extractKeysFromWriteCall(prop, args);
          queuedWriteKeys.push(...mutated);
          await (original as (...callArgs: unknown[]) => Promise<unknown>).apply(
            target,
            args,
          );
          return proxy;
        };
      },
    });

    return proxy;
  };

  const client: RedisClient = new Proxy(baseRedis, {
    get(target, prop, receiver) {
      if (typeof prop !== 'string') {
        return Reflect.get(target, prop, receiver);
      }

      if (prop === 'watch') {
        return async (...keys: string[]) => {
          telemetry.watchCalls += 1;
          const innerTxn = await target.watch(...keys);
          return wrapTxClient(innerTxn, keys);
        };
      }

      const original = Reflect.get(target, prop, target);
      if (typeof original !== 'function') {
        return original;
      }

      return async (...args: unknown[]) => {
        if (TOP_LEVEL_READ_METHODS.has(prop)) {
          telemetry.topLevelReadCalls += 1;
        }
        const mutated = extractKeysFromWriteCall(prop, args);
        const result = await (
          original as (...callArgs: unknown[]) => Promise<unknown>
        ).apply(target, args);
        if (mutated.length > 0) {
          bumpKeys(mutated);
        }
        return result;
      };
    },
  });

  return {
    client,
    telemetry,
    writtenKeys,
    injectNextExecFault(fault: InjectedExecFault) {
      nextExecFault = fault;
    },
    clearRecordedWrites() {
      writtenKeys.length = 0;
    },
  };
}
