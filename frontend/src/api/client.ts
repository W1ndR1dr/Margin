/**
 * Typed client for the HNRad local backend (see CONTRACT.md).
 * Everything is same-origin: Vite proxies /api -> 127.0.0.1:8765.
 */

export interface Health {
  status: string;
  version: string;
  db_path: string;
  studies_root: string;
}

export interface Patient {
  patient_id: string;
  name: string;
  sex: string | null;
  birth_date: string | null;
  study_count: number;
}

export interface Study {
  study_uid: string;
  patient_id: string;
  patient_name: string;
  study_date: string | null;
  study_time: string | null;
  description: string | null;
  accession: string | null;
  modalities: string[];
  series_count: number;
  instance_count: number;
}

export interface Series {
  series_uid: string;
  study_uid: string;
  series_number: number | null;
  modality: string | null;
  description: string | null;
  body_part: string | null;
  instance_count: number;
  rows: number | null;
  cols: number | null;
  pixel_spacing: [number, number] | null;
  slice_thickness: number | null;
  spacing_between_slices: number | null;
  orientation: number[] | null;
  is_multiframe: boolean;
  is_3d: boolean;

  /* ---- optional MR/enrichment fields (backend adds these; may be absent) ---- */
  /** 't1' | 't1c' | 't2' | 'stir' | 'flair' | 'dwi' | 'adc' | 'ct' | ... */
  sequence_kind?: string | null;
  frame_of_reference_uid?: string | null;
  /** MR acquisition parameters when the indexer exposes them. */
  echo_time?: number | null;
  repetition_time?: number | null;
  inversion_time?: number | null;
  scanning_sequence?: string | null;
  sequence_variant?: string | null;
  contrast_agent?: string | null;
  /** 'axial' | 'sagittal' | 'coronal' | 'oblique' when the backend derives it. */
  acquired_plane?: string | null;
  window_width?: number | null;
  window_center?: number | null;
}

export interface Instance {
  sop_uid: string;
  instance_number: number | null;
  ipp: [number, number, number] | null;
  slice_pos: number | null;
}

export type SeriesDetail = Series & { instances: Instance[] };

/**
 * `GET /api/series/{uid}/window` — modality-aware default windowing.
 * The route is being added by the backend team; a 404 is a first-class state
 * and the viewer computes percentiles client-side instead.
 */
export interface SeriesWindow {
  /**
   * The display range, which the backend reports as bounds rather than as a
   * width/centre pair. Both forms are accepted: `lower`/`upper` is what the
   * route actually returns, `ww`/`wc` is kept so a future backend (or a test
   * double) can send the radiology-native form without a client change.
   */
  lower?: number;
  upper?: number;
  ww?: number;
  wc?: number;
  /** How it was derived, e.g. 'ct-fixed-w350-l40', 'dicom', 'percentile'. */
  method?: string;
  source?: string;
  computed_at?: number;
  cached?: boolean;
  modality?: string | null;
  sequence_kind?: string | null;
}

export interface ImportResult {
  patients: number;
  studies: number;
  series: number;
  instances: number;
  skipped: number;
  seconds: number;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** FastAPI validation errors (422) carry `detail` as a list, not a string. */
interface ValidationItem {
  loc?: (string | number)[];
  msg?: string;
  type?: string;
}

function describeValidation(items: ValidationItem[]): string {
  const parts = items.slice(0, 4).map((it) => {
    const where = (it.loc ?? []).filter((p) => p !== 'body').join('.');
    const msg = it.msg ?? it.type ?? 'invalid value';
    return where ? `${where}: ${msg}` : msg;
  });
  if (items.length > parts.length) parts.push(`… and ${items.length - parts.length} more`);
  return parts.join('; ') || 'Request rejected by the backend';
}

async function readErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    const detail = body?.detail;
    if (typeof detail === 'string' && detail) return detail;
    if (Array.isArray(detail)) return describeValidation(detail as ValidationItem[]);
    if (detail && typeof detail === 'object') return JSON.stringify(detail);
  } catch {
    /* non-JSON error body */
  }
  return `${res.status} ${res.statusText}`.trim();
}

async function req<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), init?.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await fetch(path, { ...init, signal: controller.signal });
  } catch (e) {
    const msg = (e as Error)?.name === 'AbortError' ? 'Request timed out' : 'Backend unreachable';
    throw new ApiError(msg, 0);
  } finally {
    window.clearTimeout(timeout);
  }
  if (!res.ok) {
    throw new ApiError(await readErrorDetail(res), res.status);
  }
  return (await res.json()) as T;
}

export const api = {
  health: (timeoutMs = 2500) => req<Health>('/api/health', { timeoutMs }),

  patients: () => req<Patient[]>('/api/patients'),

  studies: (patientId?: string) =>
    req<Study[]>(`/api/studies${patientId ? `?patient_id=${encodeURIComponent(patientId)}` : ''}`),

  seriesForStudy: (studyUid: string) =>
    req<Series[]>(`/api/studies/${encodeURIComponent(studyUid)}/series`),

  series: (seriesUid: string) => req<SeriesDetail>(`/api/series/${encodeURIComponent(seriesUid)}`),

  thumbnailUrl: (seriesUid: string) =>
    `/api/series/${encodeURIComponent(seriesUid)}/thumbnail`,

  /** Modality-aware window. Throws ApiError(404) until the backend ships it. */
  seriesWindow: (seriesUid: string) =>
    req<SeriesWindow>(`/api/series/${encodeURIComponent(seriesUid)}/window`, { timeoutMs: 20_000 }),

  importFolder: (path?: string) =>
    req<ImportResult>('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(path ? { path } : {}),
      timeoutMs: 15 * 60_000,
    }),
};

/**
 * Cornerstone's wadouri loader is happiest with an absolute URL.
 */
export function imageIdFor(sopUid: string): string {
  return `wadouri:${window.location.origin}/api/instances/${encodeURIComponent(sopUid)}`;
}

export function formatDicomDate(d: string | null | undefined): string {
  if (!d) return '—';
  const s = d.replace(/[^0-9]/g, '');
  if (s.length !== 8) return d;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

export function formatDicomTime(t: string | null | undefined): string {
  if (!t) return '';
  const s = t.replace(/[^0-9]/g, '');
  if (s.length < 4) return '';
  return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
}

export function formatPersonName(n: string | null | undefined): string {
  if (!n) return 'Unknown';
  return n.replace(/\^+$/, '').split('^').filter(Boolean).join(', ');
}

/* ------------------------------------------------------------------ */
/* Analysis API v0.2 — segmentation, volumetrics, airway              */
/* ------------------------------------------------------------------ */

export type Triple = [number, number, number];

export interface LabelStats {
  label_id: string;
  n_voxels: number;
  volume_ml: number;
  bbox_ijk: [number, number, number, number, number, number];
  centroid_lps: Triple;
  mean_hu: number;
  std_hu: number;
  longest_axis_mm: number;
  diameters_mm: Triple;
  took_ms: number;
}

export interface ThresholdRequest {
  series_uid: string;
  lower_hu: number;
  upper_hu: number;
  inside_body?: boolean;
  keep_largest?: boolean;
  min_component_ml?: number;
}

export interface RegionGrowRequest {
  series_uid: string;
  seed_ijk?: Triple;
  seed_lps?: Triple;
  lower_hu: number;
  upper_hu: number;
  max_radius_mm?: number | null;
  closing_mm?: number;
  keep_largest?: boolean;
}

export interface DistanceResult {
  min_distance_mm: number;
  point_a_lps: Triple;
  point_b_lps: Triple;
}

export interface AirwayRequest {
  series_uid: string;
  seed_ijk?: Triple;
  seed_lps?: Triple;
  lower_hu?: number;
  upper_hu?: number;
  glottis_slice?: number | null;
  reference?: 'auto' | 'manual';
  ref_range_k?: [number, number] | null;
  /** Drop every centreline sample superior to `glottis_slice` before grading. */
  cap_at_glottis?: boolean;
}

export interface AirwayResult {
  label_id: string;
  centerline_lps: Triple[];
  /** Slice index k of every sample (backends before this field omit it). */
  sample_k?: number[];
  arclength_mm: number[];
  csa_mm2: number[];
  eq_diameter_mm: number[];
  min_diameter_mm: number[];
  max_diameter_mm: number[];
  csa_ref_mm2: number;
  /** How the reference was obtained — the mode applied, the sorted bracket, a sentence. */
  reference?: 'auto' | 'manual';
  ref_range_k?: [number, number] | null;
  ref_method?: string;
  capped_at_glottis?: boolean;
  min_csa_mm2: number;
  min_csa_index: number;
  min_csa_lps: Triple;
  stenosis_pct: number;
  stenosis_length_mm: number;
  distance_from_glottis_mm: number | null;
  myer_cotton_grade: 'I' | 'II' | 'III' | 'IV' | null;
  took_ms: number;
}

/* ---- AI segmentation (routes added separately; may 404) ---- */

export type AiModelId = 'totalseg' | 'hnlnl';

export interface AiTaskInfo {
  id: string;
  name?: string;
  available?: boolean;
  reason?: string;
}

export interface AiModelInfo {
  id: string;
  name?: string;
  available: boolean;
  reason?: string;
  tasks: AiTaskInfo[];
}

export interface AiSegmentRequest {
  series_uid: string;
  model: AiModelId;
  tasks?: string[];
  roi_subset?: string[];
  fast?: boolean;
}

export interface AiStructure {
  name: string;
  label_id: string;
  n_voxels: number;
  volume_ml: number;
  color: [number, number, number];
}

export interface AiJob {
  status: 'queued' | 'running' | 'done' | 'error';
  progress?: number;
  log_tail?: string | string[];
  structures?: AiStructure[];
  error?: string;
}

/**
 * `GET /api/ai/models` has no frozen shape in CONTRACT.md beyond "availability
 * per model/task", so normalise whatever comes back into AiModelInfo[] rather
 * than trusting one layout.
 */
/** One task row, whatever the backend calls its fields. */
function taskOf(raw: unknown): AiTaskInfo {
  const t = (raw ?? {}) as Record<string, unknown>;
  const missing = Array.isArray(t.missing_weights) ? (t.missing_weights as unknown[]) : [];
  const available = t.available !== false && t.weights_present !== false && missing.length === 0;
  const reason =
    (t.reason as string | undefined) ??
    (missing.length ? `weights missing: ${missing.slice(0, 3).join(', ')}` : undefined);
  return {
    id: String(t.id ?? t.task ?? t.name ?? ''),
    name: (t.title ?? t.label) as string | undefined,
    available,
    reason: available ? undefined : (reason ?? 'not installed'),
  };
}

export function normaliseAiModels(raw: unknown): AiModelInfo[] {
  const rows: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { models?: unknown })?.models)
      ? ((raw as { models: unknown[] }).models)
      : raw && typeof raw === 'object'
        ? Object.entries(raw as Record<string, unknown>).map(([id, v]) =>
            v && typeof v === 'object' ? { id, ...(v as object) } : { id, available: Boolean(v) },
          )
        : [];

  return rows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => {
      const rawTasks = r.tasks;
      const tasks: AiTaskInfo[] = Array.isArray(rawTasks)
        ? rawTasks.map((t) => (typeof t === 'string' ? { id: t, available: true } : taskOf(t)))
        : rawTasks && typeof rawTasks === 'object'
          ? Object.entries(rawTasks as Record<string, unknown>).map(([id, v]) => ({
              id,
              available:
                v && typeof v === 'object'
                  ? (v as { available?: boolean }).available !== false
                  : Boolean(v),
              reason: v && typeof v === 'object' ? (v as { reason?: string }).reason : undefined,
            }))
          : [];
      return {
        id: String(r.id ?? r.model ?? r.name ?? ''),
        name: (r.name ?? r.title ?? r.label) as string | undefined,
        available: r.available !== false,
        reason: r.reason as string | undefined,
        tasks: tasks.filter((t) => t.id),
      };
    })
    .filter((m) => m.id);
}

function post<T>(path: string, body: unknown, timeoutMs = 180_000): Promise<T> {
  return req<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs,
  });
}

export const analysis = {
  threshold: (body: ThresholdRequest) => post<LabelStats>('/api/analysis/threshold', body),

  regionGrow: (body: RegionGrowRequest) => post<LabelStats>('/api/analysis/region-grow', body),

  labelStats: (labelId: string) =>
    req<LabelStats>(`/api/analysis/label/${encodeURIComponent(labelId)}/stats`),

  deleteLabel: (labelId: string) =>
    req<{ deleted: string; labels: number }>(
      `/api/analysis/label/${encodeURIComponent(labelId)}`,
      { method: 'DELETE' },
    ),

  distance: (labelA: string, labelB: string) =>
    post<DistanceResult>('/api/analysis/distance', { label_a: labelA, label_b: labelB }),

  airway: (body: AirwayRequest) => post<AirwayResult>('/api/analysis/airway', body, 300_000),

  maskUrl: (labelId: string) => `/api/analysis/label/${encodeURIComponent(labelId)}/mask`,

  meshUrl: (labelId: string, smoothIters = 10, step = 1) =>
    `/api/analysis/label/${encodeURIComponent(labelId)}/mesh?smooth_iters=${smoothIters}&step=${step}`,

  /** Binary STL of a label, for the 3D surface fallback and the export button. */
  async mesh(labelId: string, smoothIters = 10, step = 1): Promise<ArrayBuffer> {
    const res = await fetch(analysis.meshUrl(labelId, smoothIters, step));
    if (!res.ok) throw new ApiError(await readErrorDetail(res), res.status);
    return res.arrayBuffer();
  },
};

export const ai = {
  models: () => req<unknown>('/api/ai/models', { timeoutMs: 20_000 }).then(normaliseAiModels),

  segment: (body: AiSegmentRequest) =>
    post<{ job_id: string; status: string }>('/api/ai/segment', body, 30_000),

  job: (jobId: string) => req<AiJob>(`/api/ai/jobs/${encodeURIComponent(jobId)}`, { timeoutMs: 20_000 }),
};
