import './index.css';
import { context, showLoginPrompt, showToast } from '@devvit/web/client';
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { FloorView, LotStateResponse, PlacementEvaluation, PlacementReceipt, VehicleType } from '../shared/domain';
import { ParkingBoard, type ParkingBoardProps } from './components/ParkingBoard';
import { ShiftResult, type ShiftOutcome } from './components/ShiftResult';
import { checkPlacement, clearHold, holdKey, loadLot, makeParkRequest, park, readHold, type BoardLayout, type VisitorHold } from './lib/lot';

type Scores = readonly [number, number];
type Step = 0 | 1 | 2;
interface Cursor { readonly anchor: number; readonly vertical: boolean }
interface Shift {
  readonly step: Step;
  readonly scores: Scores;
  readonly practice: boolean;
  readonly outcome: ShiftOutcome | null;
}
interface SessionState {
  readonly lot: LotStateResponse;
  readonly shift: Shift;
  readonly notice: string;
}

const EMPTY_SHIFT: Shift = { step: 0, scores: [0, 0], practice: false, outcome: null };
const REPACK_MS = 800;
const PICK_AGAIN = 'That spot is taken. Pick another open spot.';
const PREVIEW_AGAIN = 'The lot changed. Preview your spot again.';

function floorSummary(lot: LotStateResponse): string {
  return lot.floorsSummary.map((floor) => `${floor.label} ${floor.status === 'LIVE' ? 'Live' : 'Full'}`).join(' · ');
}

function officialOutcome(lot: LotStateResponse, receipt: PlacementReceipt): ShiftOutcome {
  return {
    mode: 'OFFICIAL_LIVE', floorNumber: receipt.floorNumber, metrics: receipt,
    summary: floorSummary(lot), streak: receipt.streak.currentStreak, username: receipt.username,
  };
}

async function openSession(signal: AbortSignal): Promise<SessionState> {
  const lot = await loadLot(undefined, signal);
  const initial = { lot, shift: EMPTY_SHIFT, notice: '' };
  if (signal.aborted || lot.viewerMode !== 'OFFICIAL_LIVE') return initial;
  if (lot.myPlacement) {
    clearHold(lot.postId);
    return { ...initial, shift: { ...EMPTY_SHIFT, step: 2, outcome: officialOutcome(lot, lot.myPlacement) } };
  }
  const held = readHold(lot.postId);
  if (held === null) return initial;
  const shift: Shift = { ...EMPTY_SHIFT, step: 2, scores: held.warmUpScores };
  const preview = held.floorNumber === lot.activeFloor && lot.liveFloor.status === 'LIVE'
    ? checkPlacement(lot.liveFloor, lot.assignedVehicle, held.cells) : null;
  if (!preview) {
    clearHold(lot.postId);
    return { lot, shift, notice: PICK_AGAIN };
  }
  const response = await park(makeParkRequest(lot, preview, shift.scores));
  if (signal.aborted) return initial;
  if (response.ok) {
    clearHold(lot.postId);
    const latest = response.latestLotState ?? lot;
    return { lot: latest, shift: { ...shift, outcome: officialOutcome(latest, response.receipt) }, notice: '' };
  }
  if (response.code === 'SPOT_TAKEN' || response.code === 'LOT_UPDATED_RETRY_PREVIEW') {
    clearHold(lot.postId);
    return { lot: response.latestLotState ?? await loadLot(undefined, signal), shift,
      notice: response.code === 'SPOT_TAKEN' ? PICK_AGAIN : PREVIEW_AGAIN };
  }
  return { lot, shift, notice: 'Could not lock the held spot. Preview and confirm an open spot.' };
}

function previewCells(board: BoardLayout, vehicle: VehicleType, cursor: Cursor): number[] {
  const length = vehicle === 'sedan_2x1' ? 2 : 3;
  const x = cursor.anchor % board.gridCols;
  const y = Math.floor(cursor.anchor / board.gridCols);
  return Array.from({ length }, (_, index) => {
    if (cursor.vertical ? y + index >= board.gridRows : x + index >= board.gridCols) return -1;
    return cursor.anchor + index * (cursor.vertical ? board.gridCols : 1);
  });
}

function FloorTabs({ lot, floor, disabled, onFloor }: {
  lot: LotStateResponse; floor: number; disabled: boolean; onFloor: (floor: number) => void;
}): React.JSX.Element {
  return (
    <div className="floor-tabs" role="tablist" aria-label="Garage floors">
      {lot.floorsSummary.map((entry) => (
        <button key={entry.floorNumber} type="button" role="tab" aria-selected={entry.floorNumber === floor} disabled={disabled}
          onClick={() => onFloor(entry.floorNumber)}>
          {entry.label} <span>{entry.status === 'LIVE' ? 'Live' : `Full${entry.lastSpotHero ? ' · Last Spot Hero' : ''}`}</span>
        </button>
      ))}
    </div>
  );
}

function ShiftGame({ initial }: { readonly initial: SessionState }): React.JSX.Element {
  const [lot, setLot] = useState(initial.lot);
  const [shift, setShift] = useState(initial.shift);
  const [inspected, setInspected] = useState<FloorView | null>(null);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [notice, setNotice] = useState(initial.notice);
  const [busy, setBusy] = useState(false);
  const [repack, setRepack] = useState<NonNullable<ParkingBoardProps['repack']> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const bay = shift.step === 2 ? null : lot.warmUpBays[shift.step];
  const result = shift.outcome;
  const board = bay ?? inspected ?? lot.liveFloor;
  const vehicle = bay?.assignedVehicle ?? lot.assignedVehicle;
  const archived = bay === null && 'status' in board && board.status === 'ARCHIVED';
  const cells = cursor ? previewCells(board, vehicle, cursor) : null;
  const preview = cells ? checkPlacement(board, vehicle, cells) : null;
  const enabled = !busy && !repack && !result && !archived;

  function advance(evaluation: NonNullable<ParkingBoardProps['repack']>, next: Shift, updatedLot?: LotStateResponse): void {
    setCursor(null);
    setRepack(evaluation);
    timer.current = setTimeout(() => {
      if (updatedLot) setLot(updatedLot);
      setShift(next);
      setRepack(null);
    }, REPACK_MS);
  }

  function localOutcome(mode: 'VISITOR_HOLD' | 'PRACTICE_SNAPSHOT', evaluation: PlacementEvaluation): ShiftOutcome {
    return { mode, floorNumber: lot.activeFloor, metrics: evaluation, summary: floorSummary(lot),
      username: 'visitor', streak: lot.streak.currentStreak };
  }

  async function confirm(): Promise<void> {
    if (!preview || !enabled) return;
    setNotice('');
    if (shift.step < 2) {
      const scores: Scores = shift.step === 0 ? [preview.stepScore, 0] : [shift.scores[0], preview.stepScore];
      advance(preview, { ...shift, step: shift.step === 0 ? 1 : 2, scores });
      return;
    }
    if (shift.practice || lot.viewerMode === 'VISITOR_HOLD') {
      advance(preview, { ...shift, outcome: localOutcome(shift.practice ? 'PRACTICE_SNAPSHOT' : 'VISITOR_HOLD', preview) });
      return;
    }
    setBusy(true);
    try {
      const response = await park(makeParkRequest(lot, preview, shift.scores));
      if (response.ok) {
        clearHold(lot.postId);
        const latest = response.latestLotState ?? lot;
        advance(response.receipt, { ...shift, outcome: officialOutcome(latest, response.receipt) }, latest);
      } else if (response.code === 'LOGIN_REQUIRED_FOR_OFFICIAL_SPOT') {
        advance(preview, { ...shift, outcome: localOutcome('VISITOR_HOLD', preview) });
      } else if (response.code === 'SPOT_TAKEN' || response.code === 'LOT_UPDATED_RETRY_PREVIEW') {
        setCursor(null);
        const message = response.code === 'SPOT_TAKEN' ? PICK_AGAIN : PREVIEW_AGAIN;
        setNotice(message);
        showToast(message);
        setLot(response.latestLotState ?? await loadLot());
      } else {
        setNotice('Could not lock this spot. Preview and try again.');
        setCursor(null);
      }
    } catch {
      setNotice('Could not confirm with the garage. Try Park & Lock Spot again.');
    } finally {
      setBusy(false);
    }
  }

  async function switchFloor(floorNumber: number): Promise<void> {
    setCursor(null);
    setNotice('');
    if (floorNumber === lot.activeFloor) {
      setInspected(null);
      return;
    }
    setBusy(true);
    try {
      const fresh = await loadLot(floorNumber);
      setLot(fresh);
      setInspected(fresh.requestedFloor.floorNumber === fresh.activeFloor ? null : fresh.requestedFloor);
    } catch {
      setNotice('Could not load that floor. Try again.');
    } finally {
      setBusy(false);
    }
  }

  function signIn(): void {
    if (result?.mode !== 'VISITOR_HOLD') return;
    const hold: VisitorHold = {
      postId: lot.postId, floorNumber: result.floorNumber, cells: result.metrics.cells,
      warmUpScores: shift.scores, savedAt: Date.now(),
    };
    try {
      localStorage.setItem(holdKey(lot.postId), JSON.stringify(hold));
      showLoginPrompt();
    } catch {
      setNotice('Could not save the held spot for sign-in.');
    }
  }

  const showResult = result !== null && inspected === null;
  const boardTitle = bay ? `Warm-Up Bay ${bay.bayNumber}` : archived ? 'Archived Floor' : 'Live Floor';
  const orientation = cursor?.vertical ? 'Vertical' : 'Horizontal';
  return (
    <main className="game-shell">
      <header className="garage-header">
        <p className="wordmark">Last Spot</p>
        <p className="wayfinding">{shift.practice ? 'Practice shift' : 'Valet shift'} <strong>{shift.step + 1}/3</strong></p>
      </header>
      {shift.step === 2 && !shift.practice && <FloorTabs lot={lot} floor={inspected?.floorNumber ?? lot.activeFloor}
        disabled={busy || repack !== null} onFloor={(floorNumber) => { void switchFloor(floorNumber); }} />}
      {notice && <p className="garage-notice" role="alert">{notice}</p>}
      {showResult ? <ShiftResult outcome={result} onSignIn={signIn} onPractice={() => {
        setInspected(null);
        setNotice('');
        setShift({ ...EMPTY_SHIFT, practice: true });
      }} /> : <>
        <div className="board-heading">
          <h1>{boardTitle}</h1>
          <p>{archived ? `B${inspected?.floorNumber ?? lot.activeFloor} · Full` : vehicle === 'sedan_2x1' ? '2×1 sedan' : '3×1 van'}</p>
        </div>
        {archived && inspected?.lastSpotHero && <p className="hero-note">Last Spot Hero · {lot.floorsSummary.find((entry) => entry.floorNumber === inspected.floorNumber)?.lastSpotHeroUsername ?? 'Community driver'}</p>}
        <ParkingBoard board={board} disabled={!enabled} preview={cells ? { cells, valid: preview !== null } : null} repack={repack}
          onCell={(anchor) => setCursor({ anchor, vertical: cursor?.anchor === anchor ? !cursor.vertical : cursor?.vertical ?? false })} />
        {!archived && !result && <>
          <p className="placement-status" role="status">{repack ? 'Repacking open stalls…' : cursor ? `${orientation} · ${preview ? `${preview.wastedStalls} wasted stalls · Elevator Bonus +${preview.elevatorBonus}` : 'Blocked · try another position'}` : 'Tap an open cell to preview.'}</p>
          <div className="game-controls">
            <button className="action secondary" type="button" disabled={!enabled || !cursor} onClick={() => {
              if (cursor) setCursor({ ...cursor, vertical: !cursor.vertical });
            }}>Rotate 90°</button>
            <button className="action" type="button" disabled={!enabled || !preview} onClick={() => { void confirm(); }}>Park &amp; Lock Spot</button>
          </div>
        </>}
        {result && <button className="action secondary" type="button" onClick={() => setInspected(null)}>Back to Shift Result</button>}
      </>}
    </main>
  );
}

type GameLoad = { readonly status: 'loading' | 'error' } | { readonly status: 'ready'; readonly session: SessionState };

export function Game(): React.JSX.Element {
  const [load, setLoad] = useState<GameLoad>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void openSession(controller.signal).then(
      (session) => { if (!controller.signal.aborted) setLoad({ status: 'ready', session }); },
      () => { if (!controller.signal.aborted) setLoad({ status: 'error' }); },
    );
    return () => controller.abort();
  }, [attempt]);
  if (load.status === 'ready') return <ShiftGame initial={load.session} />;
  return (
    <main className="game-shell">
      <h1>Last Spot</h1>
      {load.status === 'loading' ? <p role="status">Opening the garage…</p> : <>
        <p role="alert">Could not open the garage.</p>
        <button className="action" type="button" onClick={() => { setLoad({ status: 'loading' }); setAttempt(attempt + 1); }}>Try Again</button>
      </>}
      {!context?.postId && <p>Open the game from a community post.</p>}
    </main>
  );
}

const rootElement = document.getElementById('root');
if (rootElement !== null) createRoot(rootElement).render(<StrictMode><Game /></StrictMode>);
