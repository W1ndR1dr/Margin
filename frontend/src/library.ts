/**
 * Library actions: talking to the local index, opening a series, importing.
 *
 * Opening a series is where modality stops being cosmetic: `preferredPrimary`
 * decides which plane is the working view, so a 4 mm axial T2 opens in the
 * plane it was acquired in rather than as three blurred reformats.
 */
import { api, ApiError, type Series, type SeriesDetail, type Study } from './api/client';
import {
  uploadAndIndex,
  type DroppedFile,
  type ImportProgress,
} from './api/importClient';
import { useAppStore, type PaneId } from './store/useAppStore';
import { isThickSeries, isMr, planeFromOrientation, preferredPrimary } from './viewer/modality';

/** Ping the backend; returns true when it answered. */
export async function checkBackend(quiet = true): Promise<boolean> {
  const store = useAppStore.getState();
  try {
    const health = await api.health();
    const wasDown = store.backend !== 'up';
    store.set({ backend: 'up', health });
    if (wasDown) await refreshLibrary();
    return true;
  } catch (e) {
    store.set({ backend: 'down' });
    if (!quiet) {
      store.toast({
        kind: 'err',
        title: 'Backend offline',
        message: (e as ApiError)?.message ?? 'No response from 127.0.0.1:8765',
      });
    }
    return false;
  }
}

export async function refreshLibrary(): Promise<void> {
  const store = useAppStore.getState();
  store.set({ libraryBusy: true });
  try {
    const [patients, studies] = await Promise.all([api.patients(), api.studies()]);
    store.set({ patients, studies });
  } catch (e) {
    store.toast({
      kind: 'err',
      title: 'Could not read the library',
      message: (e as Error)?.message,
    });
  } finally {
    useAppStore.getState().set({ libraryBusy: false });
  }
}

export async function toggleStudy(studyUid: string): Promise<void> {
  const store = useAppStore.getState();
  if (store.expandedStudy === studyUid) {
    store.set({ expandedStudy: null });
    return;
  }
  store.set({ expandedStudy: studyUid });
  await loadSeries(studyUid);
}

/** Fetch a study's series list once and cache it. */
export async function loadSeries(studyUid: string): Promise<Series[]> {
  const cached = useAppStore.getState().seriesByStudy[studyUid];
  if (cached) return cached;
  try {
    const list = await api.seriesForStudy(studyUid);
    const s = useAppStore.getState();
    s.set({ seriesByStudy: { ...s.seriesByStudy, [studyUid]: list } });
    return list;
  } catch (e) {
    useAppStore
      .getState()
      .toast({ kind: 'err', title: 'Could not list series', message: (e as Error)?.message });
    return [];
  }
}

/**
 * Which series a study should open on: the largest volumetric one, preferring
 * a CT over an MR scout. Used by the study timeline chips, where the user has
 * asked for "the prior", not for a particular series.
 */
export function bestSeries(list: Series[]): Series | null {
  if (!list.length) return null;
  const scored = [...list].sort((a, b) => {
    const vol = Number(b.is_3d) - Number(a.is_3d);
    if (vol) return vol;
    return b.instance_count - a.instance_count;
  });
  return scored[0] ?? null;
}

export async function openStudyFirstSeries(study: Study): Promise<void> {
  const list = await loadSeries(study.study_uid);
  const pick = bestSeries(list);
  if (!pick) {
    useAppStore.getState().toast({ kind: 'err', title: 'That study has no series' });
    return;
  }
  await openSeries(pick);
}

/**
 * Map an acquired plane onto the pane that shows it. A thick MR acquired
 * coronally is read in the coronal pane; the other two panes become the
 * context strip and are understood to be reformats.
 */
function primaryPaneFor(detail: SeriesDetail): PaneId {
  const pref = preferredPrimary(detail);
  if (pref.plane === 'sagittal') return 'sagittal';
  if (pref.plane === 'coronal') return 'coronal';
  return 'axial';
}

export async function openSeries(series: Series): Promise<void> {
  const store = useAppStore.getState();
  const study = store.studies.find((s) => s.study_uid === series.study_uid) ?? null;
  store.set({
    viewerError: null,
    loading: { active: true, loaded: 0, total: 0, label: 'Opening series' },
  });
  try {
    const detail = await api.series(series.series_uid);
    const volumetric = detail.is_3d && detail.instances.length >= 3;

    // Deep link: the address bar always points at whatever is open, so a
    // series can be reopened (or handed to a colleague on this machine) by URL.
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('series', detail.series_uid);
      window.history.replaceState(null, '', url.toString());
    } catch {
      /* non-critical */
    }

    const primary = volumetric ? primaryPaneFor(detail) : 'stack';

    useAppStore.getState().set({
      screen: 'read',
      activeSeries: detail,
      activeStudy: study,
      layout: volumetric ? 'mpr' : 'stack',
      maximized: null,
      grid: 'strip',
      primaryPane: primary,
      activePane: primary,
      measurements: [],
      selectedMeasurement: null,
      selectedFinding: null,
      compareSeries: null,
    });

    // Say so when the plane was chosen for a reason, so a coronal primary on a
    // thick MR does not read as a bug.
    if (volumetric && isMr(detail) && isThickSeries(detail)) {
      const plane = planeFromOrientation(detail.orientation) ?? 'axial';
      useAppStore.getState().toast({
        kind: 'info',
        title: `Reading the acquired ${plane} plane`,
        message: 'Thick MR — the strip shows reformats, which will look blocky.',
      });
    }
  } catch (e) {
    useAppStore.getState().set({
      loading: { active: false, loaded: 0, total: 0, label: '' },
      viewerError: `Could not open the series: ${(e as Error)?.message}`,
    });
  }
}

/**
 * Open a second series into the context strip and keep it on the same world
 * point as the primary. Only meaningful when the two share a FrameOfReference;
 * the caller checks that with `sameFrameOfReference`.
 */
export async function openCompareSeries(series: Series): Promise<void> {
  try {
    const detail = await api.series(series.series_uid);
    useAppStore.getState().set({ compareSeries: detail });
    useAppStore.getState().toast({
      kind: 'ok',
      title: 'Linked to the strip',
      message: `${detail.description || detail.modality} scrolls with the primary series.`,
    });
  } catch (e) {
    useAppStore
      .getState()
      .toast({ kind: 'err', title: 'Could not link that series', message: (e as Error)?.message });
  }
}

export function clearCompareSeries(): void {
  useAppStore.getState().set({ compareSeries: null });
}

/* ------------------------------------------------------------------ */
/* import                                                              */
/* ------------------------------------------------------------------ */

/** Index a folder that is already on this machine (typed path or picker). */
export async function importFolder(path: string): Promise<void> {
  const store = useAppStore.getState();
  store.set({ importOpen: false, libraryBusy: true });
  const toastId = store.toast({
    kind: 'busy',
    title: 'Indexing…',
    message: path,
    progress: null,
    ttl: 0,
  });
  try {
    const r = await api.importFolder(path || undefined);
    await refreshLibrary();
    const s = useAppStore.getState();
    s.dropToast(toastId);
    s.toast({
      kind: 'ok',
      title: 'Import complete',
      message: `${r.patients} patients · ${r.studies} studies · ${r.series} series · ${r.instances} instances${
        r.skipped ? ` · ${r.skipped} skipped` : ''
      } · ${r.seconds.toFixed(1)}s`,
    });
  } catch (e) {
    const s = useAppStore.getState();
    s.dropToast(toastId);
    s.toast({ kind: 'err', title: 'Import failed', message: (e as Error)?.message });
  } finally {
    useAppStore.getState().set({ libraryBusy: false });
  }
}

/**
 * Stream dropped files to the backend and then index them. `onProgress` drives
 * the Library's own progress bar; the toast is the background copy of it, so
 * the user can navigate away and still see it finish.
 */
export async function importDropped(
  files: DroppedFile[],
  name: string,
  onProgress?: (p: ImportProgress) => void,
): Promise<ImportProgress> {
  const store = useAppStore.getState();
  store.set({ libraryBusy: true });
  const toastId = store.toast({
    kind: 'busy',
    title: `Uploading ${name}`,
    message: `${files.length} files`,
    progress: 0,
    ttl: 0,
  });

  const final = await uploadAndIndex(files, {
    name,
    onProgress: (p) => {
      onProgress?.(p);
      const frac = p.bytesTotal > 0 ? p.bytesSent / p.bytesTotal : null;
      useAppStore.getState().updateToast(toastId, {
        title: p.phase === 'indexing' ? `Indexing ${name}` : `Uploading ${name}`,
        message: `${p.filesSent} / ${p.filesTotal} files`,
        progress: p.phase === 'indexing' ? null : frac,
      });
    },
  });

  const s = useAppStore.getState();
  s.dropToast(toastId);

  if (final.phase === 'done') {
    await refreshLibrary();
    const r = final.result;
    useAppStore.getState().toast({
      kind: 'ok',
      title: 'Import complete',
      message: r
        ? `${r.patients} patients · ${r.studies} studies · ${r.series} series · ${r.instances} instances`
        : `${final.filesSent} files copied`,
    });
  } else if (final.phase === 'unsupported') {
    useAppStore.getState().toast({
      kind: 'err',
      title: 'This backend cannot accept dropped files yet',
      message: final.message ?? 'Use Browse folder… or type the path instead.',
      ttl: 12000,
    });
  } else if (final.phase === 'error') {
    useAppStore
      .getState()
      .toast({ kind: 'err', title: 'Import failed', message: final.message });
  }

  useAppStore.getState().set({ libraryBusy: false });
  return final;
}

/** Open the series named in ?series=<uid>, if any. Called once on boot. */
export async function openSeriesFromUrl(): Promise<void> {
  let uid: string | null = null;
  try {
    uid = new URL(window.location.href).searchParams.get('series');
  } catch {
    return;
  }
  if (!uid) return;
  try {
    const detail = await api.series(uid);
    const studies = useAppStore.getState().studies;
    if (!studies.length) await refreshLibrary();
    await openSeries(detail);
  } catch {
    useAppStore.getState().toast({
      kind: 'err',
      title: 'That series is not in the library',
      message: uid,
    });
  }
}
