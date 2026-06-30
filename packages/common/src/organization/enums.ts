// These should come straight from WorkOs roles
export enum WorkosMembershipRole {
  User = 'user',
  Manager = 'manager',
  Owner = 'owner',
}

export enum ExhaustiveSubscriptionStatus {
  ACTIVE = 'active',
  TRIAL = 'trial',
  ENDED = 'ended',
  OVERDUE = 'overdue',
}

export enum IndustryTier {
  TEAM = 'team', // NOTE: continue calling it "team" in the code but "pro" for display
  TEAM_ANNUAL = 'team_annual',
  PRO_PLUS = 'pro_plus',
  MAX = 'max',
  ULTRA = 'ultra',
  PAYG_ENTERPRISE = 'payg',
  ENTERPRISE = 'enterprise',
}

/**
 * Method by which the user signed up / was provisioned.
 */
export enum SignupMethod {
  SelfServe = 'self_serve',
  Invite = 'invite',
  DirectorySync = 'directory_sync',
  Unknown = 'unknown',
}

// Maps to WorkOS GeneratePortalLinkIntent (subset we expose to users)
export enum SsoPortalIntent {
  SSO = 'sso',
  DomainVerification = 'domain_verification',
  DSync = 'dsync',
}

/**
 * Reason why a subscription's end-of-term cancellation was scheduled.
 *
 * Priority: User > all system reasons. The system (overdue, dispute) must
 * never overwrite a user-initiated cancellation, because clearing the
 * underlying system condition should not undo a deliberate user action.
 * See `setScheduledCancellationReasonWithPriority` for the enforcement of
 * this invariant.
 */
export enum ScheduledCancellationReason {
  /** The customer explicitly requested cancellation via the UI. */
  User = 'user',
  /** The system scheduled cancellation due to unpaid invoices. */
  AccountOverdue = 'accountOverdue',
  /**
   * The system scheduled cancellation because the org's active payment
   * method was disputed. Cleared when the dispute flag is cleared (via
   * the self-service set-default flow or the admin unflag endpoint).
   */
  PaymentMethodDisputed = 'paymentMethodDisputed',
  /** The system scheduled cancellation because the org was deactivated. */
  OrgDeactivated = 'orgDeactivated',
}

/**
 * User preference for what to do when standard tokens are exhausted.
 * - 'extraUsage': Use pre-paid extra usage credits (requires credits balance > 0)
 * - 'droolCore': Fall back to free Drool Core model
 */
export enum OveragePreferenceValue {
  ExtraUsage = 'extraUsage',
  DroolCore = 'droolCore',
}

/**
 * Machine-readable reasons stored on `FirestoreOrganization.flaggedReason`.
 * Keep these in sync with any UI / error surfaces that branch on the flag
 * reason, and with the self-service auto-unflag path in the billing
 * `payment-method/set-default` route.
 */
export enum OrganizationFlagReason {
  /**
   * A Stripe dispute was opened against the org's active payment method.
   * This reason is auto-cleared when a new verified, non-disputed payment
   * method is set as default by the org owner.
   */
  ActivePaymentMethodDisputed = 'active-payment-method-disputed',
}

export enum CertificationTierEnum {
  Essentials = 'essentials',
  Advanced = 'advanced',
  Masters = 'masters',
}
