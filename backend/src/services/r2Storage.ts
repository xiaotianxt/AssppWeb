import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { RemotePackage, UploadProgress } from '../types/index.js';

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  maxStorageBytes: number;
}

export function readR2Config(env = process.env): R2Config | undefined {
  if (!env.R2_BUCKET) return undefined;
  if (
    !/^[a-f0-9]{32}$/i.test(env.R2_ACCOUNT_ID || '') ||
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_SECRET_ACCESS_KEY
  ) {
    throw new Error(
      'R2 requires an account ID, access key ID and secret access key',
    );
  }
  if (!env.ACCESS_PASSWORD) throw new Error('R2 requires ACCESS_PASSWORD');
  if (
    Number(env.AUTO_CLEANUP_DAYS || 0) !== 0 ||
    Number(env.AUTO_CLEANUP_MAX_MB || 0) !== 0
  ) {
    throw new Error(
      'Disable automatic cleanup before enabling R2; remote packages are deleted explicitly',
    );
  }
  const maxMB = Number(env.R2_MAX_STORAGE_MB || '3072');
  if (!Number.isSafeInteger(maxMB) || maxMB <= 0) {
    throw new Error('R2_MAX_STORAGE_MB must be a positive integer');
  }
  for (const key of ['MAX_DOWNLOAD_MB', 'MAX_ACTIVE_DOWNLOADS']) {
    if (
      env[key] !== undefined &&
      (!Number.isSafeInteger(Number(env[key])) || Number(env[key]) <= 0)
    ) {
      throw new Error(`${key} must be a positive integer when R2 is enabled`);
    }
  }
  return {
    accountId: env.R2_ACCOUNT_ID!,
    bucket: env.R2_BUCKET,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    maxStorageBytes: maxMB * 1024 * 1024,
  };
}

export class R2StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'R2StorageError';
  }
}

const PART_SIZE = 8 * 1024 * 1024;
const PREFIX = 'packages/';
export const DOWNLOAD_LINK_SECONDS = 15 * 60;

/** One instance owns one bucket/prefix. Uploads are serialized for quota checks. */
export class R2Storage {
  private readonly client: S3Client;
  private uploadQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: R2Config,
    client?: S3Client,
  ) {
    this.client =
      client ??
      new S3Client({
        region: 'auto',
        endpoint: `https://${options.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey,
        },
        maxAttempts: 3,
        requestHandler: { connectionTimeout: 10_000, requestTimeout: 120_000 },
      });
  }

  target(taskId: string): Pick<RemotePackage, 'bucket' | 'key'> {
    if (!/^[a-f0-9-]+$/.test(taskId)) throw new Error('Invalid package ID');
    return { bucket: this.options.bucket, key: `${PREFIX}${taskId}.ipa` };
  }

  private objectParams(object: Pick<RemotePackage, 'bucket' | 'key'>) {
    if (
      object.bucket !== this.options.bucket ||
      !/^packages\/[a-f0-9-]+\.ipa$/.test(object.key)
    ) {
      throw new Error(
        'R2 package belongs to a different bucket or invalid key',
      );
    }
    return { Bucket: object.bucket, Key: object.key };
  }

  async downloadUrl(object: RemotePackage, filename: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        ...this.objectParams(object),
        ResponseContentType: 'application/octet-stream',
        ResponseContentDisposition: `attachment; filename="${filename}"`,
      }),
      { expiresIn: DOWNLOAD_LINK_SECONDS },
    );
  }

  async read(object: RemotePackage, range?: string) {
    return this.client.send(
      new GetObjectCommand({ ...this.objectParams(object), Range: range }),
    );
  }

  async delete(object: Pick<RemotePackage, 'bucket' | 'key'>): Promise<void> {
    await this.client.send(new DeleteObjectCommand(this.objectParams(object)));
  }

  upload(
    filePath: string,
    taskId: string,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<RemotePackage> {
    onProgress?.({
      phase: 'queued',
      uploadedBytes: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
    });
    const result = this.uploadQueue.then(() =>
      this.uploadFile(filePath, taskId, onProgress),
    );
    this.uploadQueue = result.catch(() => undefined);
    return result;
  }

  private async uploadFile(
    filePath: string,
    taskId: string,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<RemotePackage> {
    const { Bucket, Key } = this.objectParams(this.target(taskId));
    const size = (await stat(filePath)).size;
    if (size <= 0) throw new Error('Cannot upload an empty package');
    onProgress?.({
      phase: 'uploading',
      uploadedBytes: 0,
      totalBytes: size,
      bytesPerSecond: 0,
    });

    // Count stored objects, not only the current process's task records. A retry
    // replaces the same key, and must not count that object's size twice.
    let used = 0;
    let ContinuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket, Prefix: PREFIX, ContinuationToken }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key !== Key) used += object.Size ?? 0;
      }
      if (page.IsTruncated && !page.NextContinuationToken)
        throw new Error('Incomplete R2 usage listing');
      ContinuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (ContinuationToken);
    if (used + size > this.options.maxStorageBytes) {
      throw new R2StorageError(
        'R2 storage limit reached; compiled IPA remains on local disk',
      );
    }

    const created = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket,
        Key,
        ContentType: 'application/octet-stream',
      }),
    );
    const UploadId = created.UploadId;
    if (!UploadId) throw new Error('R2 did not return an upload ID');
    let completed = false;
    try {
      const file = await open(filePath, 'r');
      const parts: { PartNumber: number; ETag: string }[] = [];
      const composite = createHash('md5');
      const started = performance.now();
      try {
        for (let offset = 0; offset < size; offset += PART_SIZE) {
          const body = Buffer.allocUnsafe(Math.min(PART_SIZE, size - offset));
          let read = 0;
          while (read < body.length) {
            const result = await file.read(
              body,
              read,
              body.length - read,
              offset + read,
            );
            if (!result.bytesRead)
              throw new Error('Package changed during upload');
            read += result.bytesRead;
          }
          const digest = createHash('md5').update(body).digest();
          composite.update(digest);
          const PartNumber = parts.length + 1;
          const part = await this.client.send(
            new UploadPartCommand({
              Bucket,
              Key,
              UploadId,
              PartNumber,
              Body: body,
              ContentLength: body.length,
              ContentMD5: digest.toString('base64'),
            }),
          );
          if (part.ETag?.replaceAll('"', '') !== digest.toString('hex')) {
            throw new R2StorageError(
              'R2 part checksum mismatch; local IPA retained',
            );
          }
          parts.push({ PartNumber, ETag: part.ETag });
          // Count a part only after R2 acknowledges it AND its checksum matches.
          // Retries and time spent waiting in the upload queue never add bytes.
          const uploadedBytes = offset + body.length;
          onProgress?.({
            phase: uploadedBytes === size ? 'verifying' : 'uploading',
            uploadedBytes,
            totalBytes: size,
            bytesPerSecond:
              uploadedBytes /
              Math.max((performance.now() - started) / 1000, 0.001),
          });
        }
      } finally {
        await file.close();
      }
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket,
          Key,
          UploadId,
          MultipartUpload: { Parts: parts },
        }),
      );
      completed = true;
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket, Key }),
      );
      const etag = `${composite.digest('hex')}-${parts.length}`;
      if (
        head.ContentLength !== size ||
        head.ETag?.replaceAll('"', '') !== etag
      ) {
        throw new R2StorageError(
          'R2 object verification failed; compiled IPA remains on local disk',
        );
      }
      return { bucket: Bucket, key: Key, size, etag };
    } finally {
      if (!completed) {
        // Do not hide incomplete multipart storage. R2's lifecycle rule also
        // aborts abandoned uploads after a process crash (default: seven days).
        try {
          await this.client.send(
            new AbortMultipartUploadCommand({ Bucket, Key, UploadId }),
          );
        } catch {
          console.error(
            'R2 multipart cleanup failed; check incomplete uploads in the bucket',
          );
        }
      }
    }
  }
}

const options = readR2Config();
export const r2Storage = options ? new R2Storage(options) : undefined;
