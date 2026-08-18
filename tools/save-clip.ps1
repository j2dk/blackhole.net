# Saves whatever image is currently on the clipboard to docs/screenshots/<name>.png
param([Parameter(Mandatory=$true)][string]$Name)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $img) { Write-Output "clipboard holds no image"; exit 1 }
$dir = Join-Path $PSScriptRoot "..\docs\screenshots"
$out = Join-Path $dir ($Name + ".png")
$img.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ("saved {0}  ({1}x{2}, {3} KB)" -f $Name, $img.Width, $img.Height, [int]((Get-Item $out).Length/1KB))
