// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FloorView, LotStateResponse, PlacementReceipt, WarmUpBaySpec } from '../../shared/domain';
import { Game } from '../game';
import { Splash } from '../splash';

const devvit = vi.hoisted(() => ({
  context: { postId: 't3_lot', postData: {} as Record<string, unknown> },
  requestExpandedMode: vi.fn(),
  showLoginPrompt: vi.fn(),
  showShareSheet: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock('@devvit/web/client', () => devvit);

const streak = { currentStreak: 3, bestStreak: 3, totalShifts: 3, lastPlayedPuzzleDate: '2026-11-18' };
const obstacles = Array.from({ length: 23 }, (_, index) => ({ cell: index + 12, kind: 'pillar' as const }));
const floor: FloorView = {
  floorNumber: 2, seed: 'lot', gridCols: 6, gridRows: 6, elevatorCell: 5,
  obstacles, vehicles: [], occupiedCells: obstacles.map(({ cell }) => cell),
  ghostPairs: [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11]], deadSpots: [35],
  remainingStalls: 6, status: 'LIVE', lastSpotHero: null,
};
const bay: WarmUpBaySpec = { ...floor, bayNumber: 1, assignedVehicle: 'sedan_2x1' };
const archived: FloorView = { ...floor, floorNumber: 1, status: 'ARCHIVED', remainingStalls: 0, lastSpotHero: 'hero' };
const state: LotStateResponse = {
  ok: true, postId: 't3_lot', puzzleDate: '2026-11-18', gridCols: 6, gridRows: 6,
  viewerMode: 'OFFICIAL_LIVE', revision: 12, activeFloor: 2, floorCount: 2,
  warmUpBays: [bay, { ...bay, bayNumber: 2, assignedVehicle: 'van_3x1' }], assignedVehicle: 'sedan_2x1',
  liveFloor: floor, requestedFloor: floor, myPlacement: null, streak,
  floorsSummary: [
    { floorNumber: 1, label: 'B1', status: 'ARCHIVED', remainingStalls: 0, vehicleCount: 5, lastSpotHero: 'hero', lastSpotHeroUsername: 'Driver' },
    { floorNumber: 2, label: 'B2', status: 'LIVE', remainingStalls: 6, vehicleCount: 0, lastSpotHero: null, lastSpotHeroUsername: null },
  ],
};
const placement: PlacementReceipt = {
  postId: state.postId, puzzleDate: state.puzzleDate, userId: 'driver', username: 'Driver', snoovatar: null,
  floorNumber: 2, revision: 13, vehicleType: 'sedan_2x1', cells: [0, 1], wastedStalls: 0,
  elevatorBonus: 1, stepScore: 5, totalShiftScore: 5, remainingStallsBefore: 6, remainingStallsAfter: 5,
  ghostPairsAfter: [[2, 3]], deadSpotsAfter: [35], crownedLastSpotHero: false,
  openedOverflowFloor: null, windowNoteId: null, parkedAtIso: '2026-11-18T12:00:00Z', streak,
};
const http = vi.fn<typeof fetch>();
const pathCalls = (path: string) => http.mock.calls.filter(([url]) => String(url).split('?')[0] === path);
const json = (value: unknown, status = 200) => Response.json(value, { status });

function mockLot(initial: LotStateResponse = state) {
  http.mockImplementation(async (url) => {
    if (url === '/api/lot-state?floor=1') return json({ ...initial, requestedFloor: archived });
    if (url === '/api/lot-state' || url === '/api/lot-state?floor=2') return json(initial);
    throw new Error(`Unexpected URL: ${String(url)}`);
  });
}

const lock = () => screen.getByRole('button', { name: 'Park & Lock Spot' }) as HTMLButtonElement;
const cell = () => screen.getByRole('button', { name: /row 1, column 1/i });
const user = () => userEvent.setup();

async function reachLive(player: ReturnType<typeof user>) {
  await screen.findByRole('heading', { name: 'Warm-Up Bay 1' });
  await player.click(cell());
  await player.click(lock());
  await screen.findByRole('heading', { name: 'Warm-Up Bay 2' });
  await player.click(cell());
  await player.click(lock());
  await screen.findByRole('heading', { name: 'Live Floor' });
}

beforeEach(() => {
  vi.clearAllMocks();
  http.mockReset();
  vi.stubGlobal('fetch', http);
  localStorage.clear();
  devvit.context.postData = {};
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Splash and Game public entrypoints', () => {
  it('renders the feed preview without fetching, expands in the native click, and refreshes only after visibility or focus', async () => {
    vi.useFakeTimers();
    let observe: IntersectionObserverCallback | undefined;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { observe = callback; }
      observe() {}
      disconnect() {}
    });
    devvit.context.postData = { seed: 'post', activeFloor: 2, gridCols: 6, gridRows: 6, remainingStalls: 7, initialObstacleMask: [0, 5] };
    http.mockResolvedValue(json({ ...floor, ok: true, activeFloor: 3, remainingStalls: 4 }));
    render(<Splash />);
    const main = screen.getByRole('main');
    expect(main.style.touchAction).toBe('pan-y');
    expect(screen.getByText('B2')).toBeTruthy();
    expect(screen.getByText('7 open stalls')).toBeTruthy();
    expect(screen.getByRole('img', { name: /2 occupied of 36/i })).toBeTruthy();
    expect(http).not.toHaveBeenCalled();
    const buttons = screen.getAllByRole('button');
    expect(buttons.map(({ textContent }) => textContent)).toEqual(['Start Valet Shift']);
    const click = new MouseEvent('click', { bubbles: true });
    fireEvent(buttons[0]!, click);
    expect(devvit.requestExpandedMode).toHaveBeenCalledWith(click, 'game');
    observe?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    await act(async () => { await vi.advanceTimersByTimeAsync(399); });
    expect(http).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(pathCalls('/api/lot-summary')).toHaveLength(1);
    expect(screen.getByText('4 open stalls')).toBeTruthy();
    await act(async () => { fireEvent.focus(window); });
    expect(pathCalls('/api/lot-summary')).toHaveLength(2);
  });

  it('plays sedan, van and live steps with a separate lock, rotation and a post-lock repack explanation', async () => {
    mockLot();
    const player = user();
    render(<Game />);
    await screen.findByRole('heading', { name: 'Warm-Up Bay 1' });
    cell().focus();
    await player.keyboard('{Enter}');
    expect(screen.getByRole('status').textContent).toMatch(/horizontal/i);
    await player.click(screen.getByRole('button', { name: /rotate 90/i }));
    expect(screen.getByRole('status').textContent).toMatch(/vertical/i);
    expect(pathCalls('/api/park')).toHaveLength(0);
    await player.click(lock());
    expect(screen.getByRole('img', { name: /dead spot.*row 6, column 6/i })).toBeTruthy();
    expect(screen.getAllByRole('img', { name: /ghost stall/i })).toHaveLength(5);
    await screen.findByRole('heading', { name: 'Warm-Up Bay 2' });
    expect(screen.getByText(/3×1 van/i)).toBeTruthy();
    await player.click(cell());
    await player.click(lock());
    await screen.findByRole('heading', { name: 'Live Floor' });
    expect(screen.getByText(/2×1 sedan/i)).toBeTruthy();
    expect(pathCalls('/api/park')).toHaveLength(0);
  });

  it('clears previews on floor changes and on a degraded server revision', async () => {
    mockLot();
    const read = http.getMockImplementation()!;
    http.mockImplementation(async (url, init) => url === '/api/park'
      ? json({ ok: false, code: 'LOT_UPDATED_RETRY_PREVIEW', latestLotState: { ...state, revision: 13 } }, 409)
      : read(url, init));
    const player = user();
    render(<Game />);
    await reachLive(player);
    await player.click(cell());
    expect(lock().disabled).toBe(false);
    await player.click(screen.getByRole('tab', { name: /B1.*Full.*Last Spot Hero/i }));
    await screen.findByRole('heading', { name: 'Archived Floor' });
    await player.click(screen.getByRole('tab', { name: /B2.*Live/i }));
    await screen.findByRole('heading', { name: 'Live Floor' });
    expect(lock().disabled).toBe(true);
    await player.click(cell());
    await player.click(lock());
    await waitFor(() => expect(devvit.showToast).toHaveBeenCalledWith(expect.stringMatching(/preview/i)));
    expect(lock().disabled).toBe(true);
    expect(JSON.parse(String(pathCalls('/api/park')[0]?.[1]?.body))).toMatchObject({ cells: [0, 1], expectedRevision: 12 });
    await player.click(cell());
    await player.click(lock());
    expect(JSON.parse(String(pathCalls('/api/park')[1]?.[1]?.body))).toMatchObject({ cells: [0, 1], expectedRevision: 13 });
  });

  it('plays as a visitor, saves before sign-in, then reselects if the held cells were taken', async () => {
    mockLot({ ...state, viewerMode: 'VISITOR_HOLD' });
    const player = user();
    const mounted = render(<Game />);
    await reachLive(player);
    await player.click(cell());
    await player.click(lock());
    await screen.findByText('VISITOR_HOLD');
    expect(pathCalls('/api/park')).toHaveLength(0);
    let holdAtPrompt: unknown;
    devvit.showLoginPrompt.mockImplementationOnce(() => {
      holdAtPrompt = JSON.parse(localStorage.getItem('last-spot:hold:t3_lot') ?? 'null');
    });
    await player.click(screen.getByRole('button', { name: 'Sign in to Lock Spot' }));
    expect(holdAtPrompt).toMatchObject({ postId: 't3_lot', floorNumber: 2, cells: [0, 1] });
    mounted.unmount();
    mockLot();
    const read = http.getMockImplementation()!;
    http.mockImplementation(async (url, init) => url === '/api/park'
      ? json({ ok: false, code: 'SPOT_TAKEN', latestLotState: state }, 409) : read(url, init));
    const signedIn = render(<Game />);
    expect(await screen.findByText(/pick another open spot/i)).toBeTruthy();
    expect(JSON.parse(String(pathCalls('/api/park')[0]?.[1]?.body))).toMatchObject({ cells: [0, 1], floorNumber: 2 });
    expect(lock().disabled).toBe(true);
    signedIn.unmount();
    localStorage.setItem('last-spot:hold:t3_lot', '{broken');
    render(<Game />);
    await screen.findByRole('heading', { name: 'Warm-Up Bay 1' });
    expect(pathCalls('/api/park')).toHaveLength(1);
  });

  it('previews an official Battle Report before posting and offers native sharing and local practice separately', async () => {
    mockLot({ ...state, myPlacement: placement });
    const read = http.getMockImplementation()!;
    http.mockImplementation(async (url, init) => url === '/api/share-comment'
      ? json({ ok: true, posted: true, formattedReport: 'Parked on B2.' }) : read(url, init));
    const player = user();
    render(<Game />);
    await screen.findByText('OFFICIAL_LIVE');
    expect(screen.getByText(/app account.*u\/Driver/i)).toBeTruthy();
    expect(screen.getByText('0 wasted stalls · Elevator Bonus +1')).toBeTruthy();
    await player.selectOptions(screen.getByLabelText('Window note'), 'tight_fit');
    expect(screen.getByText(/mirrors folded/i, { selector: 'p' })).toBeTruthy();
    expect(pathCalls('/api/share-comment')).toHaveLength(0);
    await player.click(screen.getByRole('button', { name: 'Post Battle Report' }));
    await screen.findByText('Battle Report posted.');
    expect(JSON.parse(String(pathCalls('/api/share-comment')[0]?.[1]?.body))).toEqual({ windowNoteId: 'tight_fit' });
    await player.click(screen.getByRole('button', { name: 'Share or Copy' }));
    expect(devvit.showShareSheet).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/wasted stalls/i) }));
    await player.click(screen.getByRole('button', { name: 'Practice Again' }));
    await reachLive(player);
    await player.click(cell());
    await player.click(lock());
    await screen.findByText('PRACTICE_SNAPSHOT');
    expect(pathCalls('/api/park')).toHaveLength(0);
  });
});
