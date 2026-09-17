import { Router, Request, Response } from "express";
import { config, verifyAccessToken } from "../config.js";
import {
  hasPackage,
  localPackagePath,
  packageFilename,
} from "../services/packageFiles.js";
import { r2Storage } from "../services/r2Storage.js";
import {
  createInstallToken,
  verifyInstallToken,
} from "../services/installToken.js";
import { getAllTasks } from "../services/downloadManager.js";
import { buildManifest, getWhitePng } from "../services/manifestBuilder.js";
import { asyncRoute, getIdParam } from "../utils/route.js";

const router = Router();

export function getBaseUrl(req: Request): string {
  const configured = normalizeBaseUrl(config.publicBaseUrl);
  if (configured) return configured;

  // Trust x-forwarded-proto for protocol (safe — only affects URL scheme)
  // but use host header directly (not x-forwarded-host) to prevent open redirects
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = forwardedProto === "https" || req.secure ? "https" : "http";
  const host = req.headers["host"] || "localhost";

  // Validate host header to prevent injection
  const sanitizedHost = host.replace(/[^\w.\-:]/g, "");

  // Support X-Forwarded-Port for reverse proxies that strip port from Host header.
  // Common when deploying HTTPS on non-443 ports (e.g., nginx with $host instead of $http_host).
  // Without this, manifest plist URLs default to port 443 and iOS cannot fetch the payload.
  if (!sanitizedHost.includes(":")) {
    const forwardedPort = req.headers["x-forwarded-port"];
    if (typeof forwardedPort === "string") {
      const port = forwardedPort.replace(/\D/g, "");
      const isDefault =
        (proto === "https" && port === "443") ||
        (proto === "http" && port === "80");
      if (port && !isDefault) {
        return `${proto}://${sanitizedHost}:${port}`;
      }
    }
  }

  return `${proto}://${sanitizedHost}`;
}

function normalizeBaseUrl(value?: string): string {
  if (!value) return "";
  return value.trim().replace(/\/+$/, "");
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.replace(/^\/+/, "");
  return `${base}/${suffix}`;
}

// Manifest plist for iTMS installation
router.get(
  "/install/:id/manifest.plist",
  asyncRoute(async (req: Request, res: Response) => {
    const id = getIdParam(req);
    const task = getAllTasks().find(
      (t) => t.id === id && t.status === "completed",
    );

    if (!task || !hasPackage(task)) {
      res.status(404).json({ error: "Package not found" });
      return;
    }
    if (task.remote && !verifyInstallToken(id, req.query.token)) {
      res.status(403).json({ error: "Install link expired or invalid" });
      return;
    }

    const baseUrl = getBaseUrl(req);
    let payloadUrl = joinUrl(baseUrl, `/api/install/${id}/payload.ipa`);
    if (task.remote) {
      if (!r2Storage) throw new Error("R2 is not configured");
      payloadUrl = await r2Storage.downloadUrl(
        task.remote,
        packageFilename(task),
      );
      res.setHeader("Cache-Control", "private, no-store");
    }
    const smallIconUrl = joinUrl(baseUrl, `/api/install/${id}/icon-small.png`);
    const largeIconUrl = joinUrl(baseUrl, `/api/install/${id}/icon-large.png`);

    const manifest = buildManifest(
      task.software,
      payloadUrl,
      smallIconUrl,
      largeIconUrl,
    );

    res.setHeader("Content-Type", "application/xml");
    res.send(manifest);
  }),
);

router.get("/install/:id/url", (req: Request, res: Response) => {
  const id = getIdParam(req);
  const task = getAllTasks().find(
    (t) => t.id === id && t.status === "completed",
  );

  if (!task || !hasPackage(task)) {
    res.status(404).json({ error: "Package not found" });
    return;
  }
  if (task.remote) {
    const accessToken = req.headers["x-access-token"];
    if (
      typeof accessToken !== "string" ||
      !verifyAccessToken(accessToken) ||
      req.query.accountHash !== task.accountHash
    ) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  const baseUrl = getBaseUrl(req);
  let manifestUrl = joinUrl(baseUrl, `/api/install/${id}/manifest.plist`);
  if (task.remote) {
    manifestUrl += `?token=${createInstallToken(id)}`;
    res.setHeader("Cache-Control", "private, no-store");
  }
  const installUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(
    manifestUrl,
  )}`;

  res.json({ installUrl, manifestUrl });
});

// Stream IPA payload for installation
router.get(
  "/install/:id/payload.ipa",
  asyncRoute(async (req: Request, res: Response, next) => {
    const id = getIdParam(req);
    const task = getAllTasks().find(
      (t) => t.id === id && t.status === "completed",
    );

    if (!task || !hasPackage(task)) {
      res.status(404).json({ error: "Package not found" });
      return;
    }
    if (task.remote) {
      if (!verifyInstallToken(id, req.query.token)) {
        res.status(403).json({ error: "Install link expired or invalid" });
        return;
      }
      if (!r2Storage) throw new Error("R2 is not configured");
      res.setHeader("Cache-Control", "private, no-store");
      res.redirect(
        302,
        await r2Storage.downloadUrl(task.remote, packageFilename(task)),
      );
      return;
    }
    res.download(localPackagePath(task)!, packageFilename(task), (error) => {
      if (error) next(error);
    });
  }),
);

// Small icon placeholder (57x57)
router.get("/install/:id/icon-small.png", (_req: Request, res: Response) => {
  const png = getWhitePng();
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Content-Length", png.length);
  res.send(png);
});

// Large icon placeholder (512x512)
router.get("/install/:id/icon-large.png", (_req: Request, res: Response) => {
  const png = getWhitePng();
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Content-Length", png.length);
  res.send(png);
});

export default router;
