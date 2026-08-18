# Paints opaque boxes over regions of a PNG, in place-ish (writes alongside).
# Usage: .\redact.ps1 -In overview.png -Rects "12,34,100,20; 200,10,80,16" [-Label]
param(
  [Parameter(Mandatory=$true)][string]$In,
  [Parameter(Mandatory=$true)][string]$Rects,
  [string]$Fill = "#2b3242"
)
Add-Type -AssemblyName System.Drawing
$dir = Join-Path $PSScriptRoot "..\docs\screenshots"
$path = Join-Path $dir $In
if (-not (Test-Path $path)) { Write-Output "missing: $path"; exit 1 }
$bmp = New-Object System.Drawing.Bitmap($path)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$c = [System.Drawing.ColorTranslator]::FromHtml($Fill)
$brush = New-Object System.Drawing.SolidBrush($c)
$n = 0
foreach ($r in ($Rects -split ';')) {
  $r = $r.Trim(); if ($r -eq '') { continue }
  $p = $r -split ','
  $g.FillRectangle($brush, [int]$p[0], [int]$p[1], [int]$p[2], [int]$p[3])
  $n++
}
$g.Dispose()
$tmp = Join-Path $dir ("_r_" + $In)
$bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Move-Item $tmp $path -Force
Write-Output ("redacted {0}: {1} region(s)" -f $In, $n)
