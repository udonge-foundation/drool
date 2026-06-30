export type CodingSubscriptionProvider =
  | 'codex'
  | 'claude'
  | 'xai'
  | 'kimi'
  | 'antigravity';

export type CodingSubscriptionLoginMethod = 'browser' | 'device';

export interface CodingSubscriptionAuthRecord {
  type: CodingSubscriptionProvider;
  access_token?: string;
  refresh_token?: string;
  expires_at?: string;
  id_token?: string;
  token_type?: string;
  scope?: string;
  email?: string;
  sub?: string;
  account_id?: string;
  base_url?: string;
  redirect_uri?: string;
  token_endpoint?: string;
  auth_kind?: string;
  device_id?: string;
}

export type CodingSubscriptionLoginStatus =
  | { type: 'browser'; authUrl: string }
  | {
      type: 'pending';
      userCode: string;
      verificationUri: string;
      verificationUriComplete: string;
    }
  | { type: 'polling' }
  | { type: 'slow_down'; newInterval: number };

export interface CodingSubscriptionGateData {
  version: 1;
  codingSubscriptionsAllowed: boolean;
}
