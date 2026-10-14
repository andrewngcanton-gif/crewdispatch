param(
  [Parameter(Mandatory = $true)][string]$Setup,
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Screenshot
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$setupPath = (Resolve-Path $Setup).Path
$process = Start-Process -FilePath $setupPath -PassThru
$window = $null

try {
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
    $process.Refresh()
    if ($process.HasExited) {
      throw "Installer exited before its welcome page became visible (exit code $($process.ExitCode))."
    }
    if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
      $window = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
      if ($null -ne $window) { break }
    }
  }

  if ($null -eq $window) {
    throw 'Installer did not expose a top-level window within 30 seconds.'
  }

  $elements = $window.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $names = @()
  foreach ($element in $elements) {
    $name = $element.Current.Name
    if (-not [string]::IsNullOrWhiteSpace($name)) { $names += $name }
  }

  $expectedWelcome = "Welcome to the CrewDispatch $Version Setup Wizard"
  if ($names -notcontains $expectedWelcome) {
    throw "Welcome text is missing from the visible installer UI. Expected '$expectedWelcome'. Visible names: $($names -join ' | ')"
  }
  if (-not ($names | Where-Object { $_ -match '^Next\s*>?$' })) {
    throw "Next button is missing from the visible installer UI. Visible names: $($names -join ' | ')"
  }

  if ($Screenshot) {
    try {
      Add-Type -AssemblyName System.Drawing
      $bounds = $window.Current.BoundingRectangle
      $width = [Math]::Max(1, [int][Math]::Ceiling($bounds.Width))
      $height = [Math]::Max(1, [int][Math]::Ceiling($bounds.Height))
      $bitmap = New-Object System.Drawing.Bitmap($width, $height)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.CopyFromScreen([int]$bounds.X, [int]$bounds.Y, 0, 0, $bitmap.Size)
        $screenshotPath = [IO.Path]::GetFullPath($Screenshot)
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($screenshotPath)) | Out-Null
        $bitmap.Save($screenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
      } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
      }
    } catch {
      Write-Warning "Welcome UI passed, but screenshot capture was unavailable: $($_.Exception.Message)"
    }
  }

  Write-Host "Visible installer welcome page PASS: $expectedWelcome"
} finally {
  if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    $process.WaitForExit()
  }
}
