/**
 * "Segment anatomy (AI)" — the card that makes the viewer know the anatomy.
 *
 * Availability is read once when the card opens. The /api/ai/* routes may not
 * exist in a given backend build, so a 404 is a calm "not available yet" state
 * rather than an error: everything else in Margin keeps working.
 *
 * Job progress uses the Margin mark, not a spinner, so a segmentation running
 * in the background reads the same as a volume streaming or an import copying.
 */
import { useEffect } from 'react';

import { useAppStore } from '../../store/useAppStore';
import { APP_NAME } from '../../config';
import { Banner, Button, Icon, MarginMark } from '../../ui';
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
    job.progress === null ? null : Math.round(job.progress <= 1 ? job.progress * 100 : job.progress);
  const done = job.status === 'done';
  const failed = job.status === 'error';

  return (
    <div className="ai-job">
      <div className="ai-job-head">
        {done ? (
          <Icon name="checkCircle" size={15} weight="fill" />
        ) : failed ? (
          <Icon name="warningCircle" size={15} weight="fill" />
        ) : (
          <MarginMark size={15} progress={job.progress} />
        )}
        <span className="nm">{job.taskLabel}</span>
        <span className="mono st">{job.status}</span>
        <button type="button" className="st-icon" aria-label="Dismiss" onClick={() => cancelJobWatch()}>
          <Icon name="close" size={13} />
        </button>
      </div>

      <div className="ai-bar" role="progressbar" aria-valuenow={pct ?? undefined}>
        <i
          className={pct === null && !done ? 'indet' : ''}
          style={{ width: done ? '100%' : pct === null ? undefined : `${pct}%` }}
        />
      </div>
      {pct !== null && !done && <div className="ai-pct mono">{pct} %</div>}

      {job.error && <div className="ai-err">{job.error}</div>}

      {job.log.length > 0 && <pre className="ai-log">{job.log.join('\n')}</pre>}

      {done && job.structures && (
        <div className="ai-done">
          {job.structures.length} structures added — the cursor now names them.
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
      type="button"
      className="ai-task"
      disabled={disabled}
      title={av.available ? hint : (av.reason ?? hint)}
      onClick={() => void runSegmentation(model, taskId, label)}
    >
      <Icon name="sparkle" size={15} />
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
          <Icon name="brain" size={17} />
          <span className="ct-name">Segment anatomy (AI)</span>
          <button
            type="button"
            className="st-icon"
            aria-label="Check again which models are installed"
            onClick={() => void loadModels()}
          >
            <Icon name="refresh" size={13} />
          </button>
        </div>
        <p className="ct-desc">
          Whole-region segmentation with TotalSegmentator’s head &amp; neck tasks, or the Robbins
          nodal levels with HNLNL. Everything runs locally; results land in the Structures list and
          the cursor starts naming what it is over.
        </p>

        {status === 'loading' && (
          <div className="ai-state">
            <MarginMark size={14} progress={null} />
            <span>Checking which models are installed…</span>
          </div>
        )}

        {status === 'unavailable' && (
          <Banner kind="warn">
            AI routes not available yet — this build of the backend has no <code>/api/ai</code>.
            Everything else in {APP_NAME} works as normal.
          </Banner>
        )}

        {status === 'error' && <Banner kind="err">{error ?? 'The model list could not be read.'}</Banner>}
      </div>

      {status === 'ready' && (
        <>
          <div className="mg-section">TotalSegmentator · head &amp; neck</div>
          <div className="ai-tasks">
            {TOTALSEG_TASKS.map((t) => (
              <TaskButton key={t.id} model="totalseg" taskId={t.id} label={t.label} hint={t.hint} />
            ))}
          </div>

          <div className="mg-section">Nodal levels</div>
          <div className="ai-tasks">
            <TaskButton model="hnlnl" taskId={HNLNL_TASK.id} label={HNLNL_TASK.label} hint={HNLNL_TASK.hint} />
          </div>
        </>
      )}

      <JobCard />

      {status === 'ready' && (
        <Button
          size="sm"
          tone="ghost"
          block
          icon="info"
          title="Where these numbers come from"
          onClick={() => undefined}
        >
          Starting contours to correct, never measurements
        </Button>
      )}
    </>
  );
}
