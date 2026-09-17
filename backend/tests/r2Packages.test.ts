import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

const storage = vi.hoisted(() => ({
  upload: vi.fn(),
  target: vi.fn(),
  delete: vi.fn(),
  downloadUrl: vi.fn(),
  read: vi.fn(),
}));
vi.mock('../src/services/r2Storage.js', () => ({
  r2Storage: storage,
  R2StorageError: class extends Error {},
  DOWNLOAD_LINK_SECONDS: 900,
}));
let directory: string;
const id = '12345678-1234-1234-1234-123456789abc';
const hash = 'account-hash';
const remote = {
  bucket: 'test',
  key: `packages/${id}.ipa`,
  size: 3,
  etag: 'verified',
};
let local: string;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  storage.target.mockReturnValue({ bucket: remote.bucket, key: remote.key });
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asspp-packages-test-'));
  local = path.join(directory, 'packages', 'app.ipa');
  fs.mkdirSync(path.dirname(local));
  fs.writeFileSync(local, 'ipa');
  vi.stubEnv('DATA_DIR', directory);
  vi.stubEnv('ACCESS_PASSWORD', 'test-access-password');
  vi.stubEnv('AUTO_CLEANUP_DAYS', '0');
  vi.stubEnv('AUTO_CLEANUP_MAX_MB', '0');
  fs.writeFileSync(
    path.join(directory, 'tasks.json'),
    JSON.stringify([
      {
        id,
        accountHash: hash,
        software: { id: 1, name: 'App', version: '1', bundleID: 'test.app' },
        status: 'completed',
        filePath: local,
        createdAt: new Date().toISOString(),
      },
    ]),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function waitUntilSettled(
  manager: typeof import('../src/services/downloadManager.js'),
) {
  await vi.waitFor(() =>
    expect(manager.getTask(id)?.status).not.toBe('uploading'),
  );
}

it('keeps an upload failure across restart and retries without downloading or signing again', async () => {
  let manager = await import('../src/services/downloadManager.js');
  storage.upload.mockRejectedValueOnce(new Error('offline'));
  expect(manager.archivePackage(id)).toBe(true);
  await waitUntilSettled(manager);
  expect(fs.readFileSync(local, 'utf8')).toBe('ipa');
  expect(manager.sanitizeTaskForResponse(manager.getTask(id)!)).toMatchObject({
    status: 'failed',
    canResumeUpload: true,
  });
  vi.resetModules();
  manager = await import('../src/services/downloadManager.js');
  expect(manager.getTask(id)?.compiled).toBe(true);
  storage.upload.mockImplementation(async (file) => {
    expect(fs.readFileSync(file, 'utf8')).toBe('ipa');
    return remote;
  });
  expect(manager.resumeTask(id)).toBe(true);
  await waitUntilSettled(manager);
  expect(fs.existsSync(local)).toBe(false);
  const saved = JSON.parse(
    fs.readFileSync(path.join(directory, 'tasks.json'), 'utf8'),
  )[0];
  expect(saved).toMatchObject({
    status: 'completed',
    remote,
    downloadURL: '',
    sinfs: [],
  });
  vi.resetModules();
  manager = await import('../src/services/downloadManager.js');
  expect(manager.sanitizeTaskForResponse(manager.getTask(id)!)).toMatchObject({
    status: 'completed',
    storage: 'r2',
    hasFile: true,
  });
});

it('blocks deletion during upload and retains the remote record if deletion fails', async () => {
  const manager = await import('../src/services/downloadManager.js');
  let finish!: (value: typeof remote) => void;
  storage.upload.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  manager.archivePackage(id);
  await expect(manager.deleteTask(id)).rejects.toThrow('busy');
  finish(remote);
  await waitUntilSettled(manager);
  storage.delete.mockRejectedValueOnce(new Error('offline'));
  await expect(manager.deleteTask(id)).rejects.toThrow('offline');
  expect(manager.getTask(id)?.remote).toEqual(remote);
  storage.delete.mockResolvedValueOnce(undefined);
  await expect(manager.deleteTask(id)).resolves.toBe(true);
  expect(
    JSON.parse(fs.readFileSync(path.join(directory, 'tasks.json'), 'utf8')),
  ).toEqual([]);
});

it('does not unlink the local IPA if the verified remote location cannot be persisted', async () => {
  const manager = await import('../src/services/downloadManager.js');
  storage.upload.mockImplementation(async () => {
    // Deterministic rename failure, without relying on filesystem permission semantics.
    fs.mkdirSync(path.join(directory, 'tasks.json.blocker'));
    fs.renameSync(
      path.join(directory, 'tasks.json'),
      path.join(directory, 'tasks.backup.json'),
    );
    fs.renameSync(
      path.join(directory, 'tasks.json.blocker'),
      path.join(directory, 'tasks.json'),
    );
    return remote;
  });
  manager.archivePackage(id);
  await waitUntilSettled(manager);
  expect(fs.readFileSync(local, 'utf8')).toBe('ipa');
  expect(manager.getTask(id)?.status).toBe('failed');
});

it('deletes the attempted remote key after an ambiguous upload failure, even across restart', async () => {
  let manager = await import('../src/services/downloadManager.js');
  storage.upload.mockRejectedValue(new Error('Completion response lost'));
  manager.archivePackage(id);
  await waitUntilSettled(manager);
  vi.resetModules();
  manager = await import('../src/services/downloadManager.js');
  await manager.deleteTask(id);
  expect(storage.delete).toHaveBeenCalledWith({
    bucket: remote.bucket,
    key: remote.key,
  });
  expect(fs.existsSync(local)).toBe(false);
  expect(manager.getTask(id)).toBeUndefined();
});

it('fails closed on a malformed manifest without removing packages', async () => {
  fs.writeFileSync(path.join(directory, 'tasks.json'), '{}');
  await expect(import('../src/services/downloadManager.js')).rejects.toThrow(
    'left untouched',
  );
  expect(fs.readFileSync(local, 'utf8')).toBe('ipa');
});

it('authorizes remote links, expires install capabilities, and preserves Range delivery for old clients', async () => {
  const manager = await import('../src/services/downloadManager.js');
  storage.upload.mockResolvedValue(remote);
  manager.archivePackage(id);
  await waitUntilSettled(manager);
  storage.downloadUrl.mockResolvedValue(
    'https://test.r2.cloudflarestorage.com/test/package?signature=test',
  );
  const { accessAuth } = await import('../src/middleware/accessAuth.js');
  const { accessPasswordHash } = await import('../src/config.js');
  const { createInstallToken, verifyInstallToken } = await import(
    '../src/services/installToken.js'
  );
  const app = express();
  app.use(express.json(), accessAuth);
  app.use((await import('../src/routes/packages.js')).default);
  app.use((await import('../src/routes/install.js')).default);
  const url = `/packages/${id}/link?accountHash=${hash}`;
  expect((await request(app).get(url)).status).toBe(401);
  expect(
    (
      await request(app)
        .get(`/packages/${id}/link?accountHash=wrong-hash`)
        .set('X-Access-Token', accessPasswordHash)
    ).status,
  ).toBe(403);
  const link = await request(app)
    .get(url)
    .set('X-Access-Token', accessPasswordHash);
  expect(link.body.url).toContain('https://test.r2.');
  expect(link.headers['cache-control']).toContain('no-store');
  const publicTask = manager.sanitizeTaskForResponse(manager.getTask(id)!);
  expect(publicTask).not.toHaveProperty('remote');
  expect(publicTask).not.toHaveProperty('filePath');
  expect((await request(app).get(`/install/${id}/manifest.plist`)).status).toBe(
    403,
  );
  expect(
    (await request(app).get(`/install/${id}/url?accountHash=${hash}`)).status,
  ).toBe(401);
  const info = await request(app)
    .get(`/install/${id}/url?accountHash=${hash}`)
    .set('X-Access-Token', accessPasswordHash);
  expect(info.status).toBe(200);
  const token = new URL(info.body.manifestUrl).searchParams.get('token');
  expect(
    (await request(app).get(`/install/${id}/manifest.plist?token=${token}`))
      .text,
  ).toContain('signature=test');
  expect(verifyInstallToken(id, createInstallToken(id, 0), 901_000)).toBe(
    false,
  );
  expect(verifyInstallToken('another-id', token)).toBe(false);
  const { Readable } = await import('node:stream');
  storage.read.mockResolvedValue({
    Body: Readable.from(Buffer.from('ip')),
    ContentLength: 2,
    ContentRange: 'bytes 0-1/3',
  });
  const file = await request(app)
    .get(`/packages/${id}/file?accountHash=${hash}`)
    .set('X-Access-Token', accessPasswordHash)
    .set('Range', 'bytes=0-1');
  expect(file.status).toBe(206);
  expect(file.body.toString()).toBe('ip');
  expect(storage.read).toHaveBeenCalledWith(remote, 'bytes=0-1');
});
