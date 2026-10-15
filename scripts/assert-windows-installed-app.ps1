param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$InstallLocation
)

$ErrorActionPreference = 'Stop'
$Key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CrewDispatch'

if (-not (Test-Path $Key)) {
  throw "CrewDispatch Installed Apps registration is missing: $Key"
}

$entry = Get-ItemProperty $Key
$expectedLocation = [System.IO.Path]::GetFullPath($InstallLocation).TrimEnd('\')
$actualLocation = [System.IO.Path]::GetFullPath([string]$entry.InstallLocation).TrimEnd('\')
$expectedUninstall = '"' + (Join-Path $expectedLocation 'Uninstall.exe') + '"'
$expectedQuietUninstall = $expectedUninstall + ' /S'

function Assert-Equal([string]$Name, $Actual, $Expected) {
  if ($Actual -ne $Expected) {
    throw "Installed Apps metadata mismatch for ${Name}: expected '$Expected', got '$Actual'"
  }
}

Assert-Equal 'DisplayName' ([string]$entry.DisplayName) 'CrewDispatch'
Assert-Equal 'DisplayVersion' ([string]$entry.DisplayVersion) $Version
Assert-Equal 'Publisher' ([string]$entry.Publisher) 'CrewDispatch'
Assert-Equal 'InstallLocation' $actualLocation $expectedLocation
Assert-Equal 'UninstallString' ([string]$entry.UninstallString) $expectedUninstall
Assert-Equal 'QuietUninstallString' ([string]$entry.QuietUninstallString) $expectedQuietUninstall
Assert-Equal 'NoModify' ([int]$entry.NoModify) 1
Assert-Equal 'NoRepair' ([int]$entry.NoRepair) 1

Write-Host "Installed Apps metadata PASS: CrewDispatch $Version at $expectedLocation"
