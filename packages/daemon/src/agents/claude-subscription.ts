import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Account } from '@puddle/shared';

/**
 * Subscription rate-limit usage — the "5-hour / weekly" windows Claude Code's
 * interactive `/usage` shows. This is the ONE place puddle reads an account's
 * OAuth token, and only when the account has opted in (SPEC §2 carve-out):
 * the token never leaves this function, is never logged, and is used solely
 * as the bearer for the usage request.
 *
 * UNVERIFIED: the endpoint below is undocumented and was NOT confirmed against
 * a live response (the maintainer's host is macOS, where the token lives in
 * the Keychain and no `.credentials.json` exists, so it could not be reached
 * for testing). Everything here fails safe — any missing token, unreadable
 * file, network error, or unexpected shape yields `null`, and the UI shows
 * "unavailable" rather than wrong numbers. Confirm the endpoint and response
 * shape on a host with a file-based token before trusting the figures.
 */
const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

export interface SubscriptionWindow {
  key: string;
  label: string;
  used_percentage: number;
  resets_at: string | null;
}

/** Reads the OAuth access token from the documented file location, or null. */
function readAccessToken(configDir: string): string | null {
  // Documented location (Linux/Windows): <config_dir>/.credentials.json.
  // macOS keeps it in the Keychain instead — deliberately NOT read here.
  const file = join(configDir, '.credentials.json');
  if (!existsSync(file)) return null;
  try {
    const creds = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    // Field name is undocumented; probe the plausible shapes defensively.
    const oauth = (creds['claudeAiOauth'] ?? creds['claude_ai_oauth'] ?? creds) as Record<
      string,
      unknown
    >;
    const token = oauth['accessToken'] ?? oauth['access_token'];
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** Maps a loosely-typed usage response into our window list, or null. */
function parseWindows(body: unknown): SubscriptionWindow[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const windows: SubscriptionWindow[] = [];
  const take = (raw: unknown, key: string, label: string): void => {
    if (typeof raw !== 'object' || raw === null) return;
    const w = raw as Record<string, unknown>;
    const pct = w['used_percentage'] ?? w['utilization'] ?? w['percent_used'];
    if (typeof pct !== 'number') return;
    const reset = w['resets_at'] ?? w['reset_at'] ?? w['resets_at_iso'];
    windows.push({
      key,
      label,
      used_percentage: pct,
      resets_at:
        typeof reset === 'string'
          ? reset
          : typeof reset === 'number'
            ? new Date(reset * 1000).toISOString()
            : null,
    });
  };
  take(record['five_hour'] ?? record['fiveHour'], 'five_hour', '5-hour');
  take(record['seven_day'] ?? record['sevenDay'] ?? record['weekly'], 'seven_day', 'weekly');
  take(record['seven_day_opus'] ?? record['weekly_opus'], 'seven_day_opus', 'weekly (Opus)');
  return windows.length > 0 ? windows : null;
}

export async function fetchSubscriptionUsage(
  account: Account,
): Promise<SubscriptionWindow[] | null> {
  const token = readAccessToken(account.config_dir);
  if (token === null) return null; // keychain-only host, or logged out → unavailable
  try {
    const res = await fetch(USAGE_ENDPOINT, {
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return parseWindows(await res.json());
  } catch {
    return null; // network/timeout/parse → unavailable, never a wrong figure
  }
}
