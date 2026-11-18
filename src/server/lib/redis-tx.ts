import type { RedisClient, TxClientLike } from '@devvit/redis';

export type TxPlan<TValue, TAbortReason extends string = string> =
  | {
      readonly kind: 'abort';
      readonly reason: TAbortReason;
    }
  | {
      readonly kind: 'commit';
      readonly previousRevision: number;
      readonly expectedCmdCount: number;
      readonly revisionReplyIndex: number;
      readonly value: TValue;
      readonly queueCommands: (txn: TxClientLike) => Promise<void>;
    };

export type AtomicTxResult<TValue, TAbortReason extends string = string> =
  | {
      readonly status: 'committed';
      readonly committed: true;
      readonly previousRevision: number;
      readonly revision: number;
      readonly replyCount: number;
      readonly expectedCmdCount: number;
      readonly cleanup: 'none';
      readonly value: TValue;
    }
  | {
      readonly status: 'conflict';
      readonly committed: false;
      readonly previousRevision: number;
      readonly replyCount: number;
      readonly expectedCmdCount: number;
      readonly cleanup: 'none' | 'discard';
      readonly reason:
        | 'empty_or_short_exec_reply'
        | 'revision_mismatch'
        | 'exec_threw';
      readonly errorMessage?: string;
    }
  | {
      readonly status: 'aborted';
      readonly committed: false;
      readonly cleanup: 'unwatch';
      readonly reason: TAbortReason;
    };

export interface RunAtomicRedisTxOptions<
  TState,
  TValue,
  TAbortReason extends string = string,
> {
  readonly redis: Pick<RedisClient, 'watch'>;
  readonly watchedKeys: readonly [string, ...string[]];
  readonly readAfterWatch: () => Promise<TState>;
  readonly planTransaction: (
    state: TState,
  ) => TxPlan<TValue, TAbortReason> | Promise<TxPlan<TValue, TAbortReason>>;
  readonly beforeMultiHook?: () => Promise<void>;
}

export async function runAtomicRedisTransaction<
  TState,
  TValue,
  TAbortReason extends string = string,
>(
  options: RunAtomicRedisTxOptions<TState, TValue, TAbortReason>,
): Promise<AtomicTxResult<TValue, TAbortReason>> {
  let txn: TxClientLike | undefined;
  let multiStarted = false;
  let execResolved = false;

  try {
    txn = await options.redis.watch(...options.watchedKeys);
    const snapshot = await options.readAfterWatch();

    if (options.beforeMultiHook !== undefined) {
      await options.beforeMultiHook();
    }

    const plan = await options.planTransaction(snapshot);
    if (plan.kind === 'abort') {
      return {
        status: 'aborted',
        committed: false,
        cleanup: 'unwatch',
        reason: plan.reason,
      };
    }

    if (
      !Number.isSafeInteger(plan.previousRevision) ||
      plan.previousRevision < 0 ||
      !Number.isSafeInteger(plan.expectedCmdCount) ||
      plan.expectedCmdCount < 1 ||
      !Number.isSafeInteger(plan.revisionReplyIndex) ||
      plan.revisionReplyIndex < 0 ||
      plan.revisionReplyIndex >= plan.expectedCmdCount
    ) {
      throw new RangeError(
        'Invalid transaction plan bounds for revision or command count',
      );
    }

    await txn.multi();
    multiStarted = true;
    await plan.queueCommands(txn);

    let rawReplies: unknown;
    try {
      rawReplies = await txn.exec();
      execResolved = true;
    } catch (execError) {
      const errorMessage =
        execError instanceof Error ? execError.message : String(execError);
      return {
        status: 'conflict',
        committed: false,
        previousRevision: plan.previousRevision,
        replyCount: 0,
        expectedCmdCount: plan.expectedCmdCount,
        cleanup: 'discard',
        reason: 'exec_threw',
        errorMessage,
      };
    }

    // Devvit TxClient.exec() returns [] (never null) on watched-key conflict; skipping length checks causes ghost commits.
    if (
      !Array.isArray(rawReplies) ||
      rawReplies.length !== plan.expectedCmdCount
    ) {
      return {
        status: 'conflict',
        committed: false,
        previousRevision: plan.previousRevision,
        replyCount: Array.isArray(rawReplies) ? rawReplies.length : 0,
        expectedCmdCount: plan.expectedCmdCount,
        cleanup: 'none',
        reason: 'empty_or_short_exec_reply',
      };
    }

    const nextRevision = Number(rawReplies[plan.revisionReplyIndex]);
    const expectedRevision = plan.previousRevision + 1;
    if (!Number.isSafeInteger(nextRevision) || nextRevision !== expectedRevision) {
      return {
        status: 'conflict',
        committed: false,
        previousRevision: plan.previousRevision,
        replyCount: rawReplies.length,
        expectedCmdCount: plan.expectedCmdCount,
        cleanup: 'none',
        reason: 'revision_mismatch',
      };
    }

    return {
      status: 'committed',
      committed: true,
      previousRevision: plan.previousRevision,
      revision: nextRevision,
      replyCount: rawReplies.length,
      expectedCmdCount: plan.expectedCmdCount,
      cleanup: 'none',
      value: plan.value,
    };
  } finally {
    // Devvit caps each installation at 20 concurrent transactions; unclosed watched slots leak capacity.
    if (txn !== undefined && !execResolved) {
      if (multiStarted) {
        try {
          await txn.discard();
        } catch {
          // Server may have already torn down the transaction when exec() rejected.
        }
      } else {
        try {
          await txn.unwatch();
        } catch {
          // Suppress secondary transport error so primary failure surfaces intact.
        }
      }
    }
  }
}
