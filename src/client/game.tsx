import './index.css';

import { context } from '@devvit/web/client';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  API_ENDPOINTS,
  type ProbeWriteGuardResponse,
} from '../shared/manifest-contract';

export function Game() {
  const [guardResult, setGuardResult] = useState<string | null>(null);

  const handleVerifyOfficialWrite = async () => {
    try {
      const response = await fetch(API_ENDPOINTS.probeWriteGuard, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const payload = (await response.json()) as ProbeWriteGuardResponse;
      setGuardResult(
        payload.ok
          ? `Official slot ready for ${payload.userId}`
          : `Visitor Hold (${response.status}: ${payload.code})`,
      );
    } catch {
      setGuardResult('Unable to reach server');
    }
  };

  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-4 bg-slate-950 px-6 py-8 text-center text-slate-100">
      <h1 className="text-2xl font-bold tracking-tight">
        Last Spot — Live Floor Bay
      </h1>
      <p className="max-w-md text-sm text-slate-300">
        Active driver: {context.username ?? 'Visitor Hold'}
      </p>
      <button
        type="button"
        className="cursor-pointer rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-300"
        onClick={() => {
          void handleVerifyOfficialWrite();
        }}
      >
        Verify Official Spot Guard
      </button>
      {guardResult !== null ? (
        <p className="text-xs text-amber-200" role="status">
          {guardResult}
        </p>
      ) : null}
    </main>
  );
}

const rootElement = document.getElementById('root');
if (rootElement !== null) {
  createRoot(rootElement).render(
    <StrictMode>
      <Game />
    </StrictMode>,
  );
}
