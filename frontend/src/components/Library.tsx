/**
 * The Library screen (UI-OVERHAUL.md §3).
 *
 *   header with count line and store path · search · drop zone with progress ·
 *   table Patient / MRN / Latest study / Date / Anatomy / Flags ·
 *   readiness pill per patient · right column: tumour board, background work,
 *   store size
 *
 * Three ways in, because the one that works depends on where the data is:
 *   1. drop a folder (or files) anywhere on this screen — streamed to the
 *      backend in batches and copied into the store;
 *   2. "Browse folder…" — a native picker ON THE SERVER MACHINE;
 *   3. a typed path — the fallback that always works.
 * (1) and (2) need backend routes that do not exist yet, so both degrade to a
 * plain sentence rather than an error.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';

import { api, formatDicomDate, formatPersonName, type Series, type Study } from '../api/client';
import {
  filesFromInput,
  formatBytes,
  formatCount,
  walkDataTransfer,
  type ImportProgress,
} from '../api/importClient';
import { useAppStore } from '../store/useAppStore';
import {
  importDropped,
  loadSeries,
  openCompareSeries,
  openSeries,
  refreshLibrary,
  toggleStudy,
} from '../library';
import { useAiStore } from '../tools/ai';
import {
  groupSeries,
  inferSequenceKind,
  isThickSeries,
  normaliseModality,
  sameFrameOfReference,
  SEQUENCE_LABEL,
} from '../viewer/modality';
import { APP_NAME } from '../config';
import { Button, Chip, Field, Icon, MarginMark, Pill, filterPalette, type PaletteItem } from '../ui';

/* ------------------------------------------------------------------ */
/* readiness                                                           */
/* ------------------------------------------------------------------ */

type Readiness =
  | { state: 'ready'; count: number }
  | { state: 'segmenting'; progress: number | null }
  | { state: 'queued' }
  | { state: 'none' };

/**
 * What Margin already knows about a study, from the AI job list plus whatever
 * structures are cached for the series that is open. Until the backend keeps a
 * per-series structure cache this is honest about what it can see: a running
 * job, a queued one, or nothing.
 */
function useReadiness(): (study: Study) => Readiness {
  const job = useAiStore((s) => s.job);
  const activeSeries = useAppStore((s) => s.activeSeries);
  const seriesByStudy = useAppStore((s) => s.seriesByStudy);

  return (study: Study): Readiness => {
    const list = seriesByStudy[study.study_uid];
    const uids = new Set((list ?? []).map((s) => s.series_uid));
    const mine = activeSeries && uids.has(activeSeries.series_uid);

    if (job && mine) {
      if (job.status === 'queued') return { state: 'queued' };
      if (job.status === 'running') return { state: 'segmenting', progress: job.progress };
      if (job.status === 'done' && job.structures) {
        return { state: 'ready', count: job.structures.length };
      }
    }
    return { state: 'none' };
  };
}

function ReadinessPill({ r }: { r: Readiness }) {
  if (r.state === 'ready') {
    return (
      <Pill tone="ok" icon="sparkle">
        ready · {r.count} structures
      </Pill>
    );
  }
  if (r.state === 'segmenting') {
    return (
      <Pill tone="accent" progress={r.progress}>
        segmenting{r.progress !== null ? ` ${Math.round(r.progress * 100)} %` : '…'}
      </Pill>
    );
  }
  if (r.state === 'queued') return <Pill tone="warn">queued</Pill>;
  return <Pill tone="muted">not run</Pill>;
}

/* ------------------------------------------------------------------ */
/* series card + sequence browser                                      */
/* ------------------------------------------------------------------ */

function SeriesCard({ s, active }: { s: Series; active: boolean }) {
  const [broken, setBroken] = useState(false);
  const open = useAppStore((st) => st.activeSeries);
  const linked = useAppStore((st) => st.compareSeries);
  const kind = inferSequenceKind(s);
  const thick = isThickSeries(s);
  const px = s.pixel_spacing ? `${s.pixel_spacing[0].toFixed(2)} mm` : '—';

  /**
   * Linking is only meaningful between series that share a FrameOfReference:
   * that is the guarantee that the same millimetres mean the same anatomy, and
   * it is what makes world-position sync correct rather than coincidental.
   */
  const canLink =
    !active && s.is_3d && open !== null && sameFrameOfReference(open, s) && linked?.series_uid !== s.series_uid;

  return (
    <div className={`series-card${active ? ' on' : ''}${linked?.series_uid === s.series_uid ? ' linked' : ''}`}>
      <button
        type="button"
        className="series-open"
        onClick={() => void openSeries(s)}
        title={s.description ?? s.series_uid}
      >
      <span
        className="series-thumb"
        style={broken ? undefined : { backgroundImage: `url(${api.thumbnailUrl(s.series_uid)})` }}
      >
        {broken && <Icon name="image" size={16} />}
        {!broken && (
          <img
            src={api.thumbnailUrl(s.series_uid)}
            alt=""
            style={{ display: 'none' }}
            onError={() => setBroken(true)}
          />
        )}
        <span className="series-badges">
          {s.is_3d && <span className="sb">3D</span>}
          {kind && <span className="sb kind">{SEQUENCE_LABEL[kind]}</span>}
          {thick && <span className="sb thick">thick</span>}
        </span>
      </span>
      <span className="series-name">
        {s.series_number !== null ? `${s.series_number}. ` : ''}
        {s.description || 'Unnamed series'}
      </span>
        <span className="series-meta mono">
          {s.modality ?? '??'} · {s.instance_count} img · {px}
        </span>
      </button>
      {canLink && (
        <button
          type="button"
          className="series-link"
          title="Show in the context strip, scroll-linked by world position"
          onClick={() => void openCompareSeries(s)}
        >
          <Icon name="link" size={12} />
          Link
        </button>
      )}
      {linked?.series_uid === s.series_uid && (
        <button
          type="button"
          className="series-link on"
          title="Unlink"
          onClick={() => useAppStore.getState().set({ compareSeries: null })}
        >
          <Icon name="unlink" size={12} />
          Linked
        </button>
      )}
    </div>
  );
}

/**
 * The sequence browser: a study's series grouped by modality, and within MR by
 * sequence kind. On a neck MR that turns twelve identically named series into
 * "T1 · T1 +C · T2 · STIR · DWI · ADC", which is the difference between
 * hunting and picking.
 */
function SeriesStrip({ list }: { list: Series[] | undefined }) {
  const activeSeries = useAppStore((s) => s.activeSeries);
  const groups = useMemo(() => (list ? groupSeries(list) : []), [list]);

  if (!list) {
    return (
      <div className="series-strip loading">
        <MarginMark size={18} progress={null} />
        Loading series…
      </div>
    );
  }
  if (!list.length) return <div className="series-strip empty">No series in this study.</div>;

  return (
    <div className="series-groups">
      {groups.map((g) => (
        <div className="series-group" key={g.key}>
          <div className="sg-head">
            <span className="sg-label">{g.label}</span>
            <span className="sg-count mono">{g.series.length}</span>
          </div>
          <div className="series-strip">
            {g.series.map((s) => (
              <SeriesCard
                key={s.series_uid}
                s={s}
                active={activeSeries?.series_uid === s.series_uid}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* drop zone                                                           */
/* ------------------------------------------------------------------ */

function DropProgress({ p }: { p: ImportProgress }) {
  const frac = p.bytesTotal > 0 ? p.bytesSent / p.bytesTotal : null;
  return (
    <div className="drop-progress">
      <MarginMark size={22} progress={p.phase === 'indexing' ? null : frac} />
      <div className="dp-body">
        <div className="dp-line">
          {p.phase === 'scanning' && `Reading the folder — ${formatCount(p.filesTotal)} files so far`}
          {p.phase === 'uploading' &&
            `Copying ${formatCount(p.filesSent)} / ${formatCount(p.filesTotal)} files · ${formatBytes(
              p.bytesSent,
            )} of ${formatBytes(p.bytesTotal)}`}
          {p.phase === 'indexing' && 'Reading headers and indexing…'}
          {p.phase === 'done' && 'Import complete'}
        </div>
        <div className="dp-bar">
          <i style={{ width: `${frac !== null ? frac * 100 : 100}%` }} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* the screen                                                          */
/* ------------------------------------------------------------------ */

export function Library() {
  const backend = useAppStore((s) => s.backend);
  const studies = useAppStore((s) => s.studies);
  const patients = useAppStore((s) => s.patients);
  const health = useAppStore((s) => s.health);
  const seriesByStudy = useAppStore((s) => s.seriesByStudy);
  const expandedStudy = useAppStore((s) => s.expandedStudy);
  const busy = useAppStore((s) => s.libraryBusy);
  const job = useAiStore((s) => s.job);
  const set = useAppStore((s) => s.set);
  const readinessOf = useReadiness();

  const [q, setQ] = useState('');
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  /* ---- search: the same fuzzy matcher the palette uses ---- */
  const filtered = useMemo(() => {
    if (!q.trim()) return studies;
    const items: PaletteItem[] = studies.map((s) => ({
      id: s.study_uid,
      group: 'Study',
      label: `${formatPersonName(s.patient_name)} ${s.description ?? ''}`,
      keywords: `${s.patient_id ?? ''} ${s.accession ?? ''} ${(s.modalities ?? []).join(' ')} ${
        s.study_date ?? ''
      }`,
      run: () => undefined,
    }));
    const hits = new Set(filterPalette(items, q, 500).map((i) => i.id));
    return studies.filter((s) => hits.has(s.study_uid));
  }, [studies, q]);

  /* ---- drag and drop ---- */
  const onDragEnter = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current += 1;
    if (e.dataTransfer?.types?.includes('Files')) setDragging(true);
  };
  const onDragLeave = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragging(false);
    }
  };
  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const dt = e.dataTransfer;
    if (!dt) return;

    setProgress({
      phase: 'scanning',
      filesTotal: 0,
      filesSent: 0,
      bytesTotal: 0,
      bytesSent: 0,
      batchIndex: 0,
      batchCount: 0,
    });

    const walk = await walkDataTransfer(dt.items, {
      onCount: (n) =>
        setProgress((p) => (p ? { ...p, filesTotal: n } : p)),
    });

    if (!walk.files.length) {
      setProgress(null);
      useAppStore.getState().toast({
        kind: 'err',
        title: 'Nothing to import',
        message: 'That drop contained no files.',
      });
      return;
    }

    const final = await importDropped(walk.files, walk.rootName, setProgress);
    setProgress(final.phase === 'done' ? final : null);
    if (final.phase === 'done') window.setTimeout(() => setProgress(null), 2500);
  };

  /**
   * Fetch a study's series whenever a row is expanded, wherever the expansion
   * came from. `toggleStudy` does it for a click, but the command palette and
   * the study timeline set `expandedStudy` directly — without this the row
   * opened onto a permanent "Loading series…".
   */
  useEffect(() => {
    if (expandedStudy && !seriesByStudy[expandedStudy]) void loadSeries(expandedStudy);
  }, [expandedStudy, seriesByStudy]);

  // A stray drop outside the zone would navigate the tab to the file. Kill it.
  useEffect(() => {
    const stop = (e: Event) => e.preventDefault();
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, []);

  if (backend !== 'up') {
    return (
      <div className="library">
        <div className="mg-empty" style={{ marginTop: '12vh' }}>
          <Icon name="drive" size={36} className="mg-empty-ico" />
          <h3>The local index isn’t answering</h3>
          <p>
            {APP_NAME} keeps every image on this machine — the viewer talks only to 127.0.0.1. Start
            the index service and this page fills in by itself.
          </p>
          <code className="mg-code">powershell -ExecutionPolicy Bypass -File backend\run.ps1</code>
          <Button icon="refresh" busy={busy} onClick={() => void refreshLibrary()}>
            Retry now
          </Button>
        </div>
      </div>
    );
  }

  const storeRoot = health?.studies_root ?? '';

  return (
    <div
      className={`library${dragging ? ' dragging' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={(e) => void onDrop(e)}
    >
      <header className="lib-head">
        <div className="lib-titles">
          <h1>Library</h1>
          <div className="lib-sub">
            <span className="mono">{patients.length}</span> patients ·{' '}
            <span className="mono">{studies.length}</span> studies
            {storeRoot && (
              <>
                {' · '}
                <span className="lib-path mono" title={storeRoot}>
                  <Icon name="drive" size={11} />
                  {storeRoot}
                </span>
              </>
            )}
          </div>
        </div>

        <Field
          className="lib-search"
          icon="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Patient, MRN, modality…"
          aria-label="Search the library"
        />

        <Button icon="refresh" iconOnly aria-label="Refresh" busy={busy} onClick={() => void refreshLibrary()} />
        <Button tone="primary" icon="folderAdd" onClick={() => set({ importOpen: true })}>
          Import
        </Button>
      </header>

      <div className="lib-main">
        <div className="lib-left">
          {/* drop zone — always visible, so the affordance is discoverable */}
          <div className={`dropzone${dragging ? ' hot' : ''}${progress ? ' busy' : ''}`}>
            {progress ? (
              <DropProgress p={progress} />
            ) : (
              <>
                <Icon name="upload" size={20} />
                <div className="dz-text">
                  <strong>Drop a study folder here</strong>
                  <span>
                    Files are copied into the {APP_NAME} store and indexed. Or{' '}
                    <button type="button" className="dz-link" onClick={() => fileInput.current?.click()}>
                      choose files
                    </button>{' '}
                    ·{' '}
                    <button type="button" className="dz-link" onClick={() => set({ importOpen: true })}>
                      browse a folder on this machine
                    </button>
                  </span>
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    const walk = filesFromInput(e.target.files);
                    if (walk.files.length) void importDropped(walk.files, walk.rootName, setProgress);
                    e.target.value = '';
                  }}
                />
              </>
            )}
          </div>

          {filtered.length === 0 ? (
            <div className="mg-empty">
              <Icon name="series" size={30} className="mg-empty-ico" />
              {studies.length === 0 ? (
                <>
                  <h3>Nothing indexed yet</h3>
                  <p>
                    Drop a folder above, or point {APP_NAME} at one already on this machine. Only
                    headers are read, so a study takes seconds.
                  </p>
                </>
              ) : (
                <>
                  <h3>No matches</h3>
                  <p>Nothing in the library matches “{q}”.</p>
                </>
              )}
            </div>
          ) : (
            <div className="lib-table" role="table">
              <div className="lt-head" role="row">
                <span role="columnheader">Patient</span>
                <span role="columnheader">MRN</span>
                <span role="columnheader">Latest study</span>
                <span role="columnheader">Date</span>
                <span role="columnheader">Anatomy</span>
                <span role="columnheader">Flags</span>
              </div>

              {filtered.map((st) => {
                const open = expandedStudy === st.study_uid;
                const r = readinessOf(st);
                return (
                  <div className="lt-group" key={st.study_uid}>
                    <button
                      type="button"
                      className={`lt-row${open ? ' on' : ''}`}
                      role="row"
                      onClick={() => void toggleStudy(st.study_uid)}
                      aria-expanded={open}
                    >
                      <span className="lt-name">
                        <Icon name={open ? 'caretDown' : 'caretRight'} size={12} className="lt-chev" />
                        {formatPersonName(st.patient_name)}
                      </span>
                      <span className="lt-mrn mono">{st.patient_id || '—'}</span>
                      <span className="lt-desc">{st.description || 'No description'}</span>
                      <span className="lt-date mono">{formatDicomDate(st.study_date)}</span>
                      <span className="lt-ready">
                        <ReadinessPill r={r} />
                      </span>
                      <span className="lt-flags">
                        {(st.modalities ?? []).map((m) => (
                          <Chip key={m} size="sm">
                            {m}
                          </Chip>
                        ))}
                        <Chip size="sm">{st.series_count} series</Chip>
                      </span>
                    </button>

                    {open && <SeriesStrip list={seriesByStudy[st.study_uid]} />}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* right column */}
        <aside className="lib-side">
          <section className="lib-card">
            <h2>Tumour board</h2>
            <p className="lc-empty">
              Tag a study for Thursday’s list and it appears here with its key images. Tagging lands
              with the Board workspace.
            </p>
          </section>

          <section className="lib-card">
            <h2>Background work</h2>
            {job ? (
              <div className="bg-job">
                <MarginMark size={18} progress={job.status === 'done' ? 1 : job.progress} />
                <div className="bg-body">
                  <div className="bg-name">{job.taskLabel}</div>
                  <div className="bg-meta mono">
                    {job.status}
                    {job.progress !== null && job.status !== 'done'
                      ? ` · ${Math.round(job.progress * 100)} %`
                      : ''}
                  </div>
                </div>
              </div>
            ) : (
              <p className="lc-empty">
                Nothing running. Segmentation starts from the Structures panel and keeps going while
                you read.
              </p>
            )}
          </section>

          <section className="lib-card">
            <h2>Store</h2>
            <dl className="lc-kv">
              <dt>Images</dt>
              <dd className="mono">{formatCount(studies.reduce((n, s) => n + s.instance_count, 0))}</dd>
              <dt>Series</dt>
              <dd className="mono">{formatCount(studies.reduce((n, s) => n + s.series_count, 0))}</dd>
              <dt>Modalities</dt>
              <dd className="mono">
                {[...new Set(studies.flatMap((s) => s.modalities ?? []))]
                  .map((m) => normaliseModality(m))
                  .filter((m, i, a) => a.indexOf(m) === i)
                  .join(' · ') || '—'}
              </dd>
              <dt>Location</dt>
              <dd className="mono tiny">{storeRoot || '—'}</dd>
            </dl>
          </section>
        </aside>
      </div>

      {dragging && (
        <div className="drop-veil">
          <MarginMark size={44} />
          <strong>Drop to import</strong>
          <span>Folders are walked recursively. Nothing leaves this machine.</span>
        </div>
      )}
    </div>
  );
}
