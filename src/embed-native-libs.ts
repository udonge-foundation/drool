/**
 * Embed native bun-pty libraries for single-file distribution
 *
 * This module embeds all platform-specific native libraries and automatically
 * sets BUN_PTY_LIB to the correct embedded library based on the current platform.
 *
 * This enables true single-file executables - no archive extraction needed!
 * Works because bun:ffi can load native libraries from Bun's virtual filesystem.
 *
 * Note: The bun-pty package ships separate libraries for each architecture.
 * CI ensures all platform libraries exist before SEA builds.
 */

// Embed all platform-specific native libraries
// These are special Bun file imports that TypeScript doesn't recognize

// @ts-expect-error - Bun file import (macOS x64)
import libDarwinX64 from '@assets/native/bun-pty/darwin-x64/librust_pty.dylib' with { type: 'file' };
// @ts-expect-error - Bun file import (Linux x64)
import libLinuxX64 from '@assets/native/bun-pty/linux-x64/librust_pty.so' with { type: 'file' };
// @ts-expect-error - Bun file import (macOS arm64)
import libDarwinArm64 from '@assets/native/bun-pty/darwin-arm64/librust_pty_arm64.dylib' with { type: 'file' };
// @ts-expect-error - Bun file import (Linux arm64)
import libLinuxArm64 from '@assets/native/bun-pty/linux-arm64/librust_pty_arm64.so' with { type: 'file' };
// @ts-expect-error - Bun file import (Windows x64)
import libWindows from '@assets/native/bun-pty/win32-x64/rust_pty.dll' with { type: 'file' };

// Auto-detect and set BUN_PTY_LIB based on current platform and architecture
// This must happen BEFORE bun-pty is imported anywhere
const platform = process.platform;
const arch = process.arch;

let embeddedLibPath: string | undefined;

if (platform === 'darwin') {
  embeddedLibPath = arch === 'arm64' ? libDarwinArm64 : libDarwinX64;
} else if (platform === 'linux') {
  embeddedLibPath = arch === 'arm64' ? libLinuxArm64 : libLinuxX64;
} else if (platform === 'win32') {
  embeddedLibPath = libWindows;
}

if (embeddedLibPath) {
  process.env.BUN_PTY_LIB = embeddedLibPath;
} else {
  // eslint-disable-next-line no-console
  console.warn(
    `Warning: No embedded library found for platform=${platform} arch=${arch}`
  );
}
