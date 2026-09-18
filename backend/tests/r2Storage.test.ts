import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { R2Storage, readR2Config } from '../src/services/r2Storage.js';

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'asspp-r2-test-'));
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

const options = {
  accountId: 'a'.repeat(32),
  bucket: 'test',
  accessKeyId: 'test',
  secretAccessKey: 'test',
  maxStorageBytes: 32 * 1024 * 1024,
};
const id = '12345678-1234-1234-1234-123456789abc';

function fixture(
  overrides: {
    quota?: number;
    badHead?: boolean;
    badPart?: boolean;
    beforePart?: () => Promise<void>;
  } = {},
) {
  const bodies: Buffer[] = [];
  const send = vi.fn(async (command) => {
    const input = command.input;
    switch (command.constructor.name) {
      case 'ListObjectsV2Command':
        return {
          Contents: [{ Key: 'packages/other.ipa', Size: overrides.quota ?? 0 }],
        };
      case 'CreateMultipartUploadCommand':
        bodies.length = 0;
        return { UploadId: 'upload' };
      case 'UploadPartCommand': {
        await overrides.beforePart?.();
        const body = Buffer.from(input.Body);
        expect(input.ContentMD5).toBe(
          createHash('md5').update(body).digest('base64'),
        );
        bodies.push(body);
        return {
          ETag: overrides.badPart
            ? 'bad'
            : `"${createHash('md5').update(body).digest('hex')}"`,
        };
      }
      case 'HeadObjectCommand': {
        const etag = createHash('md5')
          .update(
            Buffer.concat(
              bodies.map((b) => createHash('md5').update(b).digest()),
            ),
          )
          .digest('hex');
        return {
          ContentLength: overrides.badHead ? 1 : Buffer.concat(bodies).length,
          ETag: `"${etag}-${bodies.length}"`,
        };
      }
      default:
        return {};
    }
  });
  const store = new R2Storage(options, { send } as unknown as S3Client);
  return { store, send, bodies };
}

it('uploads bounded multipart data with MD5 checks and verifies the completed object', async () => {
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 7, 42);
  const file = path.join(directory, 'app.ipa');
  await fs.writeFile(file, bytes);
  const { store, bodies } = fixture();
  const progress = vi.fn();
  const remote = await store.upload(file, id, progress);
  const reports = progress.mock.calls.map(([value]) => value);
  expect(reports[0]).toMatchObject({ phase: 'queued', uploadedBytes: 0 });
  expect(reports).toContainEqual(
    expect.objectContaining({
      phase: 'uploading',
      uploadedBytes: 8 * 1024 * 1024,
      totalBytes: bytes.length,
    }),
  );
  expect(reports.at(-1)).toMatchObject({
    phase: 'verifying',
    uploadedBytes: bytes.length,
    totalBytes: bytes.length,
  });
  expect(
    reports
      .filter((r) => r.phase === 'uploading')
      .every((r) => r.uploadedBytes < r.totalBytes),
  ).toBe(true);
  expect(reports.at(-1).bytesPerSecond).toBeGreaterThan(0);
  expect(bodies.map((b) => b.length)).toEqual([8 * 1024 * 1024, 7]);
  expect(Buffer.concat(bodies).equals(bytes)).toBe(true);
  expect(remote).toMatchObject({
    bucket: 'test',
    key: `packages/${id}.ipa`,
    size: bytes.length,
  });
  expect((await fs.readFile(file)).equals(bytes)).toBe(true); // Only the task manager may delete it after committing metadata.
});

it('keeps queued files distinct and reports no bytes until a part is acknowledged', async () => {
  const file = path.join(directory, 'app.ipa');
  await fs.writeFile(file, 'ipa');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { store, send } = fixture({ beforePart: () => gate });
  const firstProgress = vi.fn();
  const secondProgress = vi.fn();
  const first = store.upload(file, id, firstProgress);
  const second = store.upload(file, id.replace('abc', 'def'), secondProgress);
  try {
    await vi.waitFor(() =>
      expect(
        send.mock.calls.some(
          ([c]) => c.constructor.name === 'UploadPartCommand',
        ),
      ).toBe(true),
    );
    expect(firstProgress.mock.calls.at(-1)?.[0]).toMatchObject({
      phase: 'uploading',
      uploadedBytes: 0,
    });
    expect(secondProgress.mock.calls.map(([p]) => p.phase)).toEqual(['queued']);
  } finally {
    release();
    await Promise.all([first, second]);
  }
});

it('rejects a full prefix before uploading and leaves the local file intact', async () => {
  const file = path.join(directory, 'app.ipa');
  await fs.writeFile(file, 'ipa');
  const { store, send } = fixture({ quota: options.maxStorageBytes });
  await expect(store.upload(file, id)).rejects.toThrow('storage limit');
  expect(send.mock.calls.map(([c]) => c.constructor.name)).not.toContain(
    'CreateMultipartUploadCommand',
  );
  expect(await fs.readFile(file, 'utf8')).toBe('ipa');
});

it.each([{ badPart: true }, { badHead: true }])(
  'never accepts unverified upload data: %j',
  async (fault) => {
    const file = path.join(directory, 'app.ipa');
    await fs.writeFile(file, 'ipa');
    const { store, send } = fixture(fault);
    const progress = vi.fn();
    await expect(store.upload(file, id, progress)).rejects.toThrow(
      /checksum|verification/,
    );
    if ('badPart' in fault)
      expect(progress.mock.calls.every(([p]) => p.uploadedBytes === 0)).toBe(
        true,
      );
    expect(await fs.readFile(file, 'utf8')).toBe('ipa');
    if ('badPart' in fault)
      expect(send.mock.calls.map(([c]) => c.constructor.name)).toContain(
        'AbortMultipartUploadCommand',
      );
  },
);

it('does not generate links or delete objects from another bucket', async () => {
  const { store, send } = fixture();
  const remote = {
    bucket: 'other',
    key: `packages/${id}.ipa`,
    size: 3,
    etag: 'test',
  };
  await expect(store.downloadUrl(remote, 'app.ipa')).rejects.toThrow(
    'different bucket',
  );
  await expect(store.delete(remote)).rejects.toThrow('different bucket');
  expect(send).not.toHaveBeenCalled();
});

it('requires authentication, bounded configuration and explicit deletion for R2', () => {
  const env = {
    R2_BUCKET: 'test',
    R2_ACCOUNT_ID: 'a'.repeat(32),
    R2_ACCESS_KEY_ID: 'test',
    R2_SECRET_ACCESS_KEY: 'test',
    ACCESS_PASSWORD: 'test',
  };
  expect(readR2Config({})).toBeUndefined();
  expect(readR2Config(env)?.maxStorageBytes).toBe(3072 * 1024 * 1024);
  expect(() => readR2Config({ ...env, ACCESS_PASSWORD: '' })).toThrow(
    'ACCESS_PASSWORD',
  );
  expect(() => readR2Config({ ...env, R2_MAX_STORAGE_MB: '-1' })).toThrow(
    'positive integer',
  );
  expect(() => readR2Config({ ...env, AUTO_CLEANUP_DAYS: '7' })).toThrow(
    'automatic cleanup',
  );
  expect(() => readR2Config({ ...env, MAX_ACTIVE_DOWNLOADS: '0' })).toThrow(
    'positive integer',
  );
});
