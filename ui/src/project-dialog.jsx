import { isWindows, isMac } from "./platform.mjs";
import React, { useEffect, useState } from "react";
import { FolderMinus, FolderOpen, LoaderCircle, PencilLine, Plus } from "lucide-react";
import { api, native, nativeAvailable } from "./api";
import { SafetyMessage } from "./safety-message";
import { Modal } from "./views";
import { MacOSProjectApproval } from "./macos-project-approval";
import { ProjectRecovery } from "./project-recovery";
import { projectGroups, projectName, rememberClientProjectName } from "./workspace-state.mjs";
import { getClientContext, isRemoteClient } from "./client-context.mjs";

export function ProjectDialog({
  status,
  initialPath = "",
  activate = true,
  onClose,
  onOpened,
  onRemoved,
  onSettings,
}) {
  const groups = projectGroups(status);
  const projects = groups.map(group => group.workspace);
  const initialGroup = groups.find(group => group.folders.includes(initialPath));
  const [adding, setAdding] = useState(Boolean(initialPath && !initialGroup) || projects.length === 0);
  const [path, setPath] = useState(initialGroup?.workspace || initialPath || groups.find(group => group.folders.includes(status.workspace))?.workspace || projects[0] || "");
  const [editing, setEditing] = useState("");
  const [name, setName] = useState("");
  const [folders, setFolders] = useState([]);
  const [error, setError] = useState("");
  const [recovery, setRecovery] = useState("");
  const [pending, setPending] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [removeTarget, setRemoveTarget] = useState("");
  const [removed, setRemoved] = useState([]);
  const [directories, setDirectories] = useState(null);
  const [browsing, setBrowsing] = useState(false);
  const remote = isRemoteClient();
  const context = getClientContext();
  const canShare = remote && nativeAvailable() && context.connection?.manifest?.capabilities?.client_project_share === true;
  const [shares, setShares] = useState([]);
  const [writeAccess, setWriteAccess] = useState(false);
  const [sharing, setSharing] = useState(false);
  useEffect(() => {
    if (!canShare) return;
    let current = true;
    api("/client/project-shares").then(({ shares }) => {
      if (current) {
        (shares || []).forEach(rememberClientProjectName);
        setShares(shares || []);
      }
    }).catch((e) => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [canShare, context.connection_id]);
  const share = async () => {
    setSubmitting(true); setError("");
    try {
      const item = await native("shareLocalProject", { mode: writeAccess ? "write" : "read" });
      if (item.canceled) return;
      rememberClientProjectName(item);
      setShares((old) => [...old.filter((s) => s.id !== item.id), item]);
      setPath(item.guest_path); setAdding(false); setSharing(false);
      const result = await api("/projects/open", { workspace: item.guest_path, add: false, activate });
      await onOpened(result.workspace);
    } catch (e) { setError(e.message); }
    finally { setSubmitting(false); }
  };
  const revoke = async (item) => {
    setSubmitting(true); setError("");
    try {
      await api("/client/project-shares/" + item.id, undefined, "DELETE");
      setShares((old) => old.filter((s) => s.id !== item.id));
      if (path === item.guest_path) setPath(status.workspace || "");
    } catch (e) { setError(e.message); }
    finally { setSubmitting(false); }
  };
  const projectList = [...new Set([...projects, ...shares.map((s) => s.guest_path)])].filter(project => !removed.includes(project));
  const displayName = value => projectName(value, groups);
  const selectedGroup = groups.find(group => group.workspace === path);
  const draftFolders = [...new Set([...folders, ...(path.trim() ? [path.trim()] : [])])];
  const appendFolder = value => {
    const folder = value.trim();
    if (!folder) return;
    setFolders(previous => [...new Set([...previous, folder])]);
    setName(previous => previous || projectName(folder));
    setPath(""); setError("");
  };
  const edit = () => {
    if (!selectedGroup) return;
    setEditing(selectedGroup.workspace); setName(selectedGroup.name);
    setFolders(selectedGroup.folders); setPath(""); setAdding(true); setError("");
  };
  const selectedShare = shares.find((item) => item.guest_path === path);
  const busy = submitting || Boolean(status.job?.running);
  const remove = async () => {
    if (busy || !removeTarget) return;
    setSubmitting(true); setError("");
    try {
      const result = await api("/projects/remove", { workspace: removeTarget });
      setRemoved(previous => [...previous, removeTarget]);
      setPath(result.workspace || "");
      if (!result.workspace) setAdding(true);
      setRemoveTarget("");
      await onRemoved?.(removeTarget, result.workspace);
    } catch (e) { setError(e.message); }
    finally { setSubmitting(false); }
  };
  const browse = async (directory = path.trim()) => {
    setBrowsing(true); setError("");
    try { setDirectories(await api(`/projects/directories?${new URLSearchParams({ path: directory })}`)); }
    catch (e) { setError(e.message); }
    finally { setBrowsing(false); }
  };
  const choose = async () => {
    if (remote) { await browse(); return; }
    setBrowsing(true);
    try {
      const selected = await native("chooseFolder");
      if (selected) {
        appendFolder(selected);
      }
    } catch {
      setError("Не удалось выбрать каталог. Введите путь вручную.");
    } finally {
      setBrowsing(false);
    }
  };
  const add = () => {
    setAdding(true);
    setEditing(""); setName(""); setFolders([]);
    setPath("");
    setError("");
    if (remote) void browse("");
    else if (nativeAvailable()) void choose();
  };
  const performOpen = async () => {
    let workspace = path.trim();
    if (adding) {
      const saved = await api("/projects/save", {
        workspace: editing, name: name.trim() || projectName(draftFolders[0]), folders: draftFolders,
      });
      if (saved.approval) {
        setPending({ workspace: saved.workspace, grant: saved.approval });
        return;
      }
      workspace = saved.workspace;
      setEditing(saved.workspace);
    }
    const result = await api("/projects/open", { workspace, add: false, activate });
    if (result.approval) setPending({ workspace: result.workspace, grant: result.approval });
    else await onOpened(result.workspace);
  };
  const open = async (event) => {
    event?.preventDefault();
    if (busy || sharing || removeTarget || !status.ready || !(adding ? draftFolders.length : path.trim())) return;
    setSubmitting(true);
    setError("");
    setRecovery("");
    try {
      await performOpen();
    } catch (e) {
      setError(e.message);
      setRecovery(e.recovery || "");
    } finally {
      setSubmitting(false);
    }
  };
  if (pending) return <MacOSProjectApproval pending={pending} onClose={onClose} onSettings={onSettings} onCheck={async () => {
    await performOpen();
  }} />;
  return (
    <Modal
      title={adding ? editing ? "Редактировать проект" : "Создать проект" : activate ? "Открыть проект" : "Выбрать рабочий проект"}
      onClose={busy ? undefined : onClose}
      footer={
        <>
          <span className="save-note">
            {busy
              ? submitting ? removeTarget ? "Удаление проекта…" : "Подключение проекта…" : status.job?.message
              : adding ? editing ? "История сессий сохранится" : "Первый каталог будет основным" : "Используется авторизованный проект Cage"}
          </span>
          <button disabled={busy} onClick={onClose}>
            Отмена
          </button>
          <button
            className="primary"
            form="open-project"
            type="submit"
            disabled={!(adding ? draftFolders.length : path.trim()) || busy || sharing || Boolean(removeTarget) || !status.ready}
          >
            {busy ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <FolderOpen size={15} />
            )}
            {adding ? editing ? "Сохранить проект" : "Создать проект" : activate ? "Открыть проект" : "Использовать проект"}
          </button>
        </>
      }
    >
      <form
        id="open-project"
        className="modal-body project-form"
        onSubmit={open}
      >
        <p>{adding ? "Задайте название проекта и добавьте каталоги, которые нужно использовать вместе." : activate ? "Выберите проект для открытия или добавьте новый." : "Выберите рабочий каталог из списка проектов Cage. Новые проекты авторизуются и публикуются через Cage."}</p>
        {canShare && <>
          <button type="button" className="quiet-button project-picker-add" onClick={() => { setSharing(!sharing); setWriteAccess(false); }} disabled={busy} aria-expanded={sharing}>
            <FolderOpen size={16} />Поделиться локальным проектом…
          </button>
          {sharing && <fieldset className="project-picker-list project-permissions" disabled={busy}>
            <legend>Поделиться с {context.name || "текущий облачный Cage"}</legend>
            <p className="field-help">Облако читает проект по запросу. Учётные данные, метаданные Git и ссылки ограничены. После отключения общий доступ завершится.</p>
            <label><input type="checkbox" checked={writeAccess} onChange={(e) => setWriteAccess(e.target.checked)} />Разрешить облаку изменять и удалять файлы проекта на этом компьютере</label>
            <button type="button" onClick={share}>Выбрать локальный каталог…</button>
          </fieldset>}
        </>}
        {!sharing && !adding && <>
          <fieldset className="project-picker-list" disabled={busy || Boolean(removeTarget)}>
            <legend>Проект</legend>
            {projectList.map((project) => <div className={`project-picker-row ${path === project ? "selected" : ""}`} key={project}>
              <label className="project-picker-item">
                <input type="radio" name="project" value={project} checked={path === project} onChange={() => { setPath(project); setError(""); }} />
                <FolderOpen size={18} aria-hidden="true" />
                <span>
                  <strong>{displayName(project)}</strong>
                  <small>{shares.find((s) => s.guest_path === project)?.path || groups.find(g => g.workspace === project)?.folders.join(" · ") || project}</small>
                  {status.project_errors?.some((item) => (groups.find(group => group.workspace === project)?.folders || [project]).includes(item.path)) && <small>Требуется повторное подключение. Выберите и повторите</small>}
                </span>
              </label>
              {path === project && !selectedShare && !removeTarget && <div className="project-picker-actions">
                {selectedGroup && <button type="button" className="icon-button" aria-label="Изменить имя и каталоги…" disabled={busy || !status.ready} onClick={edit}><PencilLine size={16} aria-hidden="true" /></button>}
                {activate && <button type="button" className="icon-button project-picker-remove" aria-label="Удалить этот проект из Cage" disabled={busy} onClick={() => { setRemoveTarget(path); setError(""); setRecovery(""); }}><FolderMinus size={16} aria-hidden="true" /></button>}
              </div>}
            </div>)}
          </fieldset>
          {selectedShare && <button type="button" disabled={submitting} onClick={() => revoke(selectedShare)}>Прекратить общий доступ к локальному проекту ({selectedShare.readonly ? "только чтение" : "чтение и запись"})</button>}
          {removeTarget && <section className="project-picker-list" aria-label="Подтвердите удаление проекта">
            <p>Удаление «{displayName(removeTarget)}» отменит общий доступ ко всем привязанным каталогам. Исходные файлы и история сессий сохранятся; после повторного добавления того же каталога историю можно будет продолжить.</p>
            <p className="field-help">Сначала сохраните файлы и закройте терминалы, активные сессии и редакторы этого проекта. После удаления текущего проекта будет выбран оставшийся; после удаления последнего можно снова добавить каталоги.</p>
            <button type="button" disabled={busy} onClick={() => { setRemoveTarget(""); setError(""); }}>Отменить удаление</button>
            <button type="button" disabled={busy} onClick={remove}>Удалить проект</button>
          </section>}
          <button type="button" className="quiet-button project-picker-add" onClick={add} disabled={busy || Boolean(removeTarget) || !status.ready}><Plus size={16} />{remote ? "Добавить облачный проект…" : "Добавить локальный проект…"}</button>
        </>}
        {!sharing && adding && <>
          {projects.length > 0 && <button type="button" className="quiet-button project-picker-add" disabled={busy} onClick={() => { setAdding(false); setEditing(""); setFolders([]); setPending(null); setPath(groups.find(group => group.folders.includes(status.workspace))?.workspace || projects[0]); setError(""); }}>Вернуться к существующим</button>}
          <label htmlFor="project-name">Название проекта</label>
          <input id="project-name" autoFocus value={name} maxLength={100} onChange={event => setName(event.target.value)} placeholder="например: система курсов" disabled={busy} />
          <label>Исходные каталоги</label>
          {folders.length > 0 && <ul className="project-folder-list" aria-label="Привязанные каталоги">
            {folders.map((folder, index) => <li key={folder}>
              <FolderOpen size={16} aria-hidden="true" /><span><strong>{projectName(folder)}</strong><small>{folder}</small></span>
              {index === 0 && <small className="project-folder-default">Основной</small>}
              <button type="button" disabled={busy || folder === editing} aria-label={`Удалить каталог ${projectName(folder)}`} title={folder === editing ? "Основной каталог связан с историей сессий и должен остаться" : "Отвязать каталог"} onClick={() => setFolders(previous => previous.filter(value => value !== folder))}>Удалить</button>
            </li>)}
          </ul>}
          <label htmlFor="project-path">Добавить каталог</label>
          <div className="folder-input">
          <input
            id="project-path"
            value={path}
            onChange={(event) => {
              setPath(event.target.value);
              setError("");
            }}
            placeholder={remote ? "/home/cage/Projects/my-project" : isWindows ? "C:/Users/имя/Projects/my-project" : isMac ? "/Users/имя/Projects/my-project" : "/home/имя/Projects/my-project"}
            disabled={busy}
            spellCheck="false"
            autoComplete="off"
          />
          {path.trim() && <button type="button" disabled={busy} onClick={() => appendFolder(path)}>Добавить</button>}
          {(remote || nativeAvailable()) && (
            <button type="button" onClick={choose} disabled={busy || browsing}>
              {browsing ? "Чтение…" : remote ? "Обзор облачных каталогов…" : "Выбрать каталог…"}
            </button>
          )}
          </div>
          {remote && directories && <section className="remote-directory-picker" aria-label="Облачные каталоги">
            <div className="remote-directory-heading"><strong>{directories.path}</strong><button type="button" disabled={browsing} onClick={() => setDirectories(null)}>Свернуть</button></div>
            <div className="remote-directory-list">
              {directories.parent && <button type="button" disabled={browsing} onClick={() => browse(directories.parent)}>В родительский каталог</button>}
              {directories.directories?.map((directory) => <button type="button" key={directory.path} disabled={browsing} onClick={() => browse(directory.path)}><FolderOpen size={16} />{directory.name}</button>)}
              {directories.directories?.length === 0 && <p className="field-help">В этом каталоге нет вложенных каталогов.</p>}
            </div>
            <button type="button" disabled={browsing || !directories.selectable} onClick={() => { appendFolder(directories.path); setDirectories(null); }}>Выбрать этот каталог</button>
          </section>}
        </>}
        {adding && <p className="field-help">Claude запускается из основного каталога и может читать и записывать остальные привязанные каталоги. Изменения привязок вступают в силу при создании или повторном открытии сессии. {editing && "Основной каталог связан с историей сессий и должен остаться. Перед отвязкой закройте терминалы, активные сессии и редакторы проекта."}</p>}
        <p className="field-help project-picker-note">
          <span>{remote ? "Облачные проекты хранятся на сервере." : "Изменения в привязанных каталогах записываются напрямую на этот компьютер."}</span>
          <span>Все проекты используют общую среду Cage; открытые терминалы и страницы продолжат работать.</span>
        </p>
        {!status.ready && <p className="field-help">Добавлять и открывать проекты можно после готовности среды. Существующие проекты по-прежнему можно удалить из списка.</p>}
        {error && (
          <div className="error-message" role="alert">
            <SafetyMessage message={error} />
            {recovery && <ProjectRecovery recovery={recovery} disabled={busy} onRetry={() => void open()}
              onSettings={onSettings} onSessionClosed={() => void open()} />}
          </div>
        )}
      </form>
    </Modal>
  );
}
