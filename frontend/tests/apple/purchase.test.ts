import { beforeEach, expect, it, vi } from 'vitest';
import { purchaseApp } from '../../src/apple/purchase';
import { getDownloadInfo } from '../../src/apple/download';
import { appleRequest } from '../../src/apple/request';
import { buildPlist, parsePlist } from '../../src/apple/plist';
import i18n from '../../src/i18n';
import type { Account, Software } from '../../src/types';

vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));
vi.mock('../../src/apple/download', () => ({ getDownloadInfo: vi.fn() }));
const account = {
  store: '143465',
  cookies: [],
  deviceIdentifier: 'test',
  directoryServicesIdentifier: 'test',
  passwordToken: 'test',
} as unknown as Account;
const app = { id: 736536022, price: 0 } as Software;

beforeEach(() => {
  vi.resetAllMocks();
});

it.each(['STDQ', 'GAME'])(
  'verifies 5002 after %s using the latest response cookies',
  async (pricing) => {
    vi.mocked(appleRequest).mockImplementation(async (req) => {
      const mode = parsePlist(req.body!).pricingParameters;
      if (mode === 'GAME') expect(req.cookies?.[0].value).toBe('STDQ');
      return {
        status: 200,
        statusText: '',
        headers: {},
        rawHeaders: [
          [
            'set-cookie',
            `session=${mode}; Path=/; Domain=itunes.apple.com; Secure`,
          ],
        ],
        body: buildPlist({
          failureType: mode === 'STDQ' && pricing === 'GAME' ? '2059' : '5002',
        }),
      };
    });
    vi.mocked(getDownloadInfo).mockImplementation(async (verifiedAccount) => {
      expect(verifiedAccount.cookies[0].value).toBe(pricing);
      return {
        updatedCookies: verifiedAccount.cookies,
        output: {
          downloadURL: 'https://example.test/app.ipa',
          sinfs: [{ id: 0, sinf: 'test' }],
          bundleShortVersionString: '1',
          bundleVersion: '1',
        },
      };
    });
    const result = await purchaseApp(account, app);
    expect(result.updatedCookies[0].value).toBe(pricing);
  },
);

it.each([
  { action: { url: 'https://buy.itunes.apple.com/wa/termsPage' } },
  { action: { URL: 'https://buy.itunes.apple.com/wa/termsPage?source=app' }, failureType: '5002' },
])('reports terms actions with or without a failure code: %j', async (fields) => {
  vi.mocked(appleRequest).mockResolvedValue({
    status: 200,
    statusText: '',
    headers: {},
    rawHeaders: [],
    body: buildPlist({ jingleDocType: 'buyProductFailure', ...fields }),
  });
  const url = fields.action.url || fields.action.URL;
  await expect(purchaseApp(account, app)).rejects.toThrow(
    i18n.t('errors.purchase.termsRequired', { url }),
  );
  expect(getDownloadInfo).not.toHaveBeenCalled();
});

it('does not treat 5002 as success when entitlement cannot be verified', async () => {
  vi.mocked(appleRequest).mockResolvedValue({
    status: 200,
    statusText: '',
    headers: {},
    rawHeaders: [],
    body: buildPlist({
      failureType: '5002',
      customerMessage: 'An unknown error has occurred',
    }),
  });
  vi.mocked(getDownloadInfo).mockRejectedValue(new Error('No items'));
  await expect(purchaseApp(account, app)).rejects.toMatchObject({
    code: '5002',
  });
});
