export interface Software {
  id: number;
  bundleID: string;
  name: string;
  version: string;
  price?: number;
  artistName: string;
  sellerName: string;
  description: string;
  averageUserRating: number;
  userRatingCount: number;
  artworkUrl: string;
  screenshotUrls: string[];
  minimumOsVersion: string;
  fileSizeBytes?: string;
  releaseDate: string;
  releaseNotes?: string;
  formattedPrice?: string;
  primaryGenreName: string;
}

export interface Sinf {
  id: number;
  sinf: string; // base64 encoded
}

export interface RemotePackage {
  bucket: string;
  key: string;
  size: number;
  etag: string;
}

export interface UploadProgress {
  phase: 'queued' | 'uploading' | 'verifying';
  uploadedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
}

export interface DownloadTask {
  id: string;
  software: Software;
  accountHash: string;
  downloadURL: string;
  sinfs: Sinf[];
  iTunesMetadata?: string;
  status:
    | "pending"
    | "downloading"
    | "paused"
    | "injecting"
    | "uploading"
    | "completed"
    | "failed";
  progress: number;
  speed: string;
  uploadProgress?: UploadProgress;
  error?: string;
  filePath?: string;
  /** Set only after signing finished. Allows upload-only recovery after restart. */
  compiled?: boolean;
  remote?: RemotePackage;
  /** Recorded before uploading so even an unverified remote object can be deleted. */
  uploadTarget?: Pick<RemotePackage, 'bucket' | 'key'>;
  createdAt: string;
}

export interface PackageInfo {
  id: string;
  software: Software;
  accountHash: string;
  filePath: string;
  fileSize: number;
  createdAt: string;
}
