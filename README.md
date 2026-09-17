# AssppWeb

A web-based tool for acquiring and installing iOS apps outside the App Store. Authenticate with your Apple ID, search for apps, acquire licenses, and install IPAs directly to your device.

![preview](./resources/preview.png)

## Zero-Trust Architecture

AssppWeb uses a zero-trust design where the server **never sees your Apple credentials**. All Apple API communication happens directly in your browser via WebAssembly (libcurl.js with Mbed TLS 1.3). The server only acts as a blind TCP relay (Wisp protocol) and handles IPA compilation from public CDN downloads.

> **⚠️ Important Security Notice:** There are no official Asspp Web instances. Use any public instance at your own risk. While the backend cannot read your encrypted traffic, a malicious host could serve a modified frontend to capture your credentials before encryption. Therefore, **do not blindly trust public instances**. We strongly recommend self-hosting your own instance or using one provided by a trusted partner. Always verify the SSL certificate and ensure you are connecting to a secure, authentic endpoint.

**恳请所有转发项目的博主对自己的受众进行网络安全技术科普。要有哪个不拎清的大头儿子搞出事情来都够我们喝一壶的。**

## Quick Start

### Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Lakr233/AssppWeb&apiTokenTmpl=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22write%22%7D%2C%7B%22key%22%3A%22containers%22%2C%22type%22%3A%22write%22%7D%2C%7B%22key%22%3A%22cloudchamber%22%2C%22type%22%3A%22write%22%7D%5D&apiTokenName=AssppWeb%20Deploy)

This uses Cloudflare Workers + Containers with the published image `ghcr.io/lakr233/assppweb:latest`.

Requirements:

- Cloudflare Workers **Paid** plan (Containers are not available on Free).
- Deploy/build token with:
  - `Workers Scripts Edit`
  - `Containers Edit`
  - `Cloudchamber Edit`

If your build log fails at `Deploy a container application` with `Unauthorized`, your build token is missing required Containers/Cloudchamber permissions.

### Deploy to Railway

<details>
<summary>Click to show Railway deployment instructions</summary>

1. Go to [railway.com/new/image](https://railway.com/new/image) → enter `ghcr.io/lakr233/assppweb:latest`
2. In service **Settings**, set **Healthcheck Path** to `/api/settings` and deploy
3. Right-click the service → **Attach volume** → mount path: `/data`
4. In **Variables**, set `DATA_DIR` = `/data` and deploy
5. In **Settings** → **Networking**, generate a public domain or add a custom domain

**Notes**

- The free trial works but has limitations (volume expiry, network restrictions). **Hobby** plan ($5/month) or above is recommended for reliable use.
- Enable [**Serverless**](https://docs.railway.com/deployments/serverless) in service settings to scale down to zero during idle periods
- Railway [auto-updates](https://docs.railway.com/deployments/image-auto-updates) `:latest` images from GHCR — new releases will be deployed automatically within a few hours

> **⚠️ Custom domain with Cloudflare:** Railway's Cloudflare integration creates DNS records with Proxy enabled (orange cloud) by default. After authorizing, go to Cloudflare DNS settings and switch the CNAME record to **DNS only** (gray cloud) — Railway handles TLS automatically. If you keep Cloudflare Proxy on, you must set SSL/TLS mode to **Full** (not Flexible or Full Strict), otherwise you'll get an infinite redirect loop. See [Railway docs](https://docs.railway.com/networking/troubleshooting/ssl#err_too_many_redirects).

</details>

### Self-Host with Docker Compose

<details>
<summary>Click to show manual Docker Compose setup instructions</summary>

**Setup Docker Compose**

```bash
curl -O https://raw.githubusercontent.com/Lakr233/AssppWeb/main/compose.yml
docker compose up -d
```

**Environment Variables**

| Variable                                    | Default         | Description                                                                                 |
| ------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------- |
| `PORT`                                      | `8080`          | Server listen port                                                                          |
| `DATA_DIR`                                  | `./data`        | Directory for storing compiled IPAs                                                         |
| `PUBLIC_BASE_URL`                           | _(auto-detect)_ | Public URL for generating install manifests (e.g. `https://asspp.example.com`)              |
| `UNSAFE_DANGEROUSLY_DISABLE_HTTPS_REDIRECT` | `false`         | Disable HTTPS redirect (see warning below)                                                  |
| `AUTO_CLEANUP_DAYS`                         | `0`             | Automatically delete cached IPA files older than specified days (0 to disable)              |
| `AUTO_CLEANUP_MAX_MB`                       | `0`             | Automatically delete oldest cached IPA files when size exceeds this MB limit (0 to disable) |
| `MAX_DOWNLOAD_MB`                           | `0`             | Reject downloads exceeding this size in MB to prevent out-of-memory errors (0 to disable)   |
| `DOWNLOAD_THREADS`                          | `8`             | Number of parallel threads for IPA downloads (1–32)                                         |
| `ACCESS_PASSWORD`                           | _(none)_        | Require a password to access the web UI and API (empty to disable)                          |

**Reverse Proxy (Required for Install Apps on iOS)**

iOS requires HTTPS for `itms-services://` install links. You must put AssppWeb behind a reverse proxy with a valid TLS certificate.

> **⚠️ Redirect loop (`ERR_TOO_MANY_REDIRECTS`)?** Some reverse proxies (e.g. NAS built-in proxies) always send `X-Forwarded-Proto: http` even when the client connected via HTTPS, causing an infinite redirect loop. If you cannot configure your proxy to send the correct header, set `UNSAFE_DANGEROUSLY_DISABLE_HTTPS_REDIRECT=true` as a last resort. **This disables the HTTP→HTTPS redirect — you must ensure your proxy enforces HTTPS externally.**

The following is an example Caddyfile configuration:

```
asspp.example.com { reverse_proxy 127.0.0.1:8080 }
```

**⚠️ Make Sure WebSocket Works**

AssppWeb relies on the Wisp protocol over WebSocket (`/wisp/`) for its zero-trust architecture. Ensure your reverse proxy or CDN (e.g., Nginx, Cloudflare) is configured to allow WebSocket connections, otherwise the app will fail to communicate with Apple servers.

</details>

## Optional Cloudflare R2 storage

R2 stores **finished, signed IPAs**, not the working directory. Downloads and ZIP/SINF
injection still use local disk. Local storage remains the default.

Create a **private Standard-class bucket**, leave public access disabled, and issue
an **Object Read & Write** S3 credential scoped to that bucket. Set these variables
on the backend (use a private environment file or secret manager, never commit keys):

| Variable | Default | Meaning |
| --- | --- | --- |
| `R2_BUCKET` | unset | Enables R2; use a dedicated bucket |
| `R2_ACCOUNT_ID` | required with R2 | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | required with R2 | Bucket-scoped S3 access key |
| `R2_SECRET_ACCESS_KEY` | required with R2 | Bucket-scoped S3 secret |
| `R2_MAX_STORAGE_MB` | `3072` | Refuse uploads exceeding this stored-object quota; never evict packages |
| `MAX_DOWNLOAD_MB` | `2048` with R2, otherwise `0` | Maximum source download size |
| `MAX_ACTIVE_DOWNLOADS` | `1` with R2, otherwise `0` | Concurrent download/compile jobs; `0` disables the limit only in local mode |
| `ACCESS_PASSWORD` | required with R2 | Protects the API that issues download/install links |

Keep `AUTO_CLEANUP_DAYS=0` and `AUTO_CLEANUP_MAX_MB=0` when enabling R2. Startup
rejects automatic eviction with remote storage. Configure `PUBLIC_BASE_URL` to the
public HTTPS origin for iOS installation. The example Compose file passes the R2
environment variables through, but the published upstream image does not contain
this feature until released: build this source before using it.

- New downloads upload after signing. Each multipart chunk is checked by MD5, then
  the completed object's size and multipart ETag are checked. Only after the remote
  location is atomically persisted may the local IPA be removed.
- Failed/interrupted uploads retain the signed local IPA. **Retry upload** resumes
  only the transfer; it does not fetch Apple again or repeat signing. A crash before
  the remote record commits can leave an object at the same key; retry overwrites it.
- Existing local packages stay local until you click **Move to R2**. There is no
  automatic bulk migration. Back up `tasks.json` before migrating; it maps objects
  to accounts/apps. Do not change buckets or share the prefix between server instances.
- The browser fetches a short-lived link from the authenticated API and downloads
  directly from R2, without forwarding the site's access token or buffering an IPA
  in JavaScript. No public bucket domain or CORS policy is needed for this navigation.
- R2 install/share links expire after **15 minutes**. Old permanent local install
  links stop working for migrated packages; generate a new link in the UI. iOS
  installation via R2 still needs device verification before production rollout.
- The legacy `/api/packages/:id/file` route streams through the backend (including
  Range requests) for clients using access headers. The UI uses `/link` for direct
  delivery. Delete removes the R2 object before removing the task record, so failed
  deletions can be retried. In-progress signing/uploading cannot be deleted.

The quota covers committed objects under this bucket's `packages/` prefix, **not
all Cloudflare account usage or a hard billing cap**. Uploads are serialized per
process to make its quota check consistent. Use one instance per bucket/prefix.
R2's incomplete multipart lifecycle (seven days by default) handles uploads abandoned
by a process crash; consider shortening that lifecycle in the bucket settings. It
must not delete completed objects behind the task manager's back.

Keep roughly twice the largest concurrent IPA workload free locally for merging
and ZIP updates. Full IPA files without a task record are retained for manual
recovery rather than silently deleted; abandoned `.part` chunks are cleaned up.
Back up `tasks.json` alongside the bucket. Disabling R2 leaves remote task records
intact but makes their download/delete operations unavailable until reconfigured.

## Security Recommendations

**DDoS Protection**

IPA files can be hundreds of megabytes. If your instance is publicly accessible, put it behind a CDN like Cloudflare to absorb bandwidth and prevent abuse.

## License

MIT License. See [LICENSE](LICENSE) for details.

## 🥰 Acknowledgments

For projects that was stolen and used heavily:

- [ipatool](https://github.com/majd/ipatool)
- [Asspp](https://github.com/Lakr233/Asspp)

For friends who helped with testing and feedback:

- [@lbr77](https://github.com/lbr77)
- [@akinazuki](https://github.com/akinazuki)

<img src="./Artworks/fable5.jpg" alt="Fable 5 Verified" width="240">
