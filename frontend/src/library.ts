import { api, ApiError, type Series } from './api/client';
import { useAppStore } from './store/useAppStore';

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
  if (store.seriesByStudy[studyUid]) return;
  try {
    const list = await api.seriesForStudy(studyUid);
    const s = useAppStore.getState();
    s.set({ seriesByStudy: { ...s.seriesByStudy, [studyUid]: list } });
  } catch (e) {
    store.toast({ kind: 'err', title: 'Could not list series', message: (e as Error)?.message });
  }
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
    useAppStore.getState().set({
      screen: 'view',
      activeSeries: detail,
      activeStudy: study,
      layout: volumetric ? 'mpr' : 'stack',
      maximized: null,
      activePane: volumetric ? 'axial' : 'stack',
      measurements: [],
      selectedMeasurement: null,
    });
  } catch (e) {
    useAppStore.getState().set({
      loading: { active: false, loaded: 0, total: 0, label: '' },
      viewerError: `Could not open the series: ${(e as Error)?.message}`,
    });
  }
}

export async function importFolder(path: string): Promise<void> {
  const store = useAppStore.getState();
  store.set({ importOpen: false, libraryBusy: true });
  store.toast({ kind: 'info', title: 'Indexing…', message: path });
  try {
    const r = await api.importFolder(path || undefined);
    await refreshLibrary();
    useAppStore.getState().toast({
      kind: 'ok',
      title: 'Import complete',
      message: `${r.patients} patients · ${r.studies} studies · ${r.series} series · ${r.instances} instances${
        r.skipped ? ` · ${r.skipped} skipped` : ''
      } · ${r.seconds.toFixed(1)}s`,
    });
  } catch (e) {
    useAppStore.getState().toast({
      kind: 'err',
      title: 'Import failed',
      message: (e as Error)?.message,
    });
  } finally {
    useAppStore.getState().set({ libraryBusy: false });
  }
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
