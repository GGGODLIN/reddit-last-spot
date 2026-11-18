import './index.css';
import { context, requestExpandedMode } from '@devvit/web/client';
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { computeStandardStallCapacity, generateSeededFloor, type LotSummaryResponse } from '../shared/domain';
import { API_ENDPOINTS } from '../shared/manifest-contract';

function initialPreview(): Pick<LotSummaryResponse, 'activeFloor' | 'gridCols' | 'gridRows' | 'occupiedCells' | 'remainingStalls' | 'elevatorCell'> {
  const data = context?.postData;
  const gridCols = data?.gridCols === 7 ? 7 : 6;
  const gridRows = 6;
  const activeFloor = typeof data?.activeFloor === 'number' && Number.isSafeInteger(data.activeFloor) && data.activeFloor > 0 ? data.activeFloor : 1;
  const suppliedSeed = typeof data?.seed === 'string' ? data.seed.trim() : '';
  const seed = suppliedSeed.length > 0 ? suppliedSeed : `lot:${context?.postId ?? 'last-spot'}`;
  const floor = generateSeededFloor(seed, activeFloor, { gridCols, gridRows });
  const mask = data?.initialObstacleMask;
  const occupiedCells = Array.isArray(mask) && mask.every((cell): cell is number => typeof cell === 'number' && Number.isInteger(cell) && cell >= 0 && cell < gridCols * gridRows)
    ? [...new Set<number>(mask)] : floor.obstacles.map(({ cell }) => cell);
  const remainingStalls = typeof data?.remainingStalls === 'number' && data.remainingStalls >= 0
    ? data.remainingStalls : computeStandardStallCapacity(gridCols, gridRows, occupiedCells).remainingStalls;
  return { activeFloor, gridCols, gridRows, occupiedCells, remainingStalls, elevatorCell: floor.elevatorCell };
}

export function Splash(): React.JSX.Element {
  const [preview, setPreview] = useState(initialPreview);
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshing = false;
    let observed = false;
    function refresh(): void {
      if (refreshing || controller.signal.aborted) return;
      refreshing = true;
      void fetch(API_ENDPOINTS.lotSummary, { signal: controller.signal })
        .then(async (response) => response.ok ? await response.json() as LotSummaryResponse : null)
        .then((summary) => { if (summary?.ok && !controller.signal.aborted) setPreview(summary); })
        .catch(() => { /* The inline preview remains usable without a response. */ })
        .finally(() => { refreshing = false; });
    }
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(([entry]) => {
      clearTimeout(timer);
      if (!entry?.isIntersecting || observed) return;
      timer = setTimeout(() => {
        if (document.visibilityState === 'hidden') return;
        observed = true;
        observer?.disconnect();
        refresh();
      }, 400);
    }) : undefined;
    if (root.current) observer?.observe(root.current);
    window.addEventListener('focus', refresh);
    return () => {
      controller.abort();
      clearTimeout(timer);
      observer?.disconnect();
      window.removeEventListener('focus', refresh);
    };
  }, []);

  const { gridCols, gridRows, occupiedCells, elevatorCell, activeFloor, remainingStalls } = preview;
  const total = gridCols * gridRows;
  return (
    <main className="splash touch-pan-y" style={{ touchAction: 'pan-y' }} ref={root}>
      <div className="splash-panel">
        <div className="splash-copy">
          <p className="wayfinding"><strong>B{activeFloor}</strong> Community garage</p>
          <h1>Last<br />Spot</h1>
          <p className="stall-count">{remainingStalls} open {remainingStalls === 1 ? 'stall' : 'stalls'}</p>
        </div>
        <svg className="lot-map" viewBox={`0 0 ${gridCols * 16} ${gridRows * 16}`} role="img" aria-label={`${occupiedCells.length} occupied of ${total} cells`}>
          {Array.from({ length: total }, (_, cell) => (
            <rect key={cell} x={(cell % gridCols) * 16 + 1} y={Math.floor(cell / gridCols) * 16 + 1} width="14" height="14" rx="2"
              className={cell === elevatorCell ? 'map-elevator' : occupiedCells.includes(cell) ? 'map-occupied' : 'map-empty'} />
          ))}
        </svg>
        <button className="action splash-action" type="button" onClick={(event) => requestExpandedMode(event.nativeEvent, 'game')}>
          Start Valet Shift
        </button>
      </div>
    </main>
  );
}

const rootElement = document.getElementById('root');
if (rootElement !== null) createRoot(rootElement).render(<StrictMode><Splash /></StrictMode>);
