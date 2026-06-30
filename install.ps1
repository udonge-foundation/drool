$ErrorActionPreference = 'Stop'

$InstallDir = if ($env:DROOL_INSTALL_DIR) {
  $env:DROOL_INSTALL_DIR
} else {
  Join-Path $HOME '.local\bin'
}
$InstallPath = Join-Path $InstallDir 'drool.exe'
$Asset = 'drool-win32-x64.exe'

if (-not [Environment]::Is64BitOperatingSystem) {
  throw 'Unsupported platform: Windows x64 is required.'
}

$Url = "https://github.com/udonge-foundation/drool/releases/latest/download/$Asset"
$TempDir = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
$TempBin = Join-Path $TempDir $Asset

try {
  New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $TempBin -UseBasicParsing

  Move-Item -Path $TempBin -Destination $InstallPath -Force
  Write-Host "Installed drool to $InstallPath"

  $PathSeparator = [IO.Path]::PathSeparator
  $CurrentPathParts = ($env:Path -split [Regex]::Escape([string]$PathSeparator)) |
    Where-Object { $_ }
  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $UserPathParts = ($UserPath -split [Regex]::Escape([string]$PathSeparator)) |
    Where-Object { $_ }

  $IsInCurrentPath = $CurrentPathParts |
    Where-Object { $_.TrimEnd('\') -ieq $InstallDir.TrimEnd('\') } |
    Select-Object -First 1
  $IsInUserPath = $UserPathParts |
    Where-Object { $_.TrimEnd('\') -ieq $InstallDir.TrimEnd('\') } |
    Select-Object -First 1

  if (-not $IsInUserPath) {
    $NewUserPath = if ([string]::IsNullOrWhiteSpace($UserPath)) {
      $InstallDir
    } else {
      "$UserPath$PathSeparator$InstallDir"
    }
    [Environment]::SetEnvironmentVariable('Path', $NewUserPath, 'User')
    Write-Host "Added $InstallDir to your user PATH."
  }

  if (-not $IsInCurrentPath) {
    $env:Path = "$InstallDir$PathSeparator$env:Path"
    Write-Host 'Updated PATH for this PowerShell session.'
  }

  Write-Host "Run 'drool' to start."
  if (-not $IsInUserPath) {
    Write-Host 'Please restart your terminal first.'
  }
} finally {
  if (Test-Path $TempDir) {
    Remove-Item -Path $TempDir -Recurse -Force
  }
}
