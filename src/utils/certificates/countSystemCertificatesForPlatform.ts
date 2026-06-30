import { exec } from 'child_process';
import { promisify } from 'util';

import { logWarn, Metrics } from '@industry/logging';
import { Metric } from '@industry/logging/metrics/enums';

import { withWindowsPowerShellFallback } from '@/utils/windowsShell';

const execAsync = promisify(exec);

/**
 * Execute PowerShell script using Windows shell fallback resolution.
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
 * Count system certificates on macOS without reading content (fast).
 * Uses security command to count certificates in keychains.
 */
async function countSystemCertificatesMac(): Promise<number> {
  let count = 0;
  try {
    const keychains = [
      '/System/Library/Keychains/SystemRootCertificates.keychain',
      '/Library/Keychains/System.keychain',
    ];

    const countPromises = keychains.map(async (keychain) => {
      try {
        const { stdout } = await execAsync(
          `security find-certificate -a "${keychain}" | grep -c "keychain:"`
        );
        return parseInt(stdout.trim(), 10) || 0;
      } catch (error) {
        logWarn('Failed to count certificates in keychain', {
          error: error instanceof Error ? error.message : String(error),
          value: keychain,
        });
        return 0;
      }
    });

    const counts = await Promise.all(countPromises);
    count = counts.reduce((a, b) => a + b, 0);

    try {
      const { stdout } = await execAsync(
        'grep -c "BEGIN CERTIFICATE" /etc/ssl/cert.pem 2>/dev/null || echo 0'
      );
      count += parseInt(stdout.trim(), 10) || 0;
    } catch (error) {
      logWarn('Failed to count certificates in /etc/ssl/cert.pem', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } catch (error) {
    logWarn('Failed to count macOS system certificates', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return count;
}

/**
 * Count system certificates on Linux without reading content (fast).
 * Counts certificate files in standard directories.
 */
async function countSystemCertificatesLinux(): Promise<number> {
  const certFiles = [
    '/etc/ssl/certs/ca-certificates.crt',
    '/etc/pki/tls/certs/ca-bundle.crt',
    '/etc/ssl/ca-bundle.pem',
    '/etc/pki/tls/cacert.pem',
    '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
    '/etc/ssl/cert.pem',
  ];

  const certDirs = ['/etc/ssl/certs', '/etc/pki/tls/certs'];

  // Count certificates in bundle files (parallel)
  const fileCountPromises = certFiles.map(async (file) => {
    try {
      const { stdout } = await execAsync(
        `grep -c "BEGIN CERTIFICATE" "${file}" 2>/dev/null || echo 0`
      );
      return parseInt(stdout.trim(), 10) || 0;
    } catch (error) {
      logWarn('Failed to count certificates in file', {
        error: error instanceof Error ? error.message : String(error),
        value: file,
      });
      return 0;
    }
  });

  // Count .crt and .pem files in directories (parallel)
  const dirCountPromises = certDirs.map(async (dir) => {
    try {
      const { stdout } = await execAsync(
        `find "${dir}" -maxdepth 1 -type f \\( -name "*.crt" -o -name "*.pem" \\) 2>/dev/null | wc -l`
      );
      return parseInt(stdout.trim(), 10) || 0;
    } catch (error) {
      logWarn('Failed to count certificate files in directory', {
        error: error instanceof Error ? error.message : String(error),
        value: dir,
      });
      return 0;
    }
  });

  const [fileCounts, dirCounts] = await Promise.all([
    Promise.all(fileCountPromises),
    Promise.all(dirCountPromises),
  ]);

  return (
    fileCounts.reduce((a, b) => a + b, 0) + dirCounts.reduce((a, b) => a + b, 0)
  );
}

/**
 * Count system certificates on Windows without reading content (fast).
 * Uses PowerShell to count certificates in cert stores.
 */
export function parseCertificateCount(stdout: string): number | null {
  const trimmed = stdout.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const count = Number(trimmed);
  return Number.isSafeInteger(count) ? count : null;
}

async function countSystemCertificatesWindows(): Promise<number | null> {
  try {
    const script = `
      $count = 0
      $count += (Get-ChildItem -Path Cert:\\LocalMachine\\Root -ErrorAction SilentlyContinue).Count
      $count += (Get-ChildItem -Path Cert:\\LocalMachine\\CA -ErrorAction SilentlyContinue).Count
      $count += (Get-ChildItem -Path Cert:\\CurrentUser\\Root -ErrorAction SilentlyContinue).Count
      $count += (Get-ChildItem -Path Cert:\\CurrentUser\\CA -ErrorAction SilentlyContinue).Count
      Write-Output $count
    `;
    const scriptBase64 = Buffer.from(script, 'utf16le').toString('base64');

    const stdout = await executePowerShell(scriptBase64, 10000);
    const count = parseCertificateCount(stdout);
    if (count === null) {
      logWarn('Failed to parse Windows system certificate count', {
        value: stdout.trim().slice(0, 128),
      });
    }
    return count;
  } catch (error) {
    logWarn('Failed to count Windows system certificates', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Count system certificates for the current platform (fast operation).
 * Returns null if count check fails.
 */
export async function countSystemCertificatesForPlatform(): Promise<
  number | null
> {
  const start = performance.now();
  let outcome = 'success';

  try {
    let count: number | null;
    if (process.platform === 'darwin') {
      count = await countSystemCertificatesMac();
    } else if (process.platform === 'linux') {
      count = await countSystemCertificatesLinux();
    } else if (process.platform === 'win32') {
      count = await countSystemCertificatesWindows();
    } else {
      count = null;
    }

    if (count === null) {
      outcome = 'unavailable';
    }
    return count;
  } catch (error) {
    outcome = 'error';
    logWarn('Failed to count system certificates for platform', {
      error: error instanceof Error ? error.message : String(error),
      value: process.platform,
    });
    return null;
  } finally {
    Metrics.addToCounter(
      Metric.CLI_STARTUP_CERTIFICATE_COUNT_LATENCY,
      performance.now() - start,
      { outcome }
    );
  }
}
