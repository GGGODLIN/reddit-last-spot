import { showShareSheet } from '@devvit/web/client';
import {
  evaluatePlacement, validatePlacementCells, type FloorView, type LotStateResponse,
  type ParkRequestPayload, type ParkResponse, type PlacementEvaluation, type VehicleType,
  type WindowNoteId,
} from '../../shared/domain';
import { API_ENDPOINTS } from '../../shared/manifest-contract';

export interface BoardLayout {
  readonly gridCols: number;
  readonly gridRows: number;
  readonly elevatorCell: number;
  readonly obstacles: FloorView['obstacles'];
  readonly vehicles?: FloorView['vehicles'];
  readonly remainingStalls: number;
}

export interface VisitorHold {
  readonly postId: string;
  readonly floorNumber: number;
  readonly cells: readonly number[];
  readonly warmUpScores: readonly [number, number];
  readonly savedAt: number;
}

export function holdKey(postId: string): string {
  return `last-spot:hold:${postId}`;
}

export function readHold(postId: string): VisitorHold | null {
  try {
    const raw = localStorage.getItem(holdKey(postId));
    if (raw === null) return null;
    const value = JSON.parse(raw) as Partial<VisitorHold> | null;
    if (value?.postId === postId && Number.isSafeInteger(value.floorNumber) &&
      value.floorNumber! > 0 && Array.isArray(value.cells) &&
      (value.cells.length === 2 || value.cells.length === 3) && value.cells.every(Number.isSafeInteger) &&
      Array.isArray(value.warmUpScores) && value.warmUpScores.length === 2 &&
      value.warmUpScores.every(Number.isFinite) && Number.isFinite(value.savedAt)) {
      return value as VisitorHold;
    }
  } catch {
    // Storage can be unavailable in the host webview, even when parsing would succeed.
  }
  clearHold(postId);
  return null;
}

export function clearHold(postId: string): void {
  try { localStorage.removeItem(holdKey(postId)); } catch { /* Storage may be blocked. */ }
}

export function checkPlacement(board: BoardLayout, vehicle: VehicleType, cells: readonly number[]): PlacementEvaluation | null {
  const occupied = [...board.obstacles.map(({ cell }) => cell), ...(board.vehicles ?? []).flatMap(({ cells: parked }) => parked)];
  const valid = validatePlacementCells(board.gridCols, board.gridRows, occupied, vehicle, cells);
  if (!valid.ok) return null;
  return evaluatePlacement(board.gridCols, board.gridRows, occupied, board.elevatorCell, vehicle, valid.normalizedCells);
}

export function makeParkRequest(state: LotStateResponse, preview: PlacementEvaluation, warmUpScores: readonly [number, number]): ParkRequestPayload {
  return {
    floorNumber: state.activeFloor, expectedRevision: state.revision, vehicleType: preview.vehicleType,
    cells: preview.cells, warmUpScores,
    clientPreview: { wastedStalls: preview.wastedStalls, remainingStallsAfter: preview.remainingStallsAfter },
  };
}

export async function loadLot(floor?: number, signal?: AbortSignal): Promise<LotStateResponse> {
  const response = await fetch(floor === undefined ? API_ENDPOINTS.lotState : `${API_ENDPOINTS.lotState}?floor=${floor}`, { signal });
  if (!response.ok) throw new Error('Could not read the lot');
  return await response.json() as LotStateResponse;
}

async function postJson<T>(url: string, body: object): Promise<T> {
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return await response.json() as T;
}

export function park(payload: ParkRequestPayload): Promise<ParkResponse> {
  return postJson(API_ENDPOINTS.park, payload);
}

export type ShareCommentResponse =
  | { readonly ok: true; readonly posted: boolean; readonly alreadyShared: boolean; readonly formattedReport: string; readonly fellBackToClipboard: boolean }
  | { readonly ok: false; readonly code: string };

export function postBattleReport(windowNoteId: WindowNoteId | null): Promise<ShareCommentResponse> {
  return postJson(API_ENDPOINTS.shareComment, { windowNoteId });
}

export async function shareReport(text: string): Promise<string> {
  try {
    await showShareSheet({ title: 'Last Spot', text });
    return 'Share sheet opened.';
  } catch {
    try {
      await navigator.clipboard.writeText(text);
      return 'Battle Report copied.';
    } catch {
      return 'Select the Battle Report text to copy it.';
    }
  }
}
