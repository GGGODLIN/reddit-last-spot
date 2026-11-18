export const APP_NAME = 'last-spot-valet' as const;

export const CLIENT_POST_DIR = 'dist/client' as const;

export const CLIENT_ENTRYPOINTS = {
  default: {
    entry: 'splash.html',
    height: 'tall',
    inline: true,
  },
  game: {
    entry: 'game.html',
  },
} as const;

export const SERVER_BUNDLE = {
  dir: 'dist/server',
  entry: 'index.cjs',
} as const;

export const MENU_ENDPOINTS = {
  postCreate: '/internal/menu/post-create',
  opsHealth: '/internal/menu/ops-health',
  opsResetLot: '/internal/menu/ops-reset-lot',
  probeTx: '/internal/menu/probe-tx',
} as const;

export const FORM_IDS = {
  opsResetLotForm: 'opsResetLotForm',
} as const;

export const FORM_ENDPOINTS = {
  opsResetLotForm: '/internal/form/ops-reset-lot',
} as const;

export const TRIGGER_ENDPOINTS = {
  onAppInstall: '/internal/triggers/on-app-install',
  onPostDelete: '/internal/triggers/on-post-delete',
} as const;

export const SCHEDULER_TASKS = {
  dailyPost: {
    name: 'dailyPost',
    endpoint: '/internal/scheduler/daily-post',
    cron: '0 0 * * *',
  },
} as const;

export const API_ENDPOINTS = {
  health: '/api/health',
  probeWriteGuard: '/api/probe-write-guard',
  lotSummary: '/api/lot-summary',
  lotState: '/api/lot-state',
  park: '/api/park',
} as const;

export const ERROR_CODES = {
  loginRequiredForOfficialSpot: 'LOGIN_REQUIRED_FOR_OFFICIAL_SPOT',
  invalidParkPayload: 'INVALID_PARK_PAYLOAD',
  invalidFloorQuery: 'INVALID_FLOOR_QUERY',
  spotTaken: 'SPOT_TAKEN',
  lotUpdatedRetryPreview: 'LOT_UPDATED_RETRY_PREVIEW',
  concurrentConflictRetryExhausted: 'CONCURRENT_CONFLICT_RETRY_EXHAUSTED',
} as const;

export const ALL_INTERNAL_ENDPOINTS = [
  MENU_ENDPOINTS.postCreate,
  MENU_ENDPOINTS.opsHealth,
  MENU_ENDPOINTS.opsResetLot,
  MENU_ENDPOINTS.probeTx,
  FORM_ENDPOINTS.opsResetLotForm,
  TRIGGER_ENDPOINTS.onAppInstall,
  TRIGGER_ENDPOINTS.onPostDelete,
  SCHEDULER_TASKS.dailyPost.endpoint,
] as const;

export type InternalEndpointPath = (typeof ALL_INTERNAL_ENDPOINTS)[number];

export type ProbeWriteGuardResponse =
  | {
      readonly ok: true;
      readonly userId: string;
      readonly key: string;
    }
  | {
      readonly ok: false;
      readonly code: typeof ERROR_CODES.loginRequiredForOfficialSpot;
    };
