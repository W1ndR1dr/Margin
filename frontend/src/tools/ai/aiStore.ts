/**
 * AI segmentation: model availability, one job at a time, and the hand-off of
 * the finished structures into the Structures tab.
 *
 * The /api/ai/* routes are built separately; until they exist every call 404s,
 * which is a first-class state here rather than an error.
 */
import { create } from 'zustand';

import { ApiError, ai, type AiJob, type AiModelInfo, type AiStructure } from '../../api/client';
import { useAppStore } from '../../store/useAppStore';
import { viewer } from '../../viewer/ViewerCore';
import { addStructureGroup } from '../../labels/structureStore';
import type { Rgb } from '../../labels/colors';

export const POLL_MS = 2000;

export type ModelsStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';

export interface JobState {
  id: string;
  model: string;
  taskLabel: string;
  status: AiJob['status'];
  progress: number | null;
  log: string[];
  error: string | null;
  structures: AiStructure[] | null;
}

interface AiState {
  status: ModelsStatus;
  models: AiModelInfo[];
  error: string | null;
  job: JobState | null;
  set: (patch: Partial<AiState>) => void;
}

export const useAiStore = create<AiState>((set) => ({
  status: 'idle',
  models: [],
  error: null,
  job: null,
  set: (patch) => set(patch),
}));

/** TotalSegmentator head & neck tasks (TOOLS-SPEC.md §2 presets, AI flavour). */
export const TOTALSEG_TASKS: Array<{ id: string; label: string; hint: string }> = [
  { id: 'headneck_bones_vessels', label: 'Bones & vessels', hint: 'Skull, mandible, cervical spine, carotids, jugulars' },
  { id: 'head_glands_cavities', label: 'Glands & cavities', hint: 'Parotid, submandibular, thyroid, sinuses, orbit' },
  { id: 'headneck_muscles', label: 'Muscles', hint: 'Masticator, constrictors, sternocleidomastoid' },
  { id: 'craniofacial_structures', label: 'Craniofacial structures', hint: 'Facial skeleton detail' },
];

export const HNLNL_TASK = { id: 'nodal_levels', label: 'Nodal levels (HNLNL)', hint: 'Robbins levels Ia – VII, both sides' };

/* ------------------------------------------------------------------ */

function logLines(tail: AiJob['log_tail']): string[] {
  if (!tail) return [];
  if (Array.isArray(tail)) return tail.filter((l) => typeof l === 'string');
  return tail.split(/\r?\n/).filter((l) => l.trim().length > 0);
}

export { availability } from './availability';

/** Called when the AI card is opened. Never throws. */
export async function loadModels(): Promise<void> {
  const s = useAiStore.getState();
  if (s.status === 'loading') return;
  s.set({ status: 'loading', error: null });
  try {
    const models = await ai.models();
    useAiStore.getState().set({ status: 'ready', models, error: null });
  } catch (e) {
    const err = e as ApiError;
    if (err?.status === 404) {
      useAiStore.getState().set({ status: 'unavailable', models: [], error: null });
      return;
    }
    useAiStore
      .getState()
      .set({ status: 'error', models: [], error: err?.message ?? String(e) });
  }
}

/* ------------------------------------------------------------------ */
/* running a job                                                      */
/* ------------------------------------------------------------------ */

let pollTimer: number | null = null;

function stopPolling(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function cancelJobWatch(): void {
  stopPolling();
  useAiStore.getState().set({ job: null });
}

export async function runSegmentation(
  model: 'totalseg' | 'hnlnl',
  taskId: string,
  taskLabel: string,
): Promise<void> {
  const app = useAppStore.getState();
  const uid = app.activeSeries?.series_uid;
  if (!uid) {
    app.toast({ kind: 'err', title: 'Open a series first' });
    return;
  }
  if (!viewer.ctVolumeId) {
    app.toast({
      kind: 'err',
      title: 'AI segmentation needs a volumetric series',
      message: 'Open a CT that loads as MPR.',
    });
    return;
  }
  if (useAiStore.getState().job && useAiStore.getState().job?.status !== 'done') return;

  stopPolling();
  useAiStore.getState().set({
    job: {
      id: '',
      model,
      taskLabel,
      status: 'queued',
      progress: null,
      log: [],
      error: null,
      structures: null,
    },
  });

  try {
    const started = await ai.segment(
      model === 'hnlnl'
        ? { series_uid: uid, model }
        : { series_uid: uid, model, tasks: [taskId] },
    );
    const job = useAiStore.getState().job;
    useAiStore.getState().set({
      job: { ...(job as JobState), id: started.job_id, status: 'queued' },
    });
    pollTimer = window.setInterval(() => void poll(started.job_id), POLL_MS);
    void poll(started.job_id);
  } catch (e) {
    const err = e as ApiError;
    stopPolling();
    if (err?.status === 404) {
      useAiStore.getState().set({ status: 'unavailable', job: null });
      return;
    }
    const job = useAiStore.getState().job;
    useAiStore.getState().set({
      job: job ? { ...job, status: 'error', error: err?.message ?? String(e) } : null,
    });
  }
}

let finishing = false;

async function poll(jobId: string): Promise<void> {
  let out: AiJob;
  try {
    out = await ai.job(jobId);
  } catch (e) {
    const err = e as ApiError;
    stopPolling();
    const job = useAiStore.getState().job;
    useAiStore.getState().set({
      job: job
        ? {
            ...job,
            status: 'error',
            error:
              err?.status === 404
                ? 'The backend forgot this job (it may have restarted). Run it again.'
                : (err?.message ?? String(e)),
          }
        : null,
    });
    return;
  }

  const job = useAiStore.getState().job;
  if (!job || (job.id && job.id !== jobId)) return;

  const next: JobState = {
    ...job,
    status: out.status,
    progress: typeof out.progress === 'number' ? out.progress : job.progress,
    log: logLines(out.log_tail).slice(-12),
    error: out.error ?? null,
    structures: out.structures ?? job.structures,
  };
  useAiStore.getState().set({ job: next });

  if (out.status === 'error') {
    stopPolling();
    useAppStore.getState().toast({
      kind: 'err',
      title: `${job.taskLabel} failed`,
      message: out.error ?? 'the model reported an error',
    });
    return;
  }

  if (out.status === 'done') {
    stopPolling();
    if (finishing) return;
    finishing = true;
    try {
      const list = out.structures ?? [];
      if (!list.length) {
        useAppStore.getState().toast({
          kind: 'info',
          title: `${job.taskLabel} finished`,
          message: 'the model returned no structures',
        });
        return;
      }
      await addStructureGroup(
        jobId,
        list.map((s) => ({
          label_id: s.label_id,
          name: s.name,
          volume_ml: s.volume_ml,
          color: normaliseColor(s.color),
        })),
        'ai',
      );
      useAppStore.getState().set({ panelTab: 'structures' });
      useAppStore.getState().toast({
        kind: 'ok',
        title: `${list.length} structures from ${job.taskLabel}`,
        message: 'They are in the Structures tab, grouped by category.',
      });
    } finally {
      finishing = false;
    }
  }
}

function normaliseColor(color: AiStructure['color']): Rgb | undefined {
  if (!Array.isArray(color) || color.length < 3) return undefined;
  const [r, g, b] = color;
  if (![r, g, b].every((c) => typeof c === 'number' && Number.isFinite(c))) return undefined;
  // Some models report 0..1 floats; anything at or under 1 is treated as such.
  const scale = r <= 1 && g <= 1 && b <= 1 ? 255 : 1;
  const out: Rgb = [
    Math.round(Math.max(0, Math.min(255, r * scale))),
    Math.round(Math.max(0, Math.min(255, g * scale))),
    Math.round(Math.max(0, Math.min(255, b * scale))),
  ];
  // Pure black reads as "unset"; let the anatomy palette decide instead.
  return out[0] === 0 && out[1] === 0 && out[2] === 0 ? undefined : out;
}

// A job belongs to one series.
useAppStore.subscribe((s, prev) => {
  if (s.activeSeries?.series_uid !== prev.activeSeries?.series_uid) cancelJobWatch();
});
