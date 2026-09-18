import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { config, DOWNLOAD_TIMEOUT_MS } from "../config.js";
import { inject } from "./sinfInjector.js";
import { ChunkedDownloader } from "./chunkedDownloader.js";
import { r2Storage, R2StorageError } from "./r2Storage.js";
import { hasPackage, localPackagePath } from "./packageFiles.js";
import type { DownloadTask, Software, Sinf } from "../types/index.js";

const deletingTasks = new Set<string>();

export class DownloadCapacityError extends Error {}

const tasks = new Map<string, DownloadTask>();
const abortControllers = new Map<string, AbortController>();
const chunkDownloaders = new Map<string, ChunkedDownloader>();
const progressListeners = new Map<string, Set<(task: DownloadTask) => void>>();

const PACKAGES_DIR = path.join(config.dataDir, "packages");
const TASKS_FILE = path.join(config.dataDir, "tasks.json");
// Legacy file from old code — cleaned up on startup
const LEGACY_DOWNLOADS_FILE = path.join(config.dataDir, "downloads.json");

// --- Security: path segment validation ---
const SAFE_SEGMENT_RE = /^[a-zA-Z0-9._-]+$/;

/** Validate and sanitize a path segment. Rejects traversal, replaces unsafe chars. */
function safePathSegment(value: string, label: string): string {
  if (!value || value === "." || value === "..") {
    throw new Error(`Invalid ${label}`);
  }
  if (SAFE_SEGMENT_RE.test(value)) return value;
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new Error(`Invalid ${label}`);
  }
  return cleaned;
}

// --- Security: download URL allowlist ---
const ALLOWED_DOWNLOAD_HOSTS_RE = /\.apple\.com$/i;

export function validateDownloadURL(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid download URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Download URL must use HTTPS");
  }

  if (!ALLOWED_DOWNLOAD_HOSTS_RE.test(parsed.hostname)) {
    throw new Error("Download URL must be from an Apple domain (*.apple.com)");
  }

  if (
    /^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname) ||
    parsed.hostname.startsWith("[")
  ) {
    throw new Error("Download URL must not use IP addresses");
  }
}

// --- Security: sanitize task for API responses ---
export function sanitizeTaskForResponse(task: DownloadTask): Omit<
  DownloadTask,
  | "downloadURL"
  | "sinfs"
  | "iTunesMetadata"
  | "filePath"
  | "remote"
  | "uploadTarget"
  | "compiled"
> & {
  hasFile: boolean;
  storage: "local" | "r2";
  canResumeUpload: boolean;
  canArchive: boolean;
} {
  const {
    downloadURL,
    sinfs,
    iTunesMetadata,
    filePath,
    remote,
    uploadTarget,
    compiled,
    ...safe
  } = task;
  return {
    ...safe,
    hasFile: task.status === "completed" && hasPackage(task),
    storage: remote ? "r2" : "local",
    canResumeUpload:
      !!r2Storage &&
      !!compiled &&
      !remote &&
      task.status === "failed" &&
      !!filePath &&
      fs.existsSync(filePath),
    canArchive: !!r2Storage && !remote && task.status === "completed",
  };
}

// Persist compiled files, including upload failures, without Apple credentials.
function persistTasks() {
  const completed = Array.from(tasks.values())
    .filter(
      (t) =>
        (t.status === "completed" || t.compiled) &&
        (t.filePath || t.remote || t.uploadTarget),
    )
    .map((t) => ({
      id: t.id,
      software: t.software,
      accountHash: t.accountHash,
      downloadURL: "",
      sinfs: [],
      status: t.status,
      progress: t.progress,
      speed: t.speed,
      filePath: t.filePath,
      compiled: t.compiled,
      remote: t.remote,
      uploadTarget: t.uploadTarget,
      error: t.error,
      createdAt: t.createdAt,
    }));
  // Never expose a partially written manifest to restart/orphan cleanup.
  const temporary = `${TASKS_FILE}.tmp`;
  const fd = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(completed, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, TASKS_FILE);
  const directory = fs.openSync(config.dataDir, "r");
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

// Auto-cleanup: delete completed files older than configured days
export async function runTimeCleanup() {
  const { autoCleanupDays } = config;
  if (autoCleanupDays <= 0) return;
  const cutoff = Date.now() - autoCleanupDays * 24 * 60 * 60 * 1000;

  // Collect IDs first to avoid mutating the map during iteration
  const expiredIds: string[] = [];
  for (const task of tasks.values()) {
    if (
      task.status === "completed" &&
      task.filePath &&
      fs.existsSync(task.filePath)
    ) {
      try {
        const stat = fs.statSync(task.filePath);
        if (stat.mtimeMs < cutoff) {
          expiredIds.push(task.id);
        }
      } catch {
        // File inaccessible — skip
      }
    }
  }

  for (const id of expiredIds) {
    console.log(`[Cleanup] Deleting expired task: ${id}`);
    await deleteTask(id);
  }
}

// Auto-cleanup: evict oldest completed files when total size exceeds limit
export async function runSpaceCleanup() {
  const { autoCleanupMaxMB } = config;
  if (autoCleanupMaxMB <= 0) return;
  const maxBytes = autoCleanupMaxMB * 1024 * 1024;

  let totalBytes = 0;
  const fileTasks: { id: string; size: number; mtimeMs: number }[] = [];

  for (const task of tasks.values()) {
    if (
      task.status === "completed" &&
      task.filePath &&
      fs.existsSync(task.filePath)
    ) {
      try {
        const stat = fs.statSync(task.filePath);
        totalBytes += stat.size;
        fileTasks.push({ id: task.id, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // File inaccessible — skip
      }
    }
  }

  if (totalBytes <= maxBytes) return;

  fileTasks.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const ft of fileTasks) {
    console.log(`[Cleanup] Space limit exceeded, deleting task: ${ft.id}`);
    await deleteTask(ft.id);
    totalBytes -= ft.size;
    if (totalBytes <= maxBytes) break;
  }
}

// Schedule daily time-based cleanup at midnight (self-correcting to avoid drift)
function scheduleDailyCleanup() {
  function msUntilMidnight(): number {
    const now = new Date();
    const next = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      0,
      0,
      0,
    );
    return next.getTime() - now.getTime();
  }

  async function tick() {
    try {
      await runTimeCleanup();
    } catch {
      console.error("Scheduled package cleanup failed");
    } finally {
      setTimeout(tick, msUntilMidnight()).unref();
    }
  }

  setTimeout(tick, msUntilMidnight()).unref();
}

function initOnStartup() {
  // Remove legacy downloads.json from old code
  if (fs.existsSync(LEGACY_DOWNLOADS_FILE)) {
    fs.unlinkSync(LEGACY_DOWNLOADS_FILE);
  }

  // Ensure packages dir exists
  fs.mkdirSync(PACKAGES_DIR, { recursive: true });

  // Load completed tasks from previous run
  if (fs.existsSync(TASKS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(TASKS_FILE, "utf-8"));
      if (!Array.isArray(data)) throw new Error("Invalid task manifest");
      if (Array.isArray(data)) {
        for (const item of data) {
          // Remote objects have no local file. In-flight uploads recover as
          // retryable failures, keeping their already-signed local IPA.
          if (
            item.id &&
            (item.status === "completed" || item.compiled) &&
            (hasPackage(item) || item.uploadTarget)
          ) {
            const task: DownloadTask = {
              id: item.id,
              software: item.software,
              accountHash: item.accountHash,
              downloadURL: "",
              sinfs: [],
              status:
                item.remote || item.status === "completed"
                  ? "completed"
                  : "failed",
              progress: 100,
              speed: "0 B/s",
              filePath: item.filePath,
              remote: item.remote,
              uploadTarget: item.remote ? undefined : item.uploadTarget,
              compiled: true,
              error:
                item.status === "uploading"
                  ? "Upload interrupted; resume to retry the local IPA"
                  : item.error,
              createdAt: item.createdAt,
            };
            tasks.set(task.id, task);
          }
        }
      }
    } catch {
      // A bad manifest must never cause the only copies of IPAs to be deleted.
      throw new Error(
        "Cannot load tasks.json; package files were left untouched",
      );
    }
  }

  // Only a durably recorded, verified remote copy permits local deletion.
  for (const task of tasks.values()) {
    if (task.remote && task.filePath) releaseLocalCopy(task);
  }
  cleanOrphanedPackages();

  // Run time-based cleanup once on startup, then schedule daily
  void runTimeCleanup().catch(() =>
    console.error("Startup package cleanup failed"),
  );
  scheduleDailyCleanup();
}

function cleanOrphanedPackages() {
  const knownPaths = new Set<string>();
  for (const task of tasks.values()) {
    if (task.filePath) {
      knownPaths.add(path.resolve(task.filePath));
    }
  }

  const packagesBase = path.resolve(PACKAGES_DIR);

  function walkAndClean(dir: string) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkAndClean(fullPath);
        // Remove empty directories
        if (fs.readdirSync(fullPath).length === 0) {
          fs.rmdirSync(fullPath);
        }
      } else if (
        entry.isFile() &&
        !knownPaths.has(path.resolve(fullPath)) &&
        /\.part\d+$/.test(entry.name)
      ) {
        // A full IPA may be the only copy after a manifest write failure.
        // Only incomplete chunks are safe to remove without a task record.
        fs.unlinkSync(fullPath);
      }
    }
  }

  walkAndClean(packagesBase);
}

// Initialize on startup
initOnStartup();

function notifyProgress(task: DownloadTask) {
  const listeners = progressListeners.get(task.id);
  if (listeners) {
    for (const listener of listeners) {
      listener(task);
    }
  }
}

export function addProgressListener(
  taskId: string,
  listener: (task: DownloadTask) => void,
) {
  let listeners = progressListeners.get(taskId);
  if (!listeners) {
    listeners = new Set();
    progressListeners.set(taskId, listeners);
  }
  listeners.add(listener);
}

export function removeProgressListener(
  taskId: string,
  listener: (task: DownloadTask) => void,
) {
  const listeners = progressListeners.get(taskId);
  if (listeners) {
    listeners.delete(listener);
    if (listeners.size === 0) {
      progressListeners.delete(taskId);
    }
  }
}

export function getAllTasks(): DownloadTask[] {
  return Array.from(tasks.values());
}

export function getTask(id: string): DownloadTask | undefined {
  return tasks.get(id);
}

export async function deleteTask(id: string): Promise<boolean> {
  const task = tasks.get(id);
  if (!task) return false;
  if (
    task.status === "uploading" ||
    task.status === "injecting" ||
    deletingTasks.has(id)
  ) {
    throw new Error(
      "Package is busy; wait for the current operation to finish",
    );
  }
  deletingTasks.add(id);
  try {
    // Keep the task and its object key when remote deletion fails so it is retryable.
    const object = task.remote ?? task.uploadTarget;
    if (object) {
      if (!r2Storage) throw new Error("R2 is not configured");
      await r2Storage.delete(object);
    }

    // Abort if downloading
    const controller = abortControllers.get(id);
    if (controller) {
      controller.abort();
      abortControllers.delete(id);
    }
    const downloader = chunkDownloaders.get(id);
    if (downloader) {
      downloader.abort();
      chunkDownloaders.delete(id);
    }

    // Remove file if exists, with path safety check
    if (task.filePath) {
      const resolved = path.resolve(task.filePath);
      const packagesBase = path.resolve(PACKAGES_DIR);
      if (
        resolved.startsWith(packagesBase + path.sep) &&
        fs.existsSync(resolved)
      ) {
        fs.unlinkSync(resolved);

        // Clean up empty parent directories
        let dir = path.dirname(resolved);
        while (dir !== packagesBase && dir.startsWith(packagesBase)) {
          const contents = fs.readdirSync(dir);
          if (contents.length === 0) {
            fs.rmdirSync(dir);
            dir = path.dirname(dir);
          } else {
            break;
          }
        }
      }
    }

    tasks.delete(id);
    progressListeners.delete(id);
    persistTasks();
    return true;
  } finally {
    deletingTasks.delete(id);
  }
}

export function pauseTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task || task.status !== "downloading") return false;

  const controller = abortControllers.get(id);
  if (controller) {
    controller.abort();
    abortControllers.delete(id);
  }
  const downloader = chunkDownloaders.get(id);
  if (downloader) {
    downloader.abort();
    chunkDownloaders.delete(id);
  }

  task.status = "paused";
  notifyProgress(task);
  return true;
}

export function resumeTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task || deletingTasks.has(id)) return false;
  if (task.compiled && task.status === "failed" && r2Storage && !task.remote) {
    void archiveTask(task);
    return true;
  }
  if (task.status !== "paused") return false;
  assertDownloadCapacity();
  void startDownload(task);
  return true;
}

export function createTask(
  software: Software,
  accountHash: string,
  downloadURL: string,
  sinfs: Sinf[],
  iTunesMetadata?: string,
): DownloadTask {
  assertDownloadCapacity();
  // Validate download URL
  validateDownloadURL(downloadURL);

  // Validate path segments
  safePathSegment(accountHash, "accountHash");
  safePathSegment(software.bundleID, "bundleID");
  safePathSegment(software.version, "version");

  const task: DownloadTask = {
    id: uuidv4(),
    software,
    accountHash,
    downloadURL,
    sinfs,
    iTunesMetadata,
    status: "pending",
    progress: 0,
    speed: "0 B/s",
    createdAt: new Date().toISOString(),
  };

  tasks.set(task.id, task);
  void startDownload(task);
  return task;
}

function assertDownloadCapacity() {
  if (config.maxActiveDownloads <= 0) return;
  const active = getAllTasks().filter((t) =>
    ["pending", "downloading", "injecting", "uploading"].includes(t.status),
  );
  if (active.length >= config.maxActiveDownloads)
    throw new DownloadCapacityError(
      "Maximum concurrent downloads reached; wait for an active task to finish",
    );
}

/** Explicit migration of an existing local package; never happens on startup. */
export function archivePackage(id: string): boolean {
  const task = tasks.get(id);
  if (
    !r2Storage ||
    !task ||
    task.status !== "completed" ||
    task.remote ||
    deletingTasks.has(id)
  )
    return false;
  task.compiled = true;
  void archiveTask(task);
  return true;
}

async function archiveTask(task: DownloadTask) {
  const local = localPackagePath(task);
  if (!r2Storage || !local) return;
  task.status = "uploading";
  task.error = undefined;
  task.progress = 0;
  task.speed = "";
  task.uploadProgress = {
    phase: "queued",
    uploadedBytes: 0,
    totalBytes: 0,
    bytesPerSecond: 0,
  };
  try {
    const target = r2Storage.target(task.id);
    if (task.uploadTarget && task.uploadTarget.bucket !== target.bucket) {
      throw new R2StorageError(
        "Restore the original R2 bucket before retrying this upload",
      );
    }
    task.uploadTarget = target;
    // Save BEFORE any network calls: restart must retain this compiled file
    // and deletion must cover objects whose completion response was lost.
    persistTasks();
    notifyProgress(task);
    const remote = await r2Storage.upload(local, task.id, (progress) => {
      task.uploadProgress = progress;
      task.progress =
        progress.totalBytes > 0
          ? Math.floor((progress.uploadedBytes / progress.totalBytes) * 100)
          : 0;
      notifyProgress(task);
    });
    task.remote = remote;
    task.status = "completed";
    task.progress = 100;
    task.uploadProgress = undefined;
    try {
      persistTasks();
    } catch (error) {
      task.filePath = local;
      task.remote = undefined;
      throw error;
    }
    // The verified remote key and local cleanup path are durable now.
    task.uploadTarget = undefined;
    releaseLocalCopy(task);
  } catch (error) {
    console.error(
      `R2 upload failed for package ${task.id}: ${error instanceof Error ? error.name : "UnknownError"}`,
    );
    task.status = "failed";
    task.error =
      error instanceof R2StorageError
        ? error.message
        : "R2 upload failed; local IPA retained. Check storage credentials/connectivity and resume to retry.";
    try {
      persistTasks();
    } catch {
      console.error(
        `Cannot persist upload recovery for package ${task.id}; local IPA retained`,
      );
    }
  }
  notifyProgress(task);
}

function releaseLocalCopy(task: DownloadTask) {
  const local = localPackagePath(task);
  if (!task.remote || !local) return;
  try {
    fs.rmSync(local, { force: true });
    task.filePath = undefined;
  } catch {
    task.error = "Uploaded to R2, but local file cleanup failed";
    console.error(`Local cleanup failed for uploaded package ${task.id}`);
  }
}

async function startDownload(task: DownloadTask) {
  // Claim the slot synchronously, before any await.
  task.status = "downloading";
  try {
    await runTimeCleanup();
    await runSpaceCleanup();
  } catch {
    task.status = "failed";
    task.error = "Package cleanup failed";
    notifyProgress(task);
    return;
  }
  if (!tasks.has(task.id)) return;

  const controller = new AbortController();
  abortControllers.set(task.id, controller);

  // Set a global timeout for the entire download
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  task.status = "downloading";
  task.progress = 0;
  task.speed = "0 B/s";
  task.error = undefined;
  notifyProgress(task);

  // Sanitize path segments
  const safeAccountHash = safePathSegment(task.accountHash, "accountHash");
  const safeBundleID = safePathSegment(task.software.bundleID, "bundleID");
  const safeVersion = safePathSegment(task.software.version, "version");

  const dir = path.join(
    PACKAGES_DIR,
    safeAccountHash,
    safeBundleID,
    safeVersion,
  );

  // Verify the resolved path is within PACKAGES_DIR
  const resolvedDir = path.resolve(dir);
  const packagesBase = path.resolve(PACKAGES_DIR);
  if (!resolvedDir.startsWith(packagesBase + path.sep)) {
    task.status = "failed";
    task.error = "Invalid path";
    clearTimeout(timeout);
    notifyProgress(task);
    return;
  }

  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `${task.id}.ipa`);
  task.filePath = filePath;

  try {
    // Re-validate download URL before fetching
    validateDownloadURL(task.downloadURL);

    const downloader = new ChunkedDownloader(task.downloadURL, filePath, {
      onProgress: (info) => {
        task.speed = info.speed;
        if (info.total > 0) {
          task.progress = Math.round((info.downloaded / info.total) * 100);
        }
        notifyProgress(task);
      },
    });
    chunkDownloaders.set(task.id, downloader);

    await downloader.download(controller.signal);
    if (!tasks.has(task.id)) return;

    chunkDownloaders.delete(task.id);
    abortControllers.delete(task.id);
    clearTimeout(timeout);

    // Inject sinfs
    if (task.sinfs.length > 0) {
      task.status = "injecting";
      task.progress = 100;
      notifyProgress(task);

      await inject(task.sinfs, filePath, task.iTunesMetadata);
    }

    task.compiled = true;
    task.status = "completed";
    task.progress = 100;

    // Strip sensitive data after successful compile
    task.downloadURL = "";
    task.sinfs = [];
    task.iTunesMetadata = undefined;

    // Persist the local compiled file before attempting remote storage.
    persistTasks();
    if (r2Storage) await archiveTask(task);
    else notifyProgress(task);
  } catch (err) {
    chunkDownloaders.delete(task.id);
    abortControllers.delete(task.id);
    clearTimeout(timeout);

    if (err instanceof Error && err.name === "AbortError") {
      // Status may have been changed to "paused" externally by pauseTask()
      if ((task.status as string) === "paused") return;
      task.status = "failed";
      task.error = "Download timed out";
      notifyProgress(task);
      return;
    }

    task.status = "failed";
    console.error(
      `Download ${task.id} failed:`,
      err instanceof Error ? err.message : err,
    );
    task.error = "Download failed";
    notifyProgress(task);
  }
}
