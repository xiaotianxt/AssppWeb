import { Router, Request, Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  archivePackage,
  deleteTask,
  getAllTasks,
  getTask,
  sanitizeTaskForResponse,
} from '../services/downloadManager.js';
import {
  hasPackage,
  localPackagePath,
  packageFilename,
  packageSize,
} from '../services/packageFiles.js';
import { r2Storage } from '../services/r2Storage.js';
import {
  asyncRoute,
  getIdParam,
  requireAccountHash,
  verifyTaskOwnership,
} from '../utils/route.js';
import type { DownloadTask, PackageInfo } from '../types/index.js';

const router = Router();

function ownedPackage(req: Request, res: Response): DownloadTask | undefined {
  const hash = requireAccountHash(req, res);
  if (!hash) return;
  const task = getTask(getIdParam(req));
  if (!task || !hasPackage(task)) {
    res.status(404).json({ error: 'Package not found' });
    return;
  }
  if (!verifyTaskOwnership(task, hash, res)) return;
  return task;
}

router.get('/packages', (req: Request, res: Response) => {
  const hashes =
    typeof req.query.accountHashes === 'string'
      ? new Set(req.query.accountHashes.split(',').filter(Boolean))
      : new Set();
  const packages: Omit<PackageInfo, 'filePath'>[] = getAllTasks()
    .filter(
      (t) =>
        t.status === 'completed' && hashes.has(t.accountHash) && hasPackage(t),
    )
    .map((t) => ({
      id: t.id,
      software: t.software,
      accountHash: t.accountHash,
      fileSize: packageSize(t),
      createdAt: t.createdAt,
    }));
  res.json(packages);
});

// Fetch JSON with the access header, then navigate directly to R2. Never send
// X-Access-Token cross-origin or buffer a whole IPA into a browser Blob.
router.get(
  '/packages/:id/link',
  asyncRoute(async (req, res) => {
    const task = ownedPackage(req, res);
    if (!task) return;
    if (task.status !== 'completed') {
      res.status(409).json({ error: 'Package is not ready' });
      return;
    }
    if (!task.remote) {
      res.json({ url: null });
      return;
    }
    if (!r2Storage) throw new Error('R2 is not configured');
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      url: await r2Storage.downloadUrl(task.remote, packageFilename(task)),
    });
  }),
);

router.get(
  '/packages/:id/file',
  asyncRoute(async (req, res, next) => {
    const task = ownedPackage(req, res);
    if (!task) return;
    if (task.status !== 'completed') {
      res.status(409).json({ error: 'Package is not ready' });
      return;
    }
    if (task.remote) {
      if (!r2Storage) throw new Error('R2 is not configured');
      // Legacy clients may fetch this route with X-Access-Token. Stream here
      // instead of redirecting that authenticated request to another origin.
      const object = await r2Storage.read(task.remote, req.headers.range);
      if (!(object.Body instanceof Readable))
        throw new Error('R2 returned no package stream');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${packageFilename(task)}"`,
      );
      res.setHeader('Accept-Ranges', 'bytes');
      if (object.ContentLength !== undefined)
        res.setHeader('Content-Length', object.ContentLength);
      if (object.ContentRange) {
        res.status(206);
        res.setHeader('Content-Range', object.ContentRange);
      }
      await pipeline(object.Body, res);
      return;
    }
    res.download(localPackagePath(task)!, packageFilename(task), (error) => {
      if (error) next(error);
    });
  }),
);

router.post('/packages/:id/archive', (req, res) => {
  const task = ownedPackage(req, res);
  if (!task) return;
  if (!archivePackage(task.id)) {
    res.status(409).json({ error: 'Package cannot be uploaded now' });
    return;
  }
  res.status(202).json(sanitizeTaskForResponse(task));
});

router.delete(
  '/packages/:id',
  asyncRoute(async (req, res) => {
    const task = ownedPackage(req, res);
    if (!task) return;
    if (task.status === 'injecting' || task.status === 'uploading') {
      res.status(409).json({ error: 'Package is busy' });
      return;
    }
    await deleteTask(task.id);
    res.json({ success: true });
  }),
);

export default router;
