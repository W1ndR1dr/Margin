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
}

export interface Instance {
  sop_uid: string;
  instance_number: number | null;
  ipp: [number, number, number] | null;
  slice_pos: number | null;
}

export type SeriesDetail = Series & { instances: Instance[] };

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
