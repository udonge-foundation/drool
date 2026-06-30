/**
 * Gets the system's default executable for opening a path in the file browser.
 * @returns The platform-specific open executable ('open' | 'explorer.exe' | 'xdg-open')
 */
export function getSystemOpenCommand(): 'open' | 'explorer.exe' | 'xdg-open' {
  return process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'explorer.exe'
      : 'xdg-open';
}
