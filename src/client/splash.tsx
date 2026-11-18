import './index.css';

import { context, requestExpandedMode } from '@devvit/web/client';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  API_ENDPOINTS,
  type ProbeWriteGuardResponse,
} from '../shared/manifest-contract';

export function Splash() {
  const [probeStatus, setProbeStatus] = useState<string | null>(null);

  const handleProbeWriteGuard = async () => {
    try {
      const response = await fetch(API_ENDPOINTS.probeWriteGuard, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const body = (await response.json()) as ProbeWriteGuardResponse;
      setProbeStatus(
        body.ok
          ? `Authenticated (${body.userId})`
          : `Visitor Hold (${response.status}: ${body.code})`,
      );
    } catch {
      setProbeStatus('Probe request failed');
    }
  };

  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-4 bg-slate-950 px-6 py-8 text-center text-slate-100">
      <p className="rounded-full border border-amber-400/40 bg-amber-400/10 px-3 py-1 text-xs font-semibold tracking-wider text-amber-300 uppercase">
        Community Valet Shift
      </p>
      <h1 className="text-3xl font-bold tracking-tight">Last Spot</h1>
      <p className="max-w-sm text-sm text-slate-300">
        Calibrate in two Warm-Up Bays, then lock one vehicle into the shared
        Live Floor without leaving Dead Spots.
      </p>
      <p className="text-xs text-slate-400">
        Driver: {context.username ?? 'Visitor Hold (sign in to claim a stall)'}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
        <button
          type="button"
          className="cursor-pointer rounded-lg bg-amber-400 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-300"
          onClick={(event) => {
            void requestExpandedMode(event.nativeEvent, 'game');
          }}
        >
          Start Valet Shift
        </button>
        <button
          type="button"
          className="cursor-pointer rounded-lg border border-slate-700 bg-slate-900 px-4 py-2.5 text-xs font-medium text-slate-200 transition hover:border-slate-500"
          onClick={() => {
            void handleProbeWriteGuard();
          }}
        >
          Probe Official Write Guard
        </button>
      </div>
      {probeStatus !== null ? (
        <p className="text-xs text-amber-200" role="status">
          {probeStatus}
        </p>
      ) : null}
    </main>
  );
}

const rootElement = document.getElementById('root');
if (rootElement !== null) {
  createRoot(rootElement).render(
    <StrictMode>
      <Splash />
    </StrictMode>,
  );
}
