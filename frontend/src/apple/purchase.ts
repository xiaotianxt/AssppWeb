import type { Account, Software } from "../types";
import { appleRequest } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import { purchaseAPIHost } from "./config";
import { getDownloadInfo } from "./download";
import i18n from "../i18n";

export class PurchaseError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "PurchaseError";
  }
}

export async function purchaseApp(
  account: Account,
  app: Software,
): Promise<{ updatedCookies: typeof account.cookies }> {
  if ((app.price ?? 0) > 0) {
    throw new PurchaseError(i18n.t("errors.purchase.paidNotSupported"));
  }

  let result = await purchaseWithParams(account, app, "STDQ");
  if (result.error?.code === "2059") {
    result = await purchaseWithParams(
      { ...account, cookies: result.updatedCookies },
      app,
      "GAME",
    );
  }
  if (!result.error) return { updatedCookies: result.updatedCookies };

  // 5002 is ambiguous: require a download URL and SINF before treating this
  // as an existing license. Keep rotated cookies out of the Error object.
  if (result.error.code === "5002") {
    try {
      const { updatedCookies } = await getDownloadInfo(
        { ...account, cookies: result.updatedCookies },
        app,
      );
      return { updatedCookies };
    } catch {
      // Keep the purchase failure when entitlement cannot be verified.
    }
  }
  throw result.error;
}

async function purchaseWithParams(
  account: Account,
  app: Software,
  pricingParameters: string,
): Promise<{ updatedCookies: typeof account.cookies; error?: PurchaseError }> {
  const deviceId = account.deviceIdentifier;
  const host = purchaseAPIHost(account.pod);
  const path = "/WebObjects/MZFinance.woa/wa/buyProduct";

  const payload: Record<string, any> = {
    appExtVrsId: "0",
    hasAskedToFulfillPreorder: "true",
    buyWithoutAuthorization: "true",
    hasDoneAgeCheck: "true",
    guid: deviceId,
    needDiv: "0",
    origPage: `Software-${app.id}`,
    origPageLocation: "Buy",
    price: "0",
    pricingParameters,
    productType: "C",
    salableAdamId: app.id,
  };

  const plistBody = buildPlist(payload);

  const headers: Record<string, string> = {
    "Content-Type": "application/x-apple-plist",
    "iCloud-DSID": account.directoryServicesIdentifier,
    "X-Dsid": account.directoryServicesIdentifier,
    "X-Apple-Store-Front": `${account.store}-1`,
    "X-Token": account.passwordToken,
  };

  const response = await appleRequest({
    method: "POST",
    host,
    path,
    headers,
    body: plistBody,
    cookies: account.cookies,
  });

  const updatedCookies = extractAndMergeCookies(
    response.rawHeaders,
    account.cookies,
  );

  const fail = (message: string, code?: string) => ({
    updatedCookies,
    error: new PurchaseError(message, code),
  });
  const dict = parsePlist(response.body) as Record<string, any>;

  if (dict.failureType) {
    const failureType = String(dict.failureType);
    const customerMessage = dict.customerMessage as string | undefined;
    switch (failureType) {
      case "2059":
        return fail(i18n.t("errors.purchase.unavailable"), "2059");
      case "2034":
      case "2042":
        return fail(i18n.t("errors.purchase.passwordExpired"), failureType);
      default: {
        if (customerMessage === "Your password has changed.") {
          return fail(i18n.t("errors.purchase.passwordExpired"), failureType);
        }
        if (customerMessage === "Subscription Required") {
          return fail(
            i18n.t("errors.purchase.subscriptionRequired"),
            failureType,
          );
        }
        // Check for terms page action
        const action = dict.action as Record<string, any> | undefined;
        if (action) {
          const actionUrl = (action.url || action.URL) as string | undefined;
          if (actionUrl && actionUrl.endsWith("termsPage")) {
            return fail(
              i18n.t("errors.purchase.termsRequired", { url: actionUrl }),
              failureType,
            );
          }
        }

        // Handle unknown error specific fallback mappings
        let msg = customerMessage;
        if (
          msg === "An unknown error has occurred" ||
          msg === "An unknown error has occurred."
        ) {
          msg = i18n.t("errors.purchase.unknownError");
        }

        return fail(
          `${msg ?? i18n.t("errors.purchase.failed", { failureType })} (${failureType})`,
          failureType,
        );
      }
    }
  }

  const jingleDocType = dict.jingleDocType as string | undefined;
  const status = dict.status as number | undefined;

  if (jingleDocType !== "purchaseSuccess" || status !== 0) {
    return fail(i18n.t("errors.purchase.failedGeneral"));
  }

  return { updatedCookies };
}
