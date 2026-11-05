import React, { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, getMany } from 'idb-keyval';
import type { EditorHandle } from './vendor/Editor';
import '@excalidraw/excalidraw/index.css';
import './style.css';

const Editor = lazy(() => import('./vendor/Editor'));
type Canvas = { id: string; name: string; createdAt: string; updatedAt: string; archivedAt?: string };
type Scene = { elements: { id: string; type?: string; fileId?: string; isDeleted?: boolean }[]; files?: Record<string, unknown> };
const rootElement = document.getElementById('root')!;
const view = rootElement.ownerDocument.defaultView!;

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not complete this request.');
  return data;
}
const send = (method: string, data: unknown): RequestInit => ({ method, body: JSON.stringify(data) });
function Icon({ name, size = 20 }: { name: 'plus' | 'back' | 'search' | 'pencil' | 'archive' | 'restore' | 'canvas' | 'upload' | 'link' | 'sun' | 'moon'; size?: number }) {
  const paths = {
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
    moon: <path d="M20 14a8.5 8.5 0 0 1-10-10A8.5 8.5 0 1 0 20 14Z" />,
    plus: <path d="M12 5v14M5 12h14" />,
    back: <path d="m14 6-6 6 6 6M8 12h13" />,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
    pencil: <><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z" /></>,
    archive: <><path d="M5 8v12h14V8M3 4h18v4H3ZM10 12h4" /></>,
    restore: <><path d="M4 5v5h5M4 10a8 8 0 1 1 0 6" /></>,
    canvas: <><rect x="4" y="4" width="15" height="15" rx="3" transform="rotate(-5 12 12)" /><path d="m8 15 3-5 3 3 3-6" /></>,
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6" /></>,
    link: <><path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M13 7l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" /></>
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
function relativeDate(value: string) {
  const date = new Date(value);
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days === 0) return `Today at ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function browserScene(): Scene | null {
  try {
    if (view.localStorage.getItem('omarchy-browser-drawing-imported')) return null;
    const elements = JSON.parse(view.localStorage.getItem('excalidraw') || '[]');
    return Array.isArray(elements) && elements.some(el => !el.isDeleted) ? { elements } : null;
  } catch { return null; }
}

type Theme = 'light' | 'dark';
const THEME_KEY = 'excalidraw-canvas-theme';
function savedTheme(): Theme | null {
  try {
    const saved = view.localStorage.getItem(THEME_KEY);
    return saved === 'light' || saved === 'dark' ? saved : null;
  } catch { return null; }
}

function App() {
  const [themePreference, setThemePreference] = useState(savedTheme);
  const [systemDark, setSystemDark] = useState(() => view.matchMedia('(prefers-color-scheme: dark)').matches);
  const theme: Theme = themePreference || (systemDark ? 'dark' : 'light');
  const [statusContainer, setStatusContainer] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const media = view.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    const storage = (event: StorageEvent) => { if (event.key === THEME_KEY || event.key === null) setThemePreference(savedTheme()); };
    update();
    media.addEventListener('change', update);
    view.addEventListener('storage', storage);
    return () => { media.removeEventListener('change', update); view.removeEventListener('storage', storage); };
  }, []);
  useLayoutEffect(() => {
    rootElement.ownerDocument.documentElement.dataset.theme = theme;
    rootElement.ownerDocument.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#181922' : '#f8f9fc');
  }, [theme]);
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setThemePreference(next);
    try { view.localStorage.setItem(THEME_KEY, next); } catch { /* Theme still works when storage is unavailable. */ }
  };
  const themeButton = <button className="button quiet theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
    <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} /><span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
  </button>;
  const [route, setRoute] = useState(view.location.pathname);
  const [canvases, setCanvases] = useState<Canvas[]>([]);
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<{ type: 'create' | 'rename' | 'archive'; canvas?: Canvas } | null>(null);
  const [name, setName] = useState('');
  const [legacy, setLegacy] = useState(browserScene);
  const [notice, setNotice] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const editor = useRef<EditorHandle>(null);
  const navigationLock = useRef(false);
  const selectedId = /^\/c\/([^/]+)$/.exec(route)?.[1];

  const refresh = useCallback(async () => {
    const data = await api<{ canvases: Canvas[] }>(`/api/canvases?archived=${archived}`);
    setCanvases(data.canvases);
  }, [archived]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setCanvas(null);
    const load = selectedId ? api<Canvas>(`/api/canvases/${selectedId}`).then(c => { if (active) setCanvas(c); }) : refresh();
    load.catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [selectedId, refresh]);
  useEffect(() => {
    if (selectedId) return;
    const update = () => { if (view.document.visibilityState === 'visible') void refresh().catch(() => {}); };
    const timer = view.setInterval(update, 10_000);
    view.addEventListener('focus', update);
    return () => { view.clearInterval(timer); view.removeEventListener('focus', update); };
  }, [selectedId, refresh]);

  const navigate = useCallback(async (to: string, popped = false) => {
    if (navigationLock.current) return;
    navigationLock.current = true; setBusy(true); setError('');
    try {
      await editor.current?.flush();
      if (!popped) view.history.pushState(null, '', to);
      setRoute(to);
    } catch (e) {
      setError((e as Error).message);
      if (popped) view.history.pushState(null, '', route);
    } finally { navigationLock.current = false; setBusy(false); }
  }, [route]);
  useEffect(() => {
    const pop = () => { void navigate(view.location.pathname, true); };
    view.addEventListener('popstate', pop);
    return () => view.removeEventListener('popstate', pop);
  }, [navigate]);
  useEffect(() => {
    view.document.title = canvas ? `${canvas.name} · Canvas library` : 'Canvas library';
  }, [canvas]);
  useEffect(() => { if (modal && !dialog.current?.open) dialog.current?.showModal(); }, [modal]);
  useEffect(() => {
    if (!notice) return;
    const timer = view.setTimeout(() => setNotice(''), 3500);
    return () => view.clearTimeout(timer);
  }, [notice]);
  const openModal = (type: 'create' | 'rename' | 'archive', target?: Canvas) => {
    setName(type === 'create' ? '' : target?.name || ''); setError(''); setModal({ type, canvas: target });
  };
  const closeModal = () => { if (busy) return; dialog.current?.close(); setModal(null); };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (modal?.type === 'create') {
        const created = await api<Canvas>('/api/canvases', send('POST', { name: name.trim() || 'Untitled canvas' }));
        dialog.current?.close(); setModal(null);
        setBusy(false);
        await navigate(`/c/${created.id}`);
      } else if (modal?.canvas) {
        const updated = await api<Canvas>(`/api/canvases/${modal.canvas.id}`, send('PATCH', modal.type === 'archive' ? { archived: true } : { name }));
        if (selectedId === updated.id) setCanvas(updated);
        dialog.current?.close(); setModal(null); await refresh();
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const restore = async (id: string) => {
    setError(''); setBusy(true);
    try { await api(`/api/canvases/${id}`, send('PATCH', { archived: false })); await refresh(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const importScene = async (scene: Scene, title: string) => {
    if (!Array.isArray(scene.elements)) throw new Error('Choose a valid .excalidraw file.');
    const elements = scene.elements.filter(el => !el.isDeleted);
    const ids = [...new Set(elements.flatMap(el => el.type === 'image' && el.fileId ? [el.fileId] : []))];
    if (ids.some(id => !scene.files?.[id])) throw new Error('Some images are missing from this drawing. Export it with its images and try again.');
    const created = await api<Canvas>('/api/canvases', send('POST', { name: title }));
    try {
      for (const id of ids) await api(`/canvases/${created.id}/api/files`, send('POST', { files: [scene.files![id]] }));
      await api(`/canvases/${created.id}/api/elements/sync`, send('POST', { elements }));
      return created;
    } catch (e) {
      await api(`/api/canvases/${created.id}`, send('PATCH', { archived: true })).catch(() => {});
      throw e;
    }
  };
  const importFile = async (file: File) => {
    setBusy(true); setError('');
    try {
      const created = await importScene(JSON.parse(await file.text()), file.name.replace(/\.(excalidraw|json)$/i, '').slice(0, 120) || 'Imported canvas');
      setBusy(false); await navigate(`/c/${created.id}`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const importBrowser = async () => {
    if (!legacy) return;
    setBusy(true); setError('');
    try {
      const ids = [...new Set(legacy.elements.flatMap(el => el.type === 'image' && el.fileId ? [el.fileId] : []))];
      const files = ids.length ? await getMany(ids, createStore('files-db', 'files-store')) : [];
      const created = await importScene({ ...legacy, files: Object.fromEntries(ids.map((id, i) => [id, files[i]])) }, 'Imported browser drawing');
      view.localStorage.setItem('omarchy-browser-drawing-imported', created.id);
      setLegacy(null); setBusy(false); await navigate(`/c/${created.id}`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const filtered = canvases.filter(c => c.name.toLowerCase().includes(query.toLowerCase()));
  const link = (event: React.MouseEvent, to: string) => {
    if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault(); void navigate(to);
    }
  };

  return <div className={selectedId ? 'workspace editing' : 'workspace'}>
    <header className="topbar">
      {selectedId ? <>
        <a className="back-link" aria-label="All canvases" title="All canvases" href="/" onClick={e => link(e, '/')} aria-disabled={busy}><Icon name="back" /><span>All canvases</span></a>
        <span className="topbar-divider" />
        <button className="canvas-name" onClick={() => canvas && openModal('rename', canvas)} title="Rename canvas"><span>{canvas?.name || 'Loading canvas…'}</span><Icon name="pencil" size={16} /></button>
        <div className="header-save-status" ref={setStatusContainer} />
        {themeButton}
        <button aria-label="Copy canvas link" title="Copy canvas link" className="button quiet copy-link" onClick={() => {
          void view.navigator.clipboard.writeText(view.location.href).then(() => setNotice('Canvas link copied')).catch(() => setError('Could not copy the link. Copy it from your address bar.'));
        }}><Icon name="link" size={18} /><span>Copy link</span></button>
      </> : <>
        <div className="library-topbar-inner">
          <a className="brand" href="/" onClick={e => link(e, '/')}>
            <span className="brand-mark">
              <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m7 5-2 .3A2 2 0 0 0 3.3 7.6l1.5 11.1A2 2 0 0 0 7 20.4l10.2-1.3" />
                <rect x="7" y="3" width="14" height="14" rx="3" />
                <path d="m11 12 1-3 4-4 2 2-4 4-3 1ZM15 6l2 2" />
              </svg>
            </span>
            <span>Canvas library</span>
          </a>
          <div className="library-topbar-actions">{themeButton}<span className="workspace-context">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></svg>
            Private workspace
          </span></div>
        </div>
      </>}
    </header>
    {error && !modal && <div className="error-banner" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
    {selectedId ? <>
      {loading && <div className="loading" role="status">Opening your canvas…</div>}
      {canvas && <Suspense fallback={<div className="loading" role="status">Loading drawing tools…</div>}><Editor key={canvas.id} canvasId={canvas.id} theme={theme} statusContainer={statusContainer} ref={editor} /></Suspense>}
      {!loading && !canvas && <div className="empty"><h1>This canvas could not be opened</h1><a className="button primary" href="/" onClick={e => link(e, '/')}>Back to canvases</a></div>}
    </> : <main className="library">
      <div className="library-heading"><div><h1>Your canvases</h1><p>Room for every thought. Saved as you draw.</p></div><div className="heading-actions">
        <button className="button quiet" onClick={() => fileInput.current?.click()} disabled={busy}><Icon name="upload" /><span>Import drawing</span></button>
        <button className="button primary" onClick={() => openModal('create')} disabled={busy}><Icon name="plus" />New canvas</button>
      </div></div>
      <input ref={fileInput} type="file" accept=".excalidraw,.json" hidden onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void importFile(file); }} />
      {legacy && <aside className="import-banner"><div><strong>Your previous drawing is still in this browser.</strong><p>Add it to your library to keep it with your other canvases.</p></div><button className="button secondary" disabled={busy} onClick={() => void importBrowser()}>{busy ? 'Importing…' : 'Import previous drawing'}</button></aside>}
      <div className="library-tools"><nav className="tabs" aria-label="Canvas collection"><button className={!archived ? 'active' : ''} onClick={() => setArchived(false)} aria-pressed={!archived}>Canvases</button><button className={archived ? 'active' : ''} onClick={() => setArchived(true)} aria-pressed={archived}>Archive</button></nav>
        <label className="search"><Icon name="search" size={18} /><input type="search" aria-label="Search canvases" placeholder="Find a canvas…" value={query} onChange={e => setQuery(e.target.value)} /></label></div>
      {loading ? <div className="loading" role="status">Loading your canvases…</div> : filtered.length ? <>
        <p className="list-caption">{filtered.length} {filtered.length === 1 ? 'canvas' : 'canvases'}<span>Recently edited first</span></p>
        <div className="canvas-grid">{filtered.map(item => <article className="canvas-card" key={item.id}>
          <a className="card-preview" href={`/c/${item.id}`} onClick={e => link(e, `/c/${item.id}`)} aria-label={`Open ${item.name}`}>
            <div className="blank-preview" aria-hidden="true"><Icon name="canvas" size={38} /></div>
            <img src={`/api/canvases/${item.id}/preview?v=${encodeURIComponent(item.updatedAt)}`} alt="" loading="lazy" onLoad={e => { e.currentTarget.style.visibility = 'visible'; }} onError={e => { e.currentTarget.style.visibility = 'hidden'; }} />
          </a>
          <div className="card-details"><a className="card-title" href={`/c/${item.id}`} onClick={e => link(e, `/c/${item.id}`)}>{item.name}</a><p><time dateTime={item.updatedAt}>{relativeDate(item.updatedAt)}</time></p>
            <div className="card-actions"><button aria-label={`Rename ${item.name}`} title="Rename canvas" onClick={() => openModal('rename', item)}><Icon name="pencil" size={17} /></button>
              {archived ? <button aria-label={`Restore ${item.name}`} title="Restore canvas" disabled={busy} onClick={() => void restore(item.id)}><Icon name="restore" size={18} /></button> : <button aria-label={`Archive ${item.name}`} title="Archive canvas" onClick={() => openModal('archive', item)}><Icon name="archive" size={18} /></button>}
            </div></div>
        </article>)}</div>
      </> : <div className="empty"><Icon name="canvas" size={52} /><h2>{query ? 'No matching canvases' : archived ? 'Your archive is empty' : 'A fresh canvas for your next idea'}</h2><p>{query ? 'Try another name.' : archived ? 'Archived drawings stay saved here until you need them again.' : 'Create your first canvas. Give it a name and make it yours.'}</p>{!query && !archived && <button className="button primary" onClick={() => openModal('create')}><Icon name="plus" />New canvas</button>}</div>}
    </main>}
    <dialog ref={dialog} onCancel={event => { if (busy) event.preventDefault(); else setModal(null); }} aria-labelledby="dialog-title">
      <form onSubmit={event => void submit(event)}><h2 id="dialog-title">{modal?.type === 'archive' ? 'Archive this canvas?' : modal?.type === 'rename' ? 'Rename canvas' : 'Make room for a new idea'}</h2>
        {modal?.type === 'archive' ? <p>“{modal.canvas?.name}” will move to your archive. Your drawing stays saved and you can restore it anytime.</p> : <><label htmlFor="canvas-name">Canvas name</label><input id="canvas-name" autoFocus maxLength={120} value={name} placeholder="e.g. Weekend ideas" onChange={e => setName(e.target.value)} required={modal?.type === 'rename'} /></>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions"><button className="button quiet" type="button" onClick={closeModal} disabled={busy}>Cancel</button><button className="button primary" type="submit" disabled={busy}>{busy ? 'Saving…' : modal?.type === 'archive' ? 'Archive canvas' : modal?.type === 'rename' ? 'Save name' : 'Create canvas'}</button></div>
      </form>
    </dialog>
    {notice && <div className="toast" role="status">{notice}</div>}
  </div>;
}
createRoot(rootElement).render(<App />);
