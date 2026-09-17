import { useMemo, useState } from 'react';
import { ChevronRight, FolderPlus, HardDrive, Layers, RefreshCw, Search, Server } from 'lucide-react';
import { api, formatDicomDate, formatPersonName, type Series } from '../api/client';
import { useAppStore } from '../store/useAppStore';
import { openSeries, refreshLibrary, toggleStudy } from '../library';
import { APP_NAME } from '../config';

function SeriesCard({ s, active }: { s: Series; active: boolean }) {
  const [broken, setBroken] = useState(false);
  const px = s.pixel_spacing ? `${s.pixel_spacing[0].toFixed(2)} mm` : '—';
  return (
    <button
      className={`series-card${active ? ' on' : ''}`}
      onClick={() => void openSeries(s)}
      title={s.description ?? s.series_uid}
    >
      <span
        className="series-thumb"
        style={broken ? undefined : { backgroundImage: `url(${api.thumbnailUrl(s.series_uid)})` }}
      >
        {broken && <Layers size={16} strokeWidth={1.5} />}
        {!broken && (
          <img
            src={api.thumbnailUrl(s.series_uid)}
            alt=""
            style={{ display: 'none' }}
            onError={() => setBroken(true)}
          />
        )}
        {s.is_3d && <span className="b3d">3D</span>}
      </span>
      <span className="series-name">
        {s.series_number !== null ? `${s.series_number}. ` : ''}
        {s.description || 'Unnamed series'}
      </span>
      <span className="series-meta">
        {s.modality ?? '??'} · {s.instance_count} img · {px}
      </span>
    </button>
  );
}

export function Library() {
  const backend = useAppStore((s) => s.backend);
  const studies = useAppStore((s) => s.studies);
  const patients = useAppStore((s) => s.patients);
  const health = useAppStore((s) => s.health);
  const seriesByStudy = useAppStore((s) => s.seriesByStudy);
  const expandedStudy = useAppStore((s) => s.expandedStudy);
  const activeSeries = useAppStore((s) => s.activeSeries);
  const busy = useAppStore((s) => s.libraryBusy);
  const set = useAppStore((s) => s.set);
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return studies;
    return studies.filter((s) =>
      [s.patient_name, s.patient_id, s.description, s.accession, ...(s.modalities ?? [])]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(t)),
    );
  }, [studies, q]);

  if (backend !== 'up') {
    return (
      <div className="library">
        <div className="empty">
          <Server size={40} strokeWidth={1} className="art" />
          <h2>The local index isn’t answering</h2>
          <p>
            {APP_NAME} keeps every image on this machine — the viewer talks only to 127.0.0.1. Start the
            index service and this page fills in by itself.
          </p>
          <code>powershell -ExecutionPolicy Bypass -File backend\run.ps1</code>
          <div className="empty-actions">
            <button className="btn" onClick={() => void refreshLibrary()}>
              <RefreshCw size={14} strokeWidth={1.5} className={busy ? 'spin' : undefined} />
              Retry now
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="library">
      <div className="lib-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="lib-title">Library</div>
          <div className="lib-sub">
            {patients.length} patients · {studies.length} studies
            {health?.studies_root && (
              <>
                {' · '}
                <span className="mono" title={health.studies_root}>
                  <HardDrive size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
                  {health.studies_root}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="search">
          <Search size={15} strokeWidth={1.5} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Patient, MRN, accession, modality…"
            spellCheck={false}
          />
        </div>
        <button className="btn" onClick={() => void refreshLibrary()} title="Refresh">
          <RefreshCw size={14} strokeWidth={1.5} className={busy ? 'spin' : undefined} />
        </button>
        <button className="btn primary" onClick={() => set({ importOpen: true })}>
          <FolderPlus size={14} strokeWidth={1.5} />
          Import folder
        </button>
      </div>

      <div className="lib-body">
        {filtered.length === 0 ? (
          <div className="empty" style={{ position: 'relative', minHeight: 320 }}>
            <Layers size={36} strokeWidth={1} className="art" />
            {studies.length === 0 ? (
              <>
                <h2>Nothing indexed yet</h2>
                <p>
                  Point {APP_NAME} at a folder of DICOM files. Files are indexed in place and only headers
                  are read, so a study takes seconds.
                </p>
                <div className="empty-actions">
                  <button className="btn primary" onClick={() => set({ importOpen: true })}>
                    <FolderPlus size={14} strokeWidth={1.5} />
                    Import a folder
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2>No matches</h2>
                <p>Nothing in the library matches “{q}”.</p>
              </>
            )}
          </div>
        ) : (
          <table className="lib-table">
            <thead>
              <tr>
                <th style={{ width: 22 }} />
                <th>Patient</th>
                <th>MRN</th>
                <th>Study</th>
                <th>Date</th>
                <th>Contents</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((st) => {
                const open = expandedStudy === st.study_uid;
                const list = seriesByStudy[st.study_uid];
                return (
                  <tr key={st.study_uid}>
                    <td colSpan={6}>
                      <button
                        className={`study-row${open ? ' on' : ''}`}
                        onClick={() => void toggleStudy(st.study_uid)}
                      >
                        <ChevronRight size={14} strokeWidth={1.5} className={`chev${open ? ' open' : ''}`} />
                        <span className="nm">{formatPersonName(st.patient_name)}</span>
                        <span className="mrn">{st.patient_id || '—'}</span>
                        <span className="desc">{st.description || 'No description'}</span>
                        <span className="dt">{formatDicomDate(st.study_date)}</span>
                        <span className="tags">
                          {(st.modalities ?? []).map((m) => (
                            <span className="tag" key={m}>
                              {m}
                            </span>
                          ))}
                          <span className="tag">{st.series_count}s</span>
                        </span>
                      </button>

                      {open && (
                        <div className="series-strip">
                          {!list ? (
                            <div className="empty-note" style={{ padding: 16 }}>
                              Loading series…
                            </div>
                          ) : list.length === 0 ? (
                            <div className="empty-note" style={{ padding: 16 }}>
                              No series in this study.
                            </div>
                          ) : (
                            list.map((s) => (
                              <SeriesCard
                                key={s.series_uid}
                                s={s}
                                active={activeSeries?.series_uid === s.series_uid}
                              />
                            ))
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
