/**
 * Extract filename from a line of ls/dir output
 */
export function extractFilenameFromLine(
  line: string,
  platform: NodeJS.Platform
): string | null {
  if (!line.trim()) return null;

  if (platform === 'win32') {
    // PowerShell Get-ChildItem format:
    // "Mode                 LastWriteTime         Length Name"
    // "d-----         8/27/2025   5:17 PM                .github"
    // "-a----         9/26/2025   4:38 PM           3661 package.json"
    // Skip header lines and separators
    if (
      line.includes('Directory:') ||
      line.startsWith('Mode') ||
      line.startsWith('----') ||
      line.trim() === ''
    ) {
      return null;
    }

    // Parse PowerShell output - Name is the last column
    // Mode column is fixed width, followed by LastWriteTime, Length (optional), and Name
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length >= 3) {
      // The last part is always the name
      const lastPart = parts[parts.length - 1];

      // If the last part starts with a number (file size), extract the filename after it
      const sizeAndName = lastPart.match(/^(\d+)\s+(.+)$/);
      const name = sizeAndName ? sizeAndName[2] : lastPart;
      if (name && name !== '.' && name !== '..') {
        return name;
      }
    }

    return null;
  }
  // Unix ls -la format: "drwxr-xr-x  5 user group  160 Jan 15 14:23 dirname"
  // Skip the total line
  if (line.startsWith('total')) return null;

  // Must start with permissions
  if (!line.match(/^[dlrwxst-]{10}/)) return null;

  // Split by whitespace and take everything after the 8th field
  // This handles filenames with spaces
  const parts = line.split(/\s+/);
  if (parts.length >= 9) {
    return parts.slice(8).join(' ');
  }
  return null;
}
