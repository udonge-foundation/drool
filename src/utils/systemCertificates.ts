import { exec } from 'child_process';
import fs from 'fs';
import https from 'https';
import path from 'path';
import tls from 'tls';
import { promisify } from 'util';

import { logException, logInfo, logWarn, Metrics } from '@industry/logging';
import { Metric } from '@industry/logging/metrics/enums';

import { countSystemCertificatesForPlatform } from '@/utils/certificates/countSystemCertificatesForPlatform';
import { getCertificateThumbprint } from '@/utils/certificates/getCertificateThumbprint';
import { isValidCertificate } from '@/utils/certificates/isValidCertificate';
import { loadCachedCertificates } from '@/utils/certificates/loadCachedCertificates';
import { parseCertificates } from '@/utils/certificates/parseCertificates';
import { saveCertificateCache } from '@/utils/certificates/saveCertificateCache';
import { getUserIndustryDir } from '@/utils/industryPaths';
import { withWindowsPowerShellFallback } from '@/utils/windowsShell';

const execAsync = promisify(exec);

/**
 * Execute PowerShell script using Windows shell fallback resolution.
 * @internal - Exported for testing
 */
async function executePowerShell(
  scriptBase64: string,
  timeout: number = 30000
): Promise<string> {
  const { stdout } = await withWindowsPowerShellFallback((powershellPath) =>
    execAsync(
      `${powershellPath} -NoProfile -NonInteractive -EncodedCommand ${scriptBase64}`,
      { timeout, maxBuffer: 10 * 1024 * 1024 }
    )
  );
  return stdout;
}

/**
 * Extract system certificates from macOS Keychain
 */
async function extractSystemCertificatesForMac(): Promise<string[]> {
  const uniqueCerts = new Set<string>();

  try {
    const keychains = [
      '/System/Library/Keychains/SystemRootCertificates.keychain',
      '/Library/Keychains/System.keychain',
    ];

    const keychainPromises = keychains.map(async (keychain) => {
      try {
        const { stdout } = await execAsync(
          `security find-certificate -a -p "${keychain}"`,
          { maxBuffer: 10 * 1024 * 1024 }
        );
        return stdout;
      } catch {
        return '';
      }
    });

    const outputs = await Promise.all(keychainPromises);
    for (const output of outputs) {
      if (output) {
        const certs = parseCertificates(output);
        certs.forEach((cert) => uniqueCerts.add(cert));
      }
    }
  } catch (error) {
    logWarn('Could not extract macOS Keychain certificates', {
      error: error instanceof Error ? error : String(error),
    });
  }

  // Also check /etc/ssl/cert.pem (common on macOS)
  try {
    if (fs.existsSync('/etc/ssl/cert.pem')) {
      const content = fs.readFileSync('/etc/ssl/cert.pem', 'utf-8');
      const certs = parseCertificates(content);
      certs.forEach((cert) => uniqueCerts.add(cert));
    }
  } catch (_error) {
    // File might not exist or be readable
  }

  return Array.from(uniqueCerts);
}

/**
 * Extract system certificates from Linux certificate stores
 */
async function extractSystemCertificatesForLinux(): Promise<string[]> {
  const uniqueCerts = new Set<string>();

  const certFiles = [
    '/etc/ssl/certs/ca-certificates.crt',
    '/etc/pki/tls/certs/ca-bundle.crt',
    '/etc/ssl/ca-bundle.pem',
    '/etc/pki/tls/cacert.pem',
    '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
    '/etc/ssl/cert.pem',
  ];

  const certDirs = ['/etc/ssl/certs', '/etc/pki/tls/certs'];

  if (process.env.SSL_CERT_FILE) {
    certFiles.push(process.env.SSL_CERT_FILE);
  }
  if (process.env.SSL_CERT_DIR) {
    certDirs.push(...process.env.SSL_CERT_DIR.split(':'));
  }

  // Read certificate files
  for (const file of certFiles) {
    try {
      if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, 'utf-8');
        const certs = parseCertificates(content);
        certs.forEach((cert) => uniqueCerts.add(cert));
      }
    } catch (_error) {
      // File might not be readable
    }
  }

  // Read certificate directories
  for (const dir of certDirs) {
    try {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.endsWith('.crt') || file.endsWith('.pem')) {
            try {
              const content = fs.readFileSync(`${dir}/${file}`, 'utf-8');
              const certs = parseCertificates(content);
              certs.forEach((cert) => uniqueCerts.add(cert));
            } catch (_error) {
              // File might not be readable
            }
          }
        }
      }
    } catch (_error) {
      // Directory might not be accessible
    }
  }

  return Array.from(uniqueCerts);
}

/**
 * Extract certificates from all Windows sources in a single PowerShell invocation.
 * Combines Cert:\ store and Registry extraction for performance.
 * This consolidates what was previously multiple separate PowerShell calls.
 */
async function extractAllWindowsCertificates(): Promise<string[]> {
  const script = `
    $certs = @()
    
    # ============================================
    # Extract from Cert:\\ stores (Root and CA)
    # LocalMachine covers system-wide trust; CurrentUser covers per-user
    # installs (e.g. Zscaler added without admin rights).
    # ============================================
    $certLocations = @('LocalMachine', 'CurrentUser')
    $certStores = @('Root', 'CA')
    foreach ($location in $certLocations) {
      foreach ($store in $certStores) {
        try {
          Get-ChildItem -Path "Cert:\\$location\\$store" -ErrorAction SilentlyContinue | ForEach-Object {
            try {
              $base64 = [System.Convert]::ToBase64String($_.Export('Cert'), 'InsertLineBreaks')
              $certs += $base64
            } catch {
              # Skip certificates that cannot be exported
            }
          }
        } catch {
          # Skip stores that cannot be accessed
        }
      }
    }
    
    # ============================================
    # Extract from Registry (HKLM Root, CA, AuthRoot)
    # ============================================
    $regStores = @('Root', 'CA', 'AuthRoot')
    $regBasePath = 'HKLM:\\Software\\Microsoft\\SystemCertificates'
    
    foreach ($store in $regStores) {
      $regPath = "$regBasePath\\$store\\Certificates"
      if (Test-Path $regPath) {
        Get-ChildItem $regPath -ErrorAction SilentlyContinue | ForEach-Object {
          try {
            $blob = (Get-ItemProperty -Path $_.PSPath -Name Blob -ErrorAction SilentlyContinue).Blob
            if ($blob) {
              $base64 = [System.Convert]::ToBase64String($blob, 'InsertLineBreaks')
              $certs += $base64
            }
          } catch {
            # Skip certificates that cannot be read
          }
        }
      }
    }
    
    # Output each cert separated by double newlines for parsing
    $certs -join "\`n\`n"
  `;

  const scriptBase64 = Buffer.from(script, 'utf16le').toString('base64');

  try {
    const stdout = await executePowerShell(scriptBase64, 30000);

    const certs: string[] = [];
    if (stdout?.trim()) {
      // Clean CLIXML wrapper if present
      let cleanOutput = stdout;
      if (stdout.includes('#< CLIXML') || stdout.includes('<Objs')) {
        const parts = stdout.split('</Objs>');
        if (parts.length > 1) {
          cleanOutput = parts[parts.length - 1];
        }
      }

      const base64Blocks = cleanOutput.trim().split(/\r?\n\r?\n+/);

      for (const block of base64Blocks) {
        const cleanBlock = block.trim();
        // Skip PowerShell prompts, XML tags, empty content
        if (
          cleanBlock &&
          !cleanBlock.startsWith('PS ') &&
          !cleanBlock.startsWith('#<') &&
          !cleanBlock.includes('<')
        ) {
          const normalized = cleanBlock.replace(/\s+/g, '');

          // Validate base64 and minimum length
          if (normalized.length > 50 && /^[A-Za-z0-9+/=]+$/.test(normalized)) {
            const formatted =
              normalized.match(/.{1,64}/g)?.join('\n') ?? normalized;
            const pemCert = `-----BEGIN CERTIFICATE-----\n${formatted}\n-----END CERTIFICATE-----`;

            if (isValidCertificate(pemCert)) {
              certs.push(pemCert);
            }
          }
        }
      }
    }

    return certs;
  } catch (error) {
    logWarn('Failed to extract Windows certificates', {
      error: error instanceof Error ? error : String(error),
    });
    return [];
  }
}

/**
 * Download and cache the root certificate from app.example.com
 * This is used as a fallback for corporate proxy environments (e.g., Zscaler)
 */
async function downloadIndustryRootCertificate(): Promise<string | null> {
  const start = performance.now();
  let outcome = 'error';

  try {
    const industryDir = getUserIndustryDir();
    const certDir = path.join(industryDir, 'certs');
    const certPath = path.join(certDir, 'industry-ai-root.pem');

    // Check if certificate already exists
    if (fs.existsSync(certPath)) {
      try {
        const content = fs.readFileSync(certPath, 'utf-8');
        if (content.includes('-----BEGIN CERTIFICATE-----')) {
          outcome = 'cache-hit';
          return content;
        }
      } catch (_error) {
        // Certificate file is corrupted, will re-download
      }
    }

    // On Windows, use PowerShell to get the root certificate properly
    if (process.platform === 'win32') {
      try {
        // PowerShell script to get the root certificate from the chain
        const script = `
          $website = "https://app.example.com"
          $hostname = ([System.Uri]$website).Host
          
          $tcpClient = New-Object System.Net.Sockets.TcpClient
          $tcpClient.Connect($hostname, 443)
          
          $sslStream = New-Object System.Net.Security.SslStream($tcpClient.GetStream(), $false, ({ $true }))
          $sslStream.AuthenticateAsClient($hostname)
          
          $certChain = $sslStream.RemoteCertificate
          $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $certChain
          
          $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
          $chain.Build($cert) | Out-Null
          
          # Get the root certificate (last certificate in the chain)
          $rootCert = $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate
          
          # Export the root certificate to base64
          $certBase64 = [System.Convert]::ToBase64String($rootCert.RawData, [System.Base64FormattingOptions]::InsertLineBreaks)
          Write-Output $certBase64
          
          $sslStream.Close()
          $tcpClient.Close()
        `;

        const scriptBase64 = Buffer.from(script, 'utf16le').toString('base64');
        const stdout = await executePowerShell(scriptBase64, 15000);

        if (stdout && stdout.trim()) {
          // Clean the output and format as PEM
          const base64 = stdout.trim().replace(/\r?\n/g, '\n');
          const pemContent = `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----`;

          // Validate it's a proper certificate
          if (isValidCertificate(pemContent)) {
            // Save to disk
            try {
              if (!fs.existsSync(certDir)) {
                fs.mkdirSync(certDir, { recursive: true });
              }
              fs.writeFileSync(certPath, pemContent, 'utf-8');
            } catch (_error) {
              // Non-fatal: can still return the cert content
            }

            outcome = 'powershell-success';
            return pemContent;
          }
        }
      } catch (error) {
        logWarn('Failed to get root certificate via PowerShell', {
          error: error instanceof Error ? error : String(error),
        });
      }
    }

    // Fallback: Use Node.js TLS approach (for non-Windows or if PowerShell fails)
    const hostname = 'app.example.com';
    const port = 443;

    return new Promise((resolve) => {
      const socket = tls.connect(
        {
          host: hostname,
          port,
          servername: hostname,
          // Don't validate certificate (we're trying to get it!)
          rejectUnauthorized: false,
        },
        () => {
          try {
            const cert = socket.getPeerCertificate(true);
            if (!cert || !cert.raw) {
              socket.end();
              outcome = 'tls-no-certificate';
              resolve(null);
              return;
            }

            // Walk the certificate chain to find the furthest certificate available
            let rootCert = cert;
            let currentCert = cert;
            const seenFingerprints = new Set<string>();

            while (currentCert) {
              if (seenFingerprints.has(currentCert.fingerprint)) {
                break;
              }
              seenFingerprints.add(currentCert.fingerprint);

              if (
                currentCert.issuerCertificate &&
                currentCert.issuerCertificate.fingerprint !==
                  currentCert.fingerprint
              ) {
                currentCert = currentCert.issuerCertificate;
                rootCert = currentCert;
              } else {
                break;
              }
            }

            // Convert to PEM format
            const base64 = rootCert.raw.toString('base64');
            const formatted = base64.match(/.{1,64}/g)?.join('\n') || base64;
            const pemContent = `-----BEGIN CERTIFICATE-----\n${formatted}\n-----END CERTIFICATE-----`;

            // Save to disk
            try {
              if (!fs.existsSync(certDir)) {
                fs.mkdirSync(certDir, { recursive: true });
              }
              fs.writeFileSync(certPath, pemContent, 'utf-8');
            } catch (_error) {
              // Non-fatal: can still return the cert content
            }

            socket.end();
            outcome = 'tls-success';
            resolve(pemContent);
          } catch (error) {
            socket.end();
            logWarn('Failed to extract certificate via Node.js TLS', {
              error: error instanceof Error ? error : String(error),
            });
            outcome = 'tls-error';
            resolve(null);
          }
        }
      );

      socket.on('error', (error: Error) => {
        logWarn(
          'Failed to connect to app.example.com for certificate download',
          { error: error instanceof Error ? error : String(error) }
        );
        outcome = 'tls-connect-error';
        resolve(null);
      });

      // Set a timeout
      socket.setTimeout(10000, () => {
        socket.end();
        outcome = 'tls-timeout';
        resolve(null);
      });
    });
  } catch (error) {
    logWarn('Failed to download Industry root certificate', {
      error: error instanceof Error ? error : String(error),
    });
    return null;
  } finally {
    Metrics.addToCounter(
      Metric.CLI_STARTUP_CERTIFICATE_INDUSTRY_ROOT_LATENCY,
      performance.now() - start,
      { outcome }
    );
  }
}

/**
 * Extract system certificates from Windows certificate store
 */
async function extractSystemCertificatesForWindows(): Promise<string[]> {
  const uniqueCerts = new Set<string>();

  // Single PowerShell call for all cert store + registry certificates
  // This consolidates what was previously 5+ separate PowerShell invocations
  const [allCerts, industryCert] = await Promise.all([
    extractAllWindowsCertificates().catch(() => [] as string[]),
    // Industry cert download uses TLS (not PowerShell) on success path
    downloadIndustryRootCertificate().catch(() => null),
  ]);

  allCerts.forEach((cert) => uniqueCerts.add(cert));

  if (industryCert) {
    const industryCerts = parseCertificates(industryCert);
    industryCerts.forEach((cert) => uniqueCerts.add(cert));
  }

  return Array.from(uniqueCerts);
}

/**
 * Extract system certificates from platform-specific stores (no caching)
 */
async function extractSystemCertificatesForPlatform(): Promise<string[]> {
  if (process.platform === 'darwin') {
    return extractSystemCertificatesForMac();
  }
  if (process.platform === 'linux') {
    return extractSystemCertificatesForLinux();
  }
  if (process.platform === 'win32') {
    return extractSystemCertificatesForWindows();
  }

  return [];
}

/**
 * Extract system certificates from platform-specific stores with caching.
 * Uses count-based cache invalidation for fast startup:
 * - On Windows, a valid TTL cache is used before counting because the count probe is slow
 * - If certificate count matches cached count, use cached certificates (fast path)
 * - If count differs, re-extract certificates (handles new/removed certificates)
 * - Empty results (count=0) are also cached to avoid repeated slow extraction
 */
async function extractSystemCertificates(): Promise<string[]> {
  if (process.platform === 'win32') {
    // Windows count probes can take seconds even when the cache is valid.
    // Passing null makes validation TTL-based: version/platform/7-day TTL
    // still invalidate stale caches before falling through to count/extract.
    const cachedCerts = await loadCachedCertificates(null);
    if (cachedCerts !== null) {
      Metrics.addToCounter(Metric.CLI_STARTUP_CERTIFICATE_CACHE_COUNT, 1, {
        cacheStatus: 'hit',
        outcome: 'count-skipped',
      });
      return cachedCerts;
    }
  }

  const currentCount = await countSystemCertificatesForPlatform();

  const cachedCerts = await loadCachedCertificates(currentCount);
  if (cachedCerts !== null) {
    Metrics.addToCounter(Metric.CLI_STARTUP_CERTIFICATE_CACHE_COUNT, 1, {
      cacheStatus: 'hit',
      outcome: currentCount === null ? 'count-unavailable' : 'count-match',
    });
    return cachedCerts;
  }

  Metrics.addToCounter(Metric.CLI_STARTUP_CERTIFICATE_CACHE_COUNT, 1, {
    cacheStatus: 'miss',
    outcome: currentCount === null ? 'count-unavailable' : 'count-mismatch',
  });

  const extractionStart = performance.now();
  const freshCerts = await extractSystemCertificatesForPlatform();
  Metrics.addToCounter(
    Metric.CLI_STARTUP_CERTIFICATE_EXTRACTION_LATENCY,
    performance.now() - extractionStart,
    {
      outcome: freshCerts.length > 0 ? 'success' : 'empty',
    }
  );
  const countToCache = currentCount ?? freshCerts.length;
  await saveCertificateCache(freshCerts, countToCache);

  return freshCerts;
}

/**
 * When INDUSTRY_DEBUG_CERTS is set, log the loaded CA counts and SHA-1
 * thumbprints so corporate-proxy certificates (e.g. Zscaler) can be confirmed
 * as trusted. If the env var holds a 40-hex thumbprint, also log a presence
 * check for that specific certificate. Hashing every CA is only done in this
 * opt-in debug path to avoid startup cost.
 */
function logLoadedCertificateThumbprints(args: {
  allCAs: string[];
  bundledCount: number;
  systemCount: number;
  extraCount: number;
}): void {
  const { allCAs, bundledCount, systemCount, extraCount } = args;

  const thumbprints = allCAs
    .map(getCertificateThumbprint)
    .filter((thumbprint): thumbprint is string => thumbprint !== null);

  logInfo('Loaded CA certificates', {
    value: `total=${allCAs.length} bundled=${bundledCount} system=${systemCount} extra=${extraCount} thumbprints=${thumbprints.length}`,
  });

  const target = process.env.INDUSTRY_DEBUG_CERTS?.trim().toUpperCase();
  if (target && /^[0-9A-F]{40}$/.test(target)) {
    logInfo('CA certificate thumbprint presence check', {
      value: `${target} present=${thumbprints.includes(target)}`,
    });
  }

  logInfo('Loaded CA certificate thumbprints (SHA-1)', {
    value: thumbprints.join(','),
  });
}

export async function loadSystemCertificates(): Promise<void> {
  try {
    const bundledCAs = tls.rootCertificates || [];
    const systemCAs = await extractSystemCertificates();

    // Load any user-provided extra CA certs from env vars
    const extraCAs: string[] = [];
    const loadFromEnvPath = (envVar?: string) => {
      if (!envVar) return;
      try {
        // Support either direct PEM content or a filesystem path
        if (envVar.includes('-----BEGIN CERTIFICATE-----')) {
          extraCAs.push(...parseCertificates(envVar));
          return;
        }
        const candidates = envVar.split(path.delimiter).filter(Boolean);
        for (const candidate of candidates) {
          try {
            if (fs.existsSync(candidate)) {
              const content = fs.readFileSync(candidate, 'utf-8');
              extraCAs.push(...parseCertificates(content));
            }
          } catch {
            // Ignore unreadable paths
          }
        }
      } catch {
        // Ignore invalid env inputs
      }
    };

    loadFromEnvPath(process.env.NODE_EXTRA_CA_CERTS);
    loadFromEnvPath(process.env.INDUSTRY_EXTRA_CA_CERTS);

    // Combine all certificates
    const allCAs = [...bundledCAs, ...systemCAs, ...extraCAs];
    Metrics.addToCounter(
      Metric.CLI_STARTUP_CERTIFICATE_LOADED_COUNT,
      allCAs.length,
      {
        count: systemCAs.length,
      }
    );

    if (process.env.INDUSTRY_DEBUG_CERTS) {
      logLoadedCertificateThumbprints({
        allCAs,
        bundledCount: bundledCAs.length,
        systemCount: systemCAs.length,
        extraCount: extraCAs.length,
      });
    }

    const originalCreateSecureContext = tls.createSecureContext;
    tls.createSecureContext = function (options = {}) {
      return originalCreateSecureContext({
        ...options,
        ca: 'ca' in options ? options.ca : allCAs,
      });
    };
    https.globalAgent.options.ca = allCAs;

    // Configure for Bun's fetch() - use both approaches for compatibility
    // 1. Fetch override for bundle/dev mode
    if (typeof globalThis.fetch !== 'undefined') {
      const originalFetch = globalThis.fetch;

      // Type for Bun's extended RequestInit with TLS options
      type BunRequestInit = RequestInit & {
        tls?: {
          ca?: string | string[];
          [key: string]: unknown;
        };
      };

      globalThis.fetch = function (
        input: RequestInfo | URL,
        init?: RequestInit
      ): Promise<Response> {
        // Inject TLS options for Bun's fetch
        const bunInit = init as BunRequestInit | undefined;
        const tlsOptions: Record<string, unknown> = bunInit?.tls ?? {};
        const hasCA = Object.prototype.hasOwnProperty.call(tlsOptions, 'ca');
        const enhancedInit = {
          ...init,
          tls: {
            ...tlsOptions,
            // Only fall back when 'ca' is not present; allow empty arrays/strings as explicit overrides
            ca: hasCA ? (tlsOptions as { ca?: string | string[] }).ca : allCAs,
          },
        } satisfies BunRequestInit;
        return originalFetch(input, enhancedInit);
        // eslint-disable-next-line no-restricted-globals -- typeof reference to patch the global fetch with TLS options
      } as typeof fetch;
    }

    // 2. Temp file approach for SEA builds. Write to a per-user industry
    // cache dir (not a world-writable temp dir) and rename atomically to
    // avoid symlink-clobber on the destination path.
    if (systemCAs.length > 0) {
      try {
        const cacheDir = path.join(getUserIndustryDir(), 'cache', 'certs');
        fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
        const certFile = path.join(cacheDir, 'industry-cli-certs.pem');

        const pemContent = allCAs.join('\n');
        const tmpFile = `${certFile}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpFile, pemContent, { mode: 0o600, flag: 'wx' });
        fs.renameSync(tmpFile, certFile);

        // For SEA builds, only set NODE_EXTRA_CA_CERTS if user hasn't set it
        if (!process.env.NODE_EXTRA_CA_CERTS) {
          process.env.NODE_EXTRA_CA_CERTS = certFile;
        }
      } catch (_error) {
        // Non-fatal: fetch override still works for non-SEA builds
      }
    }
  } catch (error) {
    logException(
      error instanceof Error ? error : new Error(String(error)),
      'Failed to load system certificates in CLI'
    );
  }
}
