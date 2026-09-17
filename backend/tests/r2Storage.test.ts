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
  overrides: { quota?: number; badHead?: boolean; badPart?: boolean } = {},
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
        return { UploadId: 'upload' };
      case 'UploadPartCommand': {
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
  const remote = await store.upload(file, id);
  expect(bodies.map((b) => b.length)).toEqual([8 * 1024 * 1024, 7]);
  expect(Buffer.concat(bodies).equals(bytes)).toBe(true);
  expect(remote).toMatchObject({
    bucket: 'test',
    key: `packages/${id}.ipa`,
    size: bytes.length,
  });
  expect((await fs.readFile(file)).equals(bytes)).toBe(true); // Only the task manager may delete it after committing metadata.
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
    await expect(store.upload(file, id)).rejects.toThrow(
      /checksum|verification/,
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
