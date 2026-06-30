/**
 * Shared secret detection patterns and helpers.
 *
 * IMPORTANT: Patterns are stored as strings and converted to RegExp at runtime
 * to prevent the patterns from matching themselves when this file is scanned.
 * String concatenation is intentionally used to break up recognizable patterns
 * so they don't trigger false positives when scanning this file.
 */

// String concatenation in this file is intentional: it prevents the literal
// pattern source from matching itself when this file is scanned. Helpers must
// preserve that property — see file header for context.

// eslint-disable-next-line industry/constants-file-organization -- PLT-76: migrated from file-level disable
function privateKeyPattern(label: string): string {
  const prefix = label ? `${label} ` : '';
  return `-{5}BEGIN ${prefix}PRIVATE KEY-{5}(?:$|[^-]{63,}-{5}END)`;
}

// Store patterns as strings to avoid self-matching when scanning this file
const SECRET_PATTERNS: string[] = [
  // Industry API keys - using concatenation to prevent self-matching
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'fk-' + '[A-Za-z0-9_-]{20,}',
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  '\\bfk-' + '[A-Za-z0-9_-]{20,}\\b',

  // INDUSTRY_API_KEY environment variable assignments
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'INDUSTRY_API_KEY\\s*[=:]\\s*["\'`]?(fk-' + '[A-Za-z0-9_-]{20,})["\'`]?',
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  '\\bINDUSTRY_API_KEY\\b\\s*[=:]\\s*["\'`]?(fk-' + '[A-Za-z0-9_-]{20,})["\'`]?',

  // URL with embedded credentials - scrub entire credential portion
  // Excludes query param chars (?=#) to avoid false positives on URLs like fonts.googleapis.com/css2?family=Inter:ital@0
  '[A-Za-z]+:\\/\\/[^\\s:/@?#]{3,50}:[^\\s:/@?#]{3,50}@[^\\s/?#]+',

  // JWT/JWE tokens - split to prevent self-matching
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  '\\b' + 'eyJ' + '[\\dA-Za-z=_-]+(?:\\.[\\dA-Za-z=_-]{3,}){1,4}',

  // GitHub tokens - split pattern to avoid self-detection
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  '(?:gh[oprsu]|github_' + 'pat)_[\\dA-Za-z_]{36}',

  // GitLab tokens
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'glpat-' + '[\\dA-Za-z_=-]{20,22}',

  // Stripe API keys
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  '[rs]k_' + 'live_[\\dA-Za-z]{24,247}',

  // Square OAuth credentials
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'sq0i[a-z]{2}-' + '[\\dA-Za-z_-]{22,43}',
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'sq0c[a-z]{2}-' + '[\\dA-Za-z_-]{40,50}',
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'EAAA' + '[\\dA-Za-z+=-]{60}',

  // Azure Storage account keys
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'Account' + 'Key=[\\d+/=A-Za-z]{88}',

  // Google Cloud API keys - split to avoid self-matching
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'AIza' + 'Sy[\\dA-Za-z_-]{33}',

  // npm tokens
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'npm_' + '[\\dA-Za-z]{36}',
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  '\\/\\/.+\\/:_auth' + 'Token=[\\dA-Za-z_-]+',

  // Slack tokens and webhooks
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'xox[aboprs]-' + '(?:\\d+-)+[\\da-z]+',
  'https:\\/\\/hooks\\.slack\\.com\\/services\\/' +
    'T[\\dA-Za-z_]+\\/B[\\dA-Za-z_]+\\/[\\dA-Za-z_]+',

  // SendGrid API keys
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'SG\\.' + '[\\dA-Za-z_-]{22}\\.[\\dA-Za-z_-]{43}',

  // Twilio API keys
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  '(?:AC|SK)' + '[\\da-z]{32}',

  // Mailchimp API keys
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  '[\\da-f]{32}-' + 'us\\d{1,2}',

  // Intra42 API keys
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  's-s4t2' + '(?:af|ud)-[\\da-f]{64}',

  // PuTTY user key file
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'PuTTY-User-' + 'Key-File-2',

  // Age secret key
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'AGE-SECRET-' + 'KEY-1[\\dA-Z]{58}',

  // Private key files - split BEGIN/END markers
  privateKeyPattern('DSA'),
  privateKeyPattern('EC'),
  privateKeyPattern('OPENSSH'),
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  '-{5}BEGIN ' + 'PGP PRIVATE KEY BLOCK-{5}(?:$|[^-]{63,}-{5}END)',
  privateKeyPattern(''),
  privateKeyPattern('RSA'),
  privateKeyPattern('SSH2 ENCRYPTED'),

  // Random strings assigned to variables with names indicating secrets
  // Requires actual assignment operator (not optional) to avoid false positives from imports.
  // False positives from mid-word matches (e.g. "standardTokens: 250_000_000") are filtered
  // by the isLikelyRandom/isKnownSafeValue check on the captured value.
  '(?:(?<!(?:^|_)public_?)key|token|secret|pass' +
    'word|apikey|api_' +
    "key|auth|credentials)\\w*[\"''`]?]?\\s*(?:[:=]|:=|=>|<-)\\s*[\"''`]?([\\w+./=~-]{10,80})[\"''`]?",

  // Docker ENV variable declarations with secret-like names
  'ENV\\s+(?:\\w*(?:key|token|secret|pass(?:word)?|apikey|api_key|auth|credentials)\\w*)\\s+([\\S]+)',

  // AWS configure commands with access keys
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'aws\\s+configure\\s+set\\s+aws_access_' + 'key_id\\s+[A-Za-z0-9]{16,24}',

  // AWS configure commands with secret keys
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'aws\\s+configure\\s+set\\s+aws_secret_access_' + 'key\\s+[\\w+/=]{32,64}',

  // OpenAI project keys (sk-proj-...)
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'sk-proj-' + '[\\dA-Za-z_-]{20,200}',

  // OpenAI org/session keys (sk-...)
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'sk-[A-Za-z0-9]' + '{32,100}',

  // OpenRouter API keys (sk-or-v1-...)
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'sk-or-v1-' + '[\\da-f]{32,128}',

  // Anthropic keys (sk-ant-...)
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'sk-ant-' + '[\\dA-Za-z_-]{20,200}',

  // Notion integration tokens (ntn_...)
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'ntn_' + '[\\dA-Za-z]{32,100}',

  // HuggingFace tokens (hf_...)
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'hf_' + '[\\dA-Za-z]{20,100}',

  // Perplexity API keys (pplx-...)
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'pplx-' + '[\\dA-Za-z]{32,100}',

  // TPL API keys in quoted/backticked contexts (headers, arrays, markdown tables)
  '[`"\'](' +
    '(?=[A-Za-z0-9_-]{40,50}\\b)' +
    '(?=[A-Za-z0-9_-]*[A-Z])' +
    '(?=[A-Za-z0-9_-]*[a-z])' +
    '(?=[A-Za-z0-9_-]*\\d)' +
    '(?=[A-Za-z0-9_-]*[-_])' +
    '[A-Za-z0-9][A-Za-z0-9_-]{39,49}' +
    ')[`"\']',

  // Base64-encoded Basic Auth headers
  '(?:Basic|BASIC)\\s+((?:[A-Za-z0-9+/]{4}){4,}={0,2})',

  // Sentry DSN URLs (contain embedded auth key)
  'https://[\\dA-Za-z]+@(?:o\\d+\\.)?ingest\\.(?:[a-z]{2}\\.)?sentry\\.io/\\d+',

  // Google OAuth Client IDs
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  '(\\d{12}-[a-z0-9]+\\.apps\\.google' + 'usercontent\\.com)',

  // Short database passwords in env files (generic pattern needs 10+ chars)
  '(?:DB_PASS' +
    'WORD|MYSQL_PASS' +
    'WORD|POSTGRES_PASS' +
    'WORD|MYSQL_ROOT_PASS' +
    'WORD|DATABASE_PASS' +
    'WORD|REDIS_PASS' +
    'WORD|DB_PASS)\\s*=\\s*["\']?([^\\s"\']{1,80})["\']?',

  // Telegram Bot tokens (format: digits:base62 string)
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  '\\b\\d{8,10}:' + '[A-Za-z0-9_-]{35}\\b',

  // Neon API keys (napi_...)
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'napi_' + '[A-Za-z0-9]{20,100}',

  // Supabase project keys (sbp_...)
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'sbp_' + '[A-Za-z0-9]{20,100}',

  // Firecrawl API keys (fc-...)
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'fc-' + '[A-Za-z0-9]{20,100}',

  // Discord Bot tokens (base64-encoded user ID.timestamp.hmac)
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  '[MN][A-Za-z0-9]{23,28}' + '\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27,40}',

  // Vercel tokens
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'vercel_' + '[A-Za-z0-9]{24,}',

  // Doppler service tokens (dp.st.xxx.xxx)
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'dp\\.st\\.' + '[a-z0-9_-]+\\.[A-Za-z0-9]{40,44}',

  // Railway API tokens
  // eslint-disable-next-line no-useless-concat -- PLT-76: migrated from file-level disable
  'railway_' + '[A-Za-z0-9]{32,}',

  // Curl/HTTP request bodies with secret-like field names
  // Catches --form 'client_secret="..."' and -d '{"password":"..."}'
  // Captures everything up to whitespace/quotes to handle punctuation in passwords
  '(?:--form|--data|-d)\\s+[\'"]?' +
    '(?:client_secret|password|secret|api_key|apikey|access_token)' +
    '["\'`]?\\s*[=:]\\s*["\'`]?([^\\s"\'`]{8,200})["\'`]?',
];

/**
 * Lazily compile regex patterns from strings.
 * This prevents the patterns from matching themselves when this file is scanned.
 */
// eslint-disable-next-line industry/constants-file-organization -- PLT-76: migrated from file-level disable
let compiledRegexes: RegExp[] | null = null;

// eslint-disable-next-line industry/constants-file-organization -- PLT-76: migrated from file-level disable
function compileRegexes(): RegExp[] {
  if (compiledRegexes === null) {
    compiledRegexes = SECRET_PATTERNS.map((pattern) => {
      // Most patterns should be case-insensitive and global
      const isSpecialCase =
        pattern.includes('(?:key|token|secret') ||
        pattern.includes('(?<!(?:^|_)public_?)key|token|secret') ||
        pattern.includes('INDUSTRY_API_KEY') ||
        pattern.includes('aws\\s+configure') ||
        pattern.includes('client_secret|client_');
      const flags = isSpecialCase ? 'gi' : 'g';
      return new RegExp(pattern, flags);
    });
  }
  return compiledRegexes;
}

/**
 * Get the compiled secret detection regexes.
 * Uses lazy initialization to avoid compiling regexes until needed.
 */
// eslint-disable-next-line industry/constants-file-organization -- PLT-76: migrated from file-level disable
export function SECRET_DETECTION_REGEXES(): RegExp[] {
  return compileRegexes();
}
