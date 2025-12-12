const DB_NAME = "mini_tasks_projects_db";
const DB_VERSION = 1;
const DB_STORE = "state";
const LEGACY_STORAGE_KEY = "tasks_board_v1";

let miniDb = null;

function openMiniDB() {
  return new Promise((resolve) => {
    if (!("indexedDB" in window)) {
      resolve(null);
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      resolve(null);
    };
  });
}

function loadStateFromDB() {
  if (!miniDb) return Promise.resolve(null);

  return new Promise((resolve) => {
    const tx = miniDb.transaction(DB_STORE, "readonly");
    const store = tx.objectStore(DB_STORE);
    const req = store.get("main");

    req.onsuccess = () => {
      resolve(req.result ? req.result.state : null);
    };
    req.onerror = () => resolve(null);
  });
}

function saveStateToDB(state) {
  if (!miniDb) return;

  const tx = miniDb.transaction(DB_STORE, "readwrite");
  const store = tx.objectStore(DB_STORE);
  store.put({ id: "main", state });
}

function loadLegacyTasks() {
  const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

let projects = [];
let currentProjectId = null;
let layoutMode = "list";

let draggedSubtask = null;
let draggedTask = null;
let draggedProjectId = null;

const tasksContainer = document.getElementById("tasks-container");
const addTaskForm = document.getElementById("add-task-form");
const newTaskTitleInput = document.getElementById("new-task-title");
const globalProgressEl = document.getElementById("global-progress");
const projectsTabsEl = document.getElementById("projects-tabs");
const projectHeaderEl = document.getElementById("project-header");
const projectProgressEl = document.getElementById("project-progress");
const layoutToggleBtn = document.getElementById("layout-toggle");
const clearAllBtn = document.getElementById("clear-all-btn");
const exportBtn = document.getElementById("export-btn");
const importBtn = document.getElementById("import-btn");
const importInput = document.getElementById("import-input");

const dialogBackdrop = document.getElementById("dialog-backdrop");
const dialogTitleEl = document.getElementById("dialog-title");
const dialogMessageEl = document.getElementById("dialog-message");
const dialogExtraEl = document.getElementById("dialog-extra");
const dialogCancelBtn = document.getElementById("dialog-cancel");
const dialogConfirmBtn = document.getElementById("dialog-confirm");

let dialogConfirmHandler = null;

function openDialog({
  title,
  message = "",
  confirmText = "Confirm",
  cancelText = "Cancel",
  renderExtra = null,
  onConfirm,
}) {
  dialogTitleEl.textContent = title;
  dialogMessageEl.textContent = message;
  dialogConfirmBtn.textContent = confirmText;
  dialogCancelBtn.textContent = cancelText;

  dialogExtraEl.innerHTML = "";
  let extraData = null;
  if (renderExtra) {
    extraData = renderExtra(dialogExtraEl);
  }

  dialogConfirmHandler = () => {
    if (onConfirm) onConfirm(extraData);
    closeDialog();
  };

  dialogBackdrop.classList.remove("hidden");
}

function closeDialog() {
  dialogBackdrop.classList.add("hidden");
  dialogConfirmHandler = null;
  dialogExtraEl.innerHTML = "";
}

dialogCancelBtn.addEventListener("click", () => {
  closeDialog();
});

dialogConfirmBtn.addEventListener("click", () => {
  if (dialogConfirmHandler) dialogConfirmHandler();
});

dialogBackdrop.addEventListener("click", (e) => {
  if (e.target === dialogBackdrop) {
    closeDialog();
  }
});

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => {
    return (
      {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c] || c
    );
  });
}

function getCurrentProject() {
  return projects.find((p) => p.id === currentProjectId) || null;
}

function persistState() {
  const state = {
    projects,
    layoutMode,
  };
  saveStateToDB(state);
}

function exportStateToFile() {
  const state = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    projects,
    layoutMode,
  };

  const json = JSON.stringify(state, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `tasks-board-${date}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);
}

function importStateFromFile(file) {
  const reader = new FileReader();

  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(e.target.result);

      const incoming = normalizeImportedState(parsed);
      if (!incoming) {
        alert("Invalid file format.");
        return;
      }

      openDialog({
        title: "Import options",
        message: "How do you want to import this file?",
        confirmText: "Continue",
        cancelText: "Cancel",
        renderExtra: (container) => {
          const wrapper = document.createElement("div");
          wrapper.className = "import-options";
          wrapper.innerHTML = `
            <label style="display:flex;align-items:center;gap:.5rem;margin-bottom:.5rem;cursor:pointer;">
              <input type="radio" name="importMode" value="merge" checked />
              <span><strong>Merge</strong> (add to your current data)</span>
            </label>
            <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer;">
              <input type="radio" name="importMode" value="replace" />
              <span><strong>Replace</strong> (delete current data)</span>
            </label>
          `;
          container.appendChild(wrapper);
          return wrapper;
        },
        onConfirm: (wrapper) => {
          const selected = wrapper.querySelector(
            'input[name="importMode"]:checked'
          );
          const mode = selected ? selected.value : "merge";

          if (mode === "replace") {
            projects = incoming.projects;
            layoutMode = incoming.layoutMode || "list";
            currentProjectId = projects[0] ? projects[0].id : null;
          } else {
            mergeImportedState(incoming);
          }

          persistState();
          renderAll();
        },
      });
    } catch (err) {
      console.error(err);
      alert("Failed to read file. Make sure it is a valid JSON export.");
    }
  };

  reader.readAsText(file, "utf-8");
}

function createId(prefix) {
  try {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return prefix + window.crypto.randomUUID();
    }
  } catch {}
  return prefix + Date.now() + "_" + Math.random().toString(16).slice(2);
}

function safeClone(obj) {
  try {
    if (typeof structuredClone === "function") return structuredClone(obj);
  } catch {}
  return JSON.parse(JSON.stringify(obj));
}

function normalizeImportedState(parsed) {
  if (!parsed || !Array.isArray(parsed.projects)) return null;

  const normalized = {
    projects: [],
    layoutMode: parsed.layoutMode || "list",
  };

  parsed.projects.forEach((p) => {
    if (!p) return;
    const project = {
      id: typeof p.id === "string" && p.id ? p.id : createId("p"),
      name:
        typeof p.name === "string" && p.name.trim()
          ? p.name.trim()
          : "Untitled project",
      tasks: Array.isArray(p.tasks) ? p.tasks : [],
    };

    project.tasks = project.tasks.filter(Boolean).map((t) => ({
      id: typeof t.id === "string" && t.id ? t.id : createId("t"),
      title:
        typeof t.title === "string" && t.title.trim()
          ? t.title.trim()
          : "Untitled task",
      subtasks: Array.isArray(t.subtasks) ? t.subtasks : [],
    }));

    project.tasks.forEach((t) => {
      t.subtasks = t.subtasks.filter(Boolean).map((s) => ({
        id: typeof s.id === "string" && s.id ? s.id : createId("s"),
        title:
          typeof s.title === "string" && s.title.trim()
            ? s.title.trim()
            : "Untitled subtask",
        done: typeof s.done === "boolean" ? s.done : false,
      }));
    });

    normalized.projects.push(project);
  });

  return normalized;
}

function normalizeKey(str) {
  return (str || "").trim().toLowerCase();
}

function rekeyProjectDeep(project, usedIds) {
  const p = safeClone(project);
  const oldToNew = new Map();

  const newProjectId = createId("p");
  oldToNew.set(p.id, newProjectId);
  p.id = newProjectId;
  usedIds.add(p.id);

  p.tasks.forEach((t) => {
    const newTaskId = createId("t");
    oldToNew.set(t.id, newTaskId);
    t.id = newTaskId;
    usedIds.add(t.id);

    t.subtasks.forEach((s) => {
      const newSubId = createId("s");
      oldToNew.set(s.id, newSubId);
      s.id = newSubId;
      usedIds.add(s.id);
    });
  });

  return p;
}

function mergeImportedState(incoming) {
  const usedIds = new Set();
  projects.forEach((p) => {
    usedIds.add(p.id);
    p.tasks.forEach((t) => {
      usedIds.add(t.id);
      t.subtasks.forEach((s) => usedIds.add(s.id));
    });
  });

  incoming.projects.forEach((incomingProjectRaw) => {
    let incomingProject = safeClone(incomingProjectRaw);

    if (usedIds.has(incomingProject.id)) {
      incomingProject = rekeyProjectDeep(incomingProject, usedIds);
    } else {
      usedIds.add(incomingProject.id);
    }

    const byId = projects.find((p) => p.id === incomingProject.id);
    const byName = projects.find(
      (p) => normalizeKey(p.name) === normalizeKey(incomingProject.name)
    );
    const targetProject = byId || byName;

    if (!targetProject) {
      projects.push(incomingProject);
      return;
    }

    incomingProject.tasks.forEach((incomingTask) => {
      const targetTask =
        targetProject.tasks.find((t) => t.id === incomingTask.id) ||
        targetProject.tasks.find(
          (t) => normalizeKey(t.title) === normalizeKey(incomingTask.title)
        );

      if (!targetTask) {
        if (usedIds.has(incomingTask.id)) incomingTask.id = createId("t");
        usedIds.add(incomingTask.id);
        incomingTask.subtasks.forEach((s) => {
          if (usedIds.has(s.id)) s.id = createId("s");
          usedIds.add(s.id);
        });
        targetProject.tasks.push(incomingTask);
        return;
      }

      incomingTask.subtasks.forEach((incomingSub) => {
        const targetSub =
          targetTask.subtasks.find((s) => s.id === incomingSub.id) ||
          targetTask.subtasks.find(
            (s) => normalizeKey(s.title) === normalizeKey(incomingSub.title)
          );

        if (!targetSub) {
          if (usedIds.has(incomingSub.id)) incomingSub.id = createId("s");
          usedIds.add(incomingSub.id);
          targetTask.subtasks.push(incomingSub);
          return;
        }

        targetSub.done = Boolean(targetSub.done || incomingSub.done);

        if (incomingSub.title && incomingSub.title !== targetSub.title) {
        }
      });
    });
  });
}

function renderGlobalProgress() {
  let total = 0;
  let done = 0;

  projects.forEach((project) => {
    project.tasks.forEach((task) => {
      task.subtasks.forEach((sub) => {
        total++;
        if (sub.done) done++;
      });
    });
  });

  if (total === 0) {
    globalProgressEl.style.display = "none";
    globalProgressEl.innerHTML = "";
    return;
  }

  const percent = Math.round((done / total) * 100);

  globalProgressEl.style.display = "block";
  globalProgressEl.innerHTML = `
        <div class="global-progress-header">
            <span>Overall progress (all projects)</span>
            <span>${done} / ${total} done (${percent}%)</span>
        </div>
        <div class="progress-bar">
            <div class="progress-bar__fill" style="width: ${percent}%"></div>
        </div>
    `;
}

function renderProjectProgress() {
  const project = getCurrentProject();
  if (!project) {
    projectProgressEl.style.display = "none";
    projectProgressEl.innerHTML = "";
    return;
  }

  let total = 0;
  let done = 0;

  project.tasks.forEach((task) => {
    task.subtasks.forEach((sub) => {
      total++;
      if (sub.done) done++;
    });
  });

  if (total === 0) {
    projectProgressEl.style.display = "none";
    projectProgressEl.innerHTML = "";
    return;
  }

  const percent = Math.round((done / total) * 100);

  projectProgressEl.style.display = "block";
  projectProgressEl.innerHTML = `
        <div class="global-progress-header">
            <span>Project progress</span>
            <span>${done} / ${total} done (${percent}%)</span>
        </div>
        <div class="progress-bar">
            <div class="progress-bar__fill" style="width: ${percent}%"></div>
        </div>
    `;
}

function renderProjectsTabs() {
  projectsTabsEl.innerHTML = "";

  if (projects.length === 0) {
    projectsTabsEl.innerHTML = `
            <div class="projects-tabs-empty">
                <span>No projects yet.</span>
            </div>
        `;
  } else {
    projects.forEach((project) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "project-tab" +
        (project.id === currentProjectId ? " project-tab--active" : "");
      btn.textContent = project.name;
      btn.dataset.projectId = project.id;
      btn.draggable = true;

      btn.addEventListener("click", () => {
        currentProjectId = project.id;
        renderAll();
      });

      attachProjectDragEvents(btn);
      projectsTabsEl.appendChild(btn);
    });
  }

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "project-tab project-tab--add";
  addBtn.innerHTML = `
        <span class="material-symbols-rounded"> add </span>
        <span>New project</span>
    `;
  addBtn.addEventListener("click", onAddProjectDialog);
  projectsTabsEl.appendChild(addBtn);
}

function attachProjectDragEvents(el) {
  el.addEventListener("dragstart", () => {
    draggedProjectId = el.dataset.projectId;
    el.classList.add("dragging-project");
  });

  el.addEventListener("dragend", () => {
    draggedProjectId = null;
    document
      .querySelectorAll(".project-tab")
      .forEach((tab) =>
        tab.classList.remove("project-tab--drop-target", "dragging-project")
      );
  });

  el.addEventListener("dragover", (e) => {
    if (!draggedProjectId || el.dataset.projectId === draggedProjectId) return;
    e.preventDefault();
    el.classList.add("project-tab--drop-target");
  });

  el.addEventListener("dragleave", () => {
    el.classList.remove("project-tab--drop-target");
  });

  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("project-tab--drop-target");
    if (!draggedProjectId || draggedProjectId === el.dataset.projectId) return;

    const fromIndex = projects.findIndex((p) => p.id === draggedProjectId);
    const toIndex = projects.findIndex((p) => p.id === el.dataset.projectId);
    if (fromIndex === -1 || toIndex === -1) return;

    const [moved] = projects.splice(fromIndex, 1);
    projects.splice(toIndex, 0, moved);

    persistState();
    renderProjectsTabs();
  });
}

function renderProjectHeader() {
  const project = getCurrentProject();
  if (!project) {
    projectHeaderEl.innerHTML = `
            <div class="project-header-empty">
                <p>Select a project or create a new one.</p>
            </div>
        `;
    return;
  }

  const tasksCount = project.tasks.length;
  let subtasksCount = 0;
  let completedCount = 0;
  project.tasks.forEach((task) => {
    subtasksCount += task.subtasks.length;
    completedCount += task.subtasks.filter((s) => s.done).length;
  });

  projectHeaderEl.innerHTML = `
        <div class="project-header-left">
            <h2 class="project-title">${escapeHtml(project.name)}</h2>
            <p class="project-meta">
                ${tasksCount} tasks • ${subtasksCount} subtasks (${completedCount} done)
            </p>
        </div>
        <div class="project-header-actions">
            <button type="button" class="ghost-btn ghost-btn--small js-rename-project">
                <span class="material-symbols-rounded"> edit </span>
                <span>Rename</span>
            </button>
            <button type="button" class="ghost-btn ghost-btn--small js-clear-project">
                <span class="material-symbols-rounded"> backspace </span>
                <span>Clear tasks</span>
            </button>
            <button type="button" class="ghost-btn ghost-btn--small ghost-btn--danger js-delete-project">
                <span class="material-symbols-rounded"> delete </span>
                <span>Delete project</span>
            </button>
        </div>
    `;

  const renameBtn = projectHeaderEl.querySelector(".js-rename-project");
  const clearBtn = projectHeaderEl.querySelector(".js-clear-project");
  const deleteBtn = projectHeaderEl.querySelector(".js-delete-project");

  renameBtn.addEventListener("click", () => onRenameProjectDialog(project));
  clearBtn.addEventListener("click", () => onClearProjectDialog(project));
  deleteBtn.addEventListener("click", () => onDeleteProjectDialog(project));
}

function renderBoard() {
  const project = getCurrentProject();

  tasksContainer.innerHTML = "";

  if (!project) {
    tasksContainer.classList.remove("tasks-container--grid");
    return;
  }

  tasksContainer.classList.toggle(
    "tasks-container--grid",
    layoutMode === "grid"
  );

  project.tasks.forEach((task) => {
    const card = document.createElement("article");
    card.className = "task-card";
    card.dataset.projectId = project.id;
    card.dataset.taskId = task.id;
    card.draggable = true;

    const totalSub = task.subtasks.length;
    const doneSub = task.subtasks.filter((s) => s.done).length;
    const percent = totalSub === 0 ? 0 : Math.round((doneSub / totalSub) * 100);

    card.innerHTML = `
            <header class="task-header">
                <div class="task-title">${escapeHtml(task.title)}</div>
                <div class="task-actions">
                    <button class="icon-btn js-clear-task" title="Clear subtasks">
                        <span class="material-symbols-rounded"> backspace </span>
                    </button>
                    <button class="icon-btn js-edit-task" title="Edit task">
                        <span class="material-symbols-rounded"> edit </span>
                    </button>
                    <button class="icon-btn js-delete-task" title="Delete task">
                        <span class="material-symbols-rounded"> delete </span>
                    </button>
                </div>
            </header>

            <div class="task-progress">
                <div class="task-progress-header">
                    <span>${doneSub} / ${totalSub} completed</span>
                    <span>${percent}%</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-bar__fill" style="width: ${percent}%"></div>
                </div>
            </div>

            <div class="subtasks-list" data-project-id="${
              project.id
            }" data-task-id="${task.id}"></div>

            <form class="add-subtask-form" data-project-id="${
              project.id
            }" data-task-id="${task.id}">
                <input type="text" placeholder="Add subtask..." />
                <button type="submit">
                    <span class="material-symbols-rounded"> add </span>
                    <span>Add</span>
                </button>
            </form>
        `;

    const subtasksList = card.querySelector(".subtasks-list");

    task.subtasks.forEach((sub) => {
      if (typeof sub.done !== "boolean") sub.done = false;

      const item = document.createElement("div");
      item.className = "subtask";
      item.draggable = true;
      item.dataset.projectId = project.id;
      item.dataset.taskId = task.id;
      item.dataset.subtaskId = sub.id;

      item.innerHTML = `
                <div class="subtask-left">
                    <input
                        type="checkbox"
                        class="subtask-checkbox"
                        ${sub.done ? "checked" : ""}
                    />
                    <div class="subtask-title ${
                      sub.done ? "subtask-title--done" : ""
                    }">
                        ${escapeHtml(sub.title)}
                    </div>
                </div>
                <div class="subtask-actions">
                    <button class="icon-btn js-edit-subtask" title="Edit subtask">
                        <span class="material-symbols-rounded"> edit </span>
                    </button>
                    <button class="icon-btn js-delete-subtask" title="Delete subtask">
                        <span class="material-symbols-rounded"> delete </span>
                    </button>
                </div>
            `;

      attachSubtaskDragEvents(item);
      subtasksList.appendChild(item);
    });

    tasksContainer.appendChild(card);
    attachTaskDragEvents(card);
  });

  attachBoardEvents();
}

function attachBoardEvents() {
  document.querySelectorAll(".add-subtask-form").forEach((form) => {
    form.addEventListener("submit", onAddSubtask);
  });

  document.querySelectorAll(".js-edit-task").forEach((btn) => {
    btn.addEventListener("click", onEditTaskInline);
  });

  document.querySelectorAll(".js-delete-task").forEach((btn) => {
    btn.addEventListener("click", onDeleteTaskDialog);
  });

  document.querySelectorAll(".js-clear-task").forEach((btn) => {
    btn.addEventListener("click", onClearTaskDialog);
  });

  document.querySelectorAll(".js-edit-subtask").forEach((btn) => {
    btn.addEventListener("click", onEditSubtaskDialog);
  });

  document.querySelectorAll(".js-delete-subtask").forEach((btn) => {
    btn.addEventListener("click", onDeleteSubtaskDialog);
  });

  document.querySelectorAll(".subtask-checkbox").forEach((checkbox) => {
    checkbox.addEventListener("change", onToggleSubtaskDone);
    checkbox.addEventListener("mousedown", (e) => e.stopPropagation());
  });

  document.querySelectorAll(".subtasks-list").forEach((zone) => {
    zone.addEventListener("dragover", onSubtaskDragOver);
    zone.addEventListener("dragleave", onSubtaskDragLeave);
    zone.addEventListener("drop", onSubtaskDrop);
  });
}

addTaskForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const title = newTaskTitleInput.value.trim();
  if (!title) return;

  const project = getCurrentProject();
  if (!project) return;

  project.tasks.push({
    id: "t" + Date.now(),
    title,
    subtasks: [],
  });

  newTaskTitleInput.value = "";
  persistState();
  renderAll();
});

function onAddSubtask(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const input = form.querySelector("input");
  const title = input.value.trim();
  if (!title) return;

  const projectId = form.dataset.projectId;
  const taskId = form.dataset.taskId;

  const project = projects.find((p) => p.id === projectId);
  if (!project) return;
  const task = project.tasks.find((t) => t.id === taskId);
  if (!task) return;

  task.subtasks.push({
    id: "s" + Date.now(),
    title,
    done: false,
  });

  persistState();
  renderAll();

  setTimeout(() => {
    const newForm = document.querySelector(
      `.add-subtask-form[data-project-id="${projectId}"][data-task-id="${taskId}"]`
    );
    const newInput = newForm?.querySelector("input");
    if (newInput) {
      newInput.value = "";
      newInput.focus();
    }
  }, 0);
}

function onEditTaskInline(e) {
  const card = e.currentTarget.closest(".task-card");
  const projectId = card.dataset.projectId;
  const taskId = card.dataset.taskId;

  const project = projects.find((p) => p.id === projectId);
  if (!project) return;
  const task = project.tasks.find((t) => t.id === taskId);
  if (!task) return;

  const titleEl = card.querySelector(".task-title");
  if (!titleEl) return;

  if (card.classList.contains("editing-task")) return;
  card.classList.add("editing-task");

  const input = document.createElement("input");
  input.type = "text";
  input.value = task.title;
  input.className = "task-title-input";

  titleEl.innerHTML = "";
  titleEl.appendChild(input);
  input.focus();
  input.select();

  const commit = () => {
    const newTitle = input.value.trim();
    card.classList.remove("editing-task");
    if (!newTitle || newTitle === task.title) {
      renderAll();
      return;
    }
    task.title = newTitle;
    persistState();
    renderAll();
  };

  const cancel = () => {
    card.classList.remove("editing-task");
    renderAll();
  };

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      commit();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      cancel();
    }
  });

  input.addEventListener("blur", () => {
    commit();
  });
}

function onDeleteTaskDialog(e) {
  const card = e.currentTarget.closest(".task-card");
  const projectId = card.dataset.projectId;
  const taskId = card.dataset.taskId;

  const project = projects.find((p) => p.id === projectId);
  if (!project) return;
  const task = project.tasks.find((t) => t.id === taskId);
  if (!task) return;

  openDialog({
    title: "Delete task",
    message: `Are you sure you want to delete "${task.title}" and all its subtasks?`,
    confirmText: "Delete",
    cancelText: "Cancel",
    onConfirm: () => {
      project.tasks = project.tasks.filter((t) => t.id !== taskId);
      persistState();
      renderAll();
    },
  });
}

function onClearTaskDialog(e) {
  const card = e.currentTarget.closest(".task-card");
  const projectId = card.dataset.projectId;
  const taskId = card.dataset.taskId;

  const project = projects.find((p) => p.id === projectId);
  if (!project) return;
  const task = project.tasks.find((t) => t.id === taskId);
  if (!task) return;

  openDialog({
    title: "Clear subtasks",
    message: `Remove all subtasks inside "${task.title}"?`,
    confirmText: "Clear",
    cancelText: "Cancel",
    onConfirm: () => {
      task.subtasks = [];
      persistState();
      renderAll();
    },
  });
}

function onEditSubtaskDialog(e) {
  const subtaskEl = e.currentTarget.closest(".subtask");
  const { projectId, taskId, subtaskId } = subtaskEl.dataset;

  const project = projects.find((p) => p.id === projectId);
  if (!project) return;
  const task = project.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const sub = task.subtasks.find((s) => s.id === subtaskId);
  if (!sub) return;

  openDialog({
    title: "Edit subtask",
    message: "Update the subtask title:",
    confirmText: "Save",
    cancelText: "Cancel",
    renderExtra: (container) => {
      const input = document.createElement("input");
      input.type = "text";
      input.value = sub.title;
      container.appendChild(input);
      setTimeout(() => input.focus(), 0);
      return input;
    },
    onConfirm: (inputElement) => {
      const newTitle = inputElement.value.trim();
      if (!newTitle || newTitle === sub.title) return;
      sub.title = newTitle;
      persistState();
      renderAll();
    },
  });
}

function onDeleteSubtaskDialog(e) {
  const subtaskEl = e.currentTarget.closest(".subtask");
  const { projectId, taskId, subtaskId } = subtaskEl.dataset;

  const project = projects.find((p) => p.id === projectId);
  if (!project) return;
  const task = project.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const sub = task.subtasks.find((s) => s.id === subtaskId);
  if (!sub) return;

  openDialog({
    title: "Delete subtask",
    message: `Are you sure you want to delete "${sub.title}"?`,
    confirmText: "Delete",
    cancelText: "Cancel",
    onConfirm: () => {
      task.subtasks = task.subtasks.filter((s) => s.id !== subtaskId);
      persistState();
      renderAll();
    },
  });
}

function onToggleSubtaskDone(e) {
  const checkbox = e.currentTarget;
  const subtaskEl = checkbox.closest(".subtask");
  const { projectId, taskId, subtaskId } = subtaskEl.dataset;

  const project = projects.find((p) => p.id === projectId);
  if (!project) return;
  const task = project.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const sub = task.subtasks.find((s) => s.id === subtaskId);
  if (!sub) return;

  sub.done = checkbox.checked;
  persistState();
  renderAll();
}

function attachSubtaskDragEvents(el) {
  el.addEventListener("dragstart", (e) => {
    if (e.target.closest(".subtask-checkbox")) {
      e.preventDefault();
      return;
    }

    draggedSubtask = {
      projectId: el.dataset.projectId,
      taskId: el.dataset.taskId,
      subtaskId: el.dataset.subtaskId,
    };
    el.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });

  el.addEventListener("dragend", () => {
    draggedSubtask = null;
    document
      .querySelectorAll(".subtasks-list")
      .forEach((z) => z.classList.remove("drop-target"));
    el.classList.remove("dragging");
  });
}

function onSubtaskDragOver(e) {
  if (!draggedSubtask) return;
  e.preventDefault();
  const zone = e.currentTarget;
  zone.classList.add("drop-target");
}

function onSubtaskDragLeave(e) {
  const zone = e.currentTarget;
  zone.classList.remove("drop-target");
}

function onSubtaskDrop(e) {
  e.preventDefault();
  const zone = e.currentTarget;
  zone.classList.remove("drop-target");

  if (!draggedSubtask) return;

  const fromProject = projects.find((p) => p.id === draggedSubtask.projectId);
  if (!fromProject) return;
  const fromTask = fromProject.tasks.find(
    (t) => t.id === draggedSubtask.taskId
  );
  if (!fromTask) return;

  const toProjectId = zone.dataset.projectId;
  const toTaskId = zone.dataset.taskId;
  const toProject = projects.find((p) => p.id === toProjectId);
  if (!toProject) return;
  const toTask = toProject.tasks.find((t) => t.id === toTaskId);
  if (!toTask) return;

  const index = fromTask.subtasks.findIndex(
    (s) => s.id === draggedSubtask.subtaskId
  );
  if (index === -1) return;

  const [moved] = fromTask.subtasks.splice(index, 1);
  toTask.subtasks.push(moved);

  persistState();
  renderAll();
}

function attachTaskDragEvents(card) {
  card.addEventListener("dragstart", (e) => {
    draggedTask = {
      projectId: card.dataset.projectId,
      taskId: card.dataset.taskId,
    };
    card.classList.add("dragging-task");
    e.dataTransfer.effectAllowed = "move";
  });

  card.addEventListener("dragend", () => {
    draggedTask = null;
    card.classList.remove("dragging-task");
  });
}

projectsTabsEl.addEventListener("dragover", (e) => {
  if (!draggedTask) return;
  const tab = e.target.closest(".project-tab");
  if (!tab || tab.classList.contains("project-tab--add")) return;
  e.preventDefault();
});

projectsTabsEl.addEventListener("drop", (e) => {
  if (!draggedTask) return;
  const tab = e.target.closest(".project-tab");
  if (!tab || tab.classList.contains("project-tab--add")) return;

  e.preventDefault();

  const targetProjectId = tab.dataset.projectId;
  const fromProject = projects.find((p) => p.id === draggedTask.projectId);
  const toProject = projects.find((p) => p.id === targetProjectId);
  if (!fromProject || !toProject) return;

  const index = fromProject.tasks.findIndex((t) => t.id === draggedTask.taskId);
  if (index === -1) return;

  const [moved] = fromProject.tasks.splice(index, 1);
  toProject.tasks.push(moved);

  currentProjectId = targetProjectId;
  persistState();
  renderAll();
});

function onAddProjectDialog() {
  openDialog({
    title: "New project",
    message: "Enter project name:",
    confirmText: "Create",
    cancelText: "Cancel",
    renderExtra: (container) => {
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "Project name";
      container.appendChild(input);
      setTimeout(() => input.focus(), 0);
      return input;
    },
    onConfirm: (inputElement) => {
      const name = inputElement.value.trim();
      if (!name) return;
      const project = {
        id: "p" + Date.now(),
        name,
        tasks: [],
      };
      projects.push(project);
      currentProjectId = project.id;
      persistState();
      renderAll();
    },
  });
}

function onRenameProjectDialog(project) {
  openDialog({
    title: "Rename project",
    message: "Update project name:",
    confirmText: "Save",
    cancelText: "Cancel",
    renderExtra: (container) => {
      const input = document.createElement("input");
      input.type = "text";
      input.value = project.name;
      container.appendChild(input);
      setTimeout(() => input.focus(), 0);
      return input;
    },
    onConfirm: (inputElement) => {
      const name = inputElement.value.trim();
      if (!name || name === project.name) return;
      project.name = name;
      persistState();
      renderAll();
    },
  });
}

function onClearProjectDialog(project) {
  openDialog({
    title: "Clear project",
    message: `Remove all tasks inside "${project.name}"?`,
    confirmText: "Clear",
    cancelText: "Cancel",
    onConfirm: () => {
      project.tasks = [];
      persistState();
      renderAll();
    },
  });
}

function onDeleteProjectDialog(project) {
  openDialog({
    title: "Delete project",
    message: `Are you sure you want to delete "${project.name}" and everything inside it?`,
    confirmText: "Delete",
    cancelText: "Cancel",
    onConfirm: () => {
      projects = projects.filter((p) => p.id !== project.id);
      if (!projects.length) {
        currentProjectId = null;
      } else if (!projects.some((p) => p.id === currentProjectId)) {
        currentProjectId = projects[0].id;
      }
      persistState();
      renderAll();
    },
  });
}

exportBtn.addEventListener("click", () => {
  exportStateToFile();
});

importBtn.addEventListener("click", () => {
  importInput.click();
});

importInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  importStateFromFile(file);
  e.target.value = "";
});

clearAllBtn.addEventListener("click", () => {
  if (!projects.length) return;
  openDialog({
    title: "Clear all projects",
    message: "This will remove all projects, tasks and subtasks. Continue?",
    confirmText: "Clear all",
    cancelText: "Cancel",
    onConfirm: () => {
      projects = [];
      currentProjectId = null;
      persistState();
      renderAll();
    },
  });
});

layoutToggleBtn.addEventListener("click", () => {
  layoutMode = layoutMode === "list" ? "grid" : "list";
  updateLayoutToggleButton();
  persistState();
  renderBoard();
});

function updateLayoutToggleButton() {
  if (layoutMode === "list") {
    layoutToggleBtn.innerHTML = `
            <span class="material-symbols-rounded"> view_agenda </span>
            <span>List layout</span>
        `;
  } else {
    layoutToggleBtn.innerHTML = `
            <span class="material-symbols-rounded"> grid_view </span>
            <span>Grid layout</span>
        `;
  }
}

function renderAll() {
  updateLayoutToggleButton();
  renderProjectsTabs();
  renderProjectHeader();
  renderGlobalProgress();
  renderProjectProgress();
  renderBoard();
}

function getDefaultProjects() {
  return [
    {
      id: "p1",
      name: "Demo project",
      tasks: [
        {
          id: "t1",
          title: "Prepare project plan",
          subtasks: [
            { id: "s1", title: "Define scope", done: false },
            { id: "s2", title: "List main milestones", done: false },
          ],
        },
        {
          id: "t2",
          title: "Frontend work",
          subtasks: [
            { id: "s3", title: "Design header", done: false },
            { id: "s4", title: "Implement task board UI", done: false },
          ],
        },
      ],
    },
  ];
}

(async function init() {
  miniDb = await openMiniDB();
  let state = await loadStateFromDB();

  if (state && Array.isArray(state.projects)) {
    projects = state.projects;
    layoutMode = state.layoutMode || "list";
  } else {
    const legacyTasks = loadLegacyTasks();
    if (legacyTasks && legacyTasks.length) {
      projects = [
        {
          id: "p_legacy",
          name: "Imported from old board",
          tasks: legacyTasks,
        },
      ];
    } else {
      projects = getDefaultProjects();
    }
    layoutMode = "list";
    persistState();
  }

  currentProjectId = projects[0] ? projects[0].id : null;
  renderAll();
})();
