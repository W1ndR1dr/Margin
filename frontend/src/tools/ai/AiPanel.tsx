/**
 * "Segment anatomy (AI)" — the third Tools card.
 *
 * Availability is read once when the card opens. The /api/ai/* routes are
 * built separately, so a 404 is shown as a calm "not available yet" state
 * rather than an error.
 */
import { useEffect } from 'react';
import { BrainCircuit, Loader, RefreshCw, Sparkles, TriangleAlert, X } from 'lucide-react';

import { useAppStore } from '../../store/useAppStore';
import { APP_NAME } from '../../config';
import {
  HNLNL_TASK,
  TOTALSEG_TASKS,
  availability,
  cancelJobWatch,
  loadModels,
  runSegmentation,
  useAiStore,
} from './aiStore';
import './ai.css';

function JobCard() {
  const job = useAiStore((s) => s.job);
  if (!job) return null;

  const pct =
    job.progress === null
      ? null
      : Math.round(job.progress <= 1 ? job.progress * 100 : job.progress);

  return (
    <div className="ai-job">
      <div className="ai-job-head">
        {job.status === 'done' ? (
          <Sparkles size={14} strokeWidth={1.8} />
        ) : job.status === 'error' ? (
          <TriangleAlert size={14} strokeWidth={1.8} />
        ) : (
          <Loader size={14} strokeWidth={1.8} className="spin" />
        )}
        <span className="nm">{job.taskLabel}</span>
        <span className="mono st">{job.status}</span>
        <button className="st-icon" title="Dismiss" onClick={() => cancelJobWatch()}>
          <X size={13} strokeWidth={1.8} />
        </button>
      </div>

      <div className="ai-bar" role="progressbar" aria-valuenow={pct ?? undefined}>
        <i
          className={pct === null && job.status !== 'done' ? 'indet' : ''}
          style={{ width: job.status === 'done' ? '100%' : pct === null ? undefined : `${pct}%` }}
        />
      </div>
      {pct !== null && job.status !== 'done' && <div className="ai-pct mono">{pct} %</div>}

      {job.error && <div className="ai-err">{job.error}</div>}

      {job.log.length > 0 && (
        <pre className="ai-log">{job.log.join('\n')}</pre>
      )}

      {job.status === 'done' && job.structures && (
        <div className="ai-done">
          {job.structures.length} structures added to the Structures tab.
        </div>
      )}
    </div>
  );
}

function TaskButton({
  model,
  taskId,
  label,
  hint,
}: {
  model: 'totalseg' | 'hnlnl';
  taskId: string;
  label: string;
  hint: string;
}) {
  const models = useAiStore((s) => s.models);
  const status = useAiStore((s) => s.status);
  const job = useAiStore((s) => s.job);
  const layout = useAppStore((s) => s.layout);

  const av = status === 'ready' ? availability(models, model, taskId) : { available: false };
  const running = job !== null && job.status !== 'done' && job.status !== 'error';
  const disabled = status !== 'ready' || !av.available || running || layout !== 'mpr';

  return (
    <button
      className="btn ai-task"
      disabled={disabled}
      title={av.available ? hint : (av.reason ?? hint)}
      onClick={() => void runSegmentation(model, taskId, label)}
    >
      <span className="l">{label}</span>
      <span className="h">{av.available || status !== 'ready' ? hint : (av.reason ?? 'unavailable')}</span>
    </button>
  );
}

export function AiPanel() {
  const status = useAiStore((s) => s.status);
  const error = useAiStore((s) => s.error);

  useEffect(() => {
    if (useAiStore.getState().status === 'idle') void loadModels();
  }, []);

  return (
    <>
      <div className="ct-card">
        <div className="ct-head">
          <BrainCircuit size={16} strokeWidth={1.5} />
          <span className="ct-name">Segment anatomy (AI)</span>
          <button
            className="st-icon"
            title="Check again which models are installed"
            onClick={() => void loadModels()}
          >
            <RefreshCw size={13} strokeWidth={1.8} />
          </button>
        </div>
        <p className="ct-desc">
          Whole-region segmentation with TotalSegmentator's head &amp; neck tasks, or the Robbins
          nodal levels with HNLNL. Everything runs locally; results land in the Structures tab.
        </p>

        {status === 'loading' && (
          <div className="ai-state">
            <Loader size={13} strokeWidth={1.8} className="spin ico" />
            <span>Checking which models are installed…</span>
          </div>
        )}

        {status === 'unavailable' && (
          <div className="ai-state warn">
            <TriangleAlert size={13} strokeWidth={1.8} className="ico" />
            <span>
              AI routes not available yet — this build of the backend has no <code>/api/ai</code>.
              Everything else in {APP_NAME} works as normal.
            </span>
          </div>
        )}

        {status === 'error' && (
          <div className="ai-state warn">
            <TriangleAlert size={13} strokeWidth={1.8} className="ico" />
            <span>{error ?? 'The model list could not be read.'}</span>
          </div>
        )}
      </div>

      {status === 'ready' && (
        <>
          <div className="panel-title">TotalSegmentator · head &amp; neck</div>
          <div className="ai-tasks">
            {TOTALSEG_TASKS.map((t) => (
              <TaskButton key={t.id} model="totalseg" taskId={t.id} label={t.label} hint={t.hint} />
            ))}
          </div>

          <div className="panel-title">Nodal levels</div>
          <div className="ai-tasks">
            <TaskButton
              model="hnlnl"
              taskId={HNLNL_TASK.id}
              label={HNLNL_TASK.label}
              hint={HNLNL_TASK.hint}
            />
          </div>
        </>
      )}

      <JobCard />
    </>
  );
}
