# Regenerates the installer artwork committed next to this script:
#   dpredict-icon.ico   setup.exe / shortcut / Add-Remove-Programs icon
#   wizard-image.png    the tall left panel of the modern wizard (240x459 area)
#   wizard-small.png    the header tile in the top-right of each wizard page
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\assets\generate-art.ps1
#
# Colours are the dashboard's own palette so the installer and the app read as
# one product. Sizes follow Inno Setup's modern wizard, which stretches images to
# fit, so only the aspect ratios are load-bearing.
param([string]$OutDir = $PSScriptRoot)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing | Out-Null

function Get-BrandColor([string]$Name) {
  switch ($Name) {
    'ink'    { return [System.Drawing.Color]::FromArgb(8, 18, 15) }
    'panel'  { return [System.Drawing.Color]::FromArgb(13, 26, 22) }
    'lime'   { return [System.Drawing.Color]::FromArgb(200, 241, 105) }
    'sage'   { return [System.Drawing.Color]::FromArgb(113, 180, 145) }
    'muted'  { return [System.Drawing.Color]::FromArgb(120, 144, 135) }
    'line'   { return [System.Drawing.Color]::FromArgb(41, 70, 59) }
    default { throw "Unknown brand colour '$Name'" }
  }
}

function Set-BrandTile {
  param($Graphics, [System.Drawing.Rectangle]$Bounds, [double]$RadiusRatio = 0.22)
  # Rounded lime tile with three rising candlesticks, drawn inside $Bounds.
  $g = $Graphics
  $size = [Math]::Min($Bounds.Width, $Bounds.Height)
  $x = $Bounds.X + [int](($Bounds.Width - $size) / 2)
  $y = $Bounds.Y + [int](($Bounds.Height - $size) / 2)
  $tile = New-Object System.Drawing.Rectangle $x, $y, $size, $size
  $arc = [Math]::Max(2, [int]($size * $RadiusRatio * 2))
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($tile.X, $tile.Y, $arc, $arc, 180, 90)
  $path.AddArc(($tile.Right - $arc), $tile.Y, $arc, $arc, 270, 90)
  $path.AddArc(($tile.Right - $arc), ($tile.Bottom - $arc), $arc, $arc, 0, 90)
  $path.AddArc($tile.X, ($tile.Bottom - $arc), $arc, $arc, 90, 90)
  $path.CloseFigure()
  $fill = New-Object System.Drawing.Drawing2D.LinearGradientBrush($tile,
    (Get-BrandColor 'lime'), (Get-BrandColor 'sage'), [single]45)
  $g.FillPath($fill, $path)
  $fill.Dispose()
  $path.Dispose()
  $ink = Get-BrandColor 'ink'
  $pen = New-Object System.Drawing.Pen $ink, ([single]([Math]::Max(1.0, $size * 0.05)))
  $body = New-Object System.Drawing.SolidBrush $ink
  $bodyWidth = [Math]::Max(1.5, $size * 0.14)
  for ($i = 0; $i -lt 3; $i++) {
    $cx = $tile.X + [int]($size * (0.31 + $i * 0.19))
    $g.DrawLine($pen, $cx, ($tile.Y + [int]($size * (0.30 - $i * 0.04))), $cx, ($tile.Y + [int]($size * (0.72 - $i * 0.06))))
    $bodyTop = $tile.Y + [int]($size * (0.42 - $i * 0.05))
    $bodyHeight = [Math]::Max(2, [int]($size * 0.21))
    $g.FillRectangle($body, ($cx - $bodyWidth / 2), $bodyTop, ([single]$bodyWidth), $bodyHeight)
  }
  $pen.Dispose()
  $body.Dispose()
}

function New-GradientCanvas([int]$Width, [int]$Height) {
  $bmp = New-Object System.Drawing.Bitmap $Width, $Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::FromArgb(255, 8, 18, 15))
  $rect = New-Object System.Drawing.Rectangle 0, 0, $Width, $Height
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect,
    (Get-BrandColor 'ink'),
    ([System.Drawing.Color]::FromArgb(20, 45, 38)), [single]90)
  $g.FillRectangle($brush, $rect)
  $brush.Dispose()
  return @{ Bitmap = $bmp; Graphics = $g }
}

function New-TransparentCanvas([int]$Width, [int]$Height) {
  $bmp = New-Object System.Drawing.Bitmap $Width, $Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  return @{ Bitmap = $bmp; Graphics = $g }
}

function Set-CandleField {
  param($Graphics, [int]$Width, [int]$Height, [int]$Count, [double]$TopRatio, [double]$BottomRatio, [System.Drawing.Color]$Color, [double]$Seed)
  # Deterministic pseudo-random rising candles: no two runs differ, so the
  # regenerated artwork stays reviewable in a diff.
  $g = $Graphics
  $column = $Width / $Count
  $bodyWidth = [Math]::Max(2.0, $column * 0.42)
  $pen = New-Object System.Drawing.Pen $Color, ([single]([Math]::Max(1.0, $column * 0.10)))
  $brush = New-Object System.Drawing.SolidBrush $Color
  $span = ($BottomRatio - $TopRatio) * $Height
  for ($i = 0; $i -lt $Count; $i++) {
    $wave = [Math]::Sin(($i + $Seed) * 0.9) * 0.18 + [Math]::Cos(($i + $Seed) * 0.35) * 0.10
    $progress = $i / [Math]::Max(1, ($Count - 1))
    $centre = $Height * $BottomRatio - ($progress * $span * 0.72) - ($wave * $span * 0.30)
    $cx = [int]($column * ($i + 0.5))
    $g.DrawLine($pen, $cx, [int]($centre - $span * 0.13), $cx, [int]($centre + $span * 0.13))
    $bodyHeight = [Math]::Max(3.0, $span * (0.10 + 0.05 * [Math]::Abs([Math]::Sin(($i + $Seed) * 1.7))))
    $g.FillRectangle($brush, ($cx - $bodyWidth / 2), [int]($centre - $bodyHeight / 2), ([single]$bodyWidth), ([single]$bodyHeight))
  }
  $pen.Dispose()
  $brush.Dispose()
}

function Write-Png {
  param([System.Drawing.Bitmap]$Bitmap, [string]$Path)
  $ms = New-Object System.IO.MemoryStream
  $Bitmap.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $ms.Dispose()
  [System.IO.File]::WriteAllBytes($Path, $bytes)
  Write-Host "wrote $Path ($($bytes.Length) bytes)"
  return $bytes
}

function Get-IcoBytes {
  param([System.Collections.Hashtable[]]$Entries)
  # ICO header: reserved=0, type=1, count. Each directory entry is 16 bytes and
  # points at a PNG payload, which Windows has accepted since Vista.
  $out = New-Object System.IO.MemoryStream
  $header = New-Object byte[] 6
  $header[2] = 1
  $header[4] = [byte]($Entries.Count -band 0xFF)
  $header[5] = [byte]((($Entries.Count -shr 8)) -band 0xFF)
  $out.Write($header, 0, $header.Length)
  $offset = 6 + (16 * $Entries.Count)
  foreach ($entry in $Entries) {
    $size = [int]$entry.Size
    $record = New-Object byte[] 16
    $sizeByte = 0
    if ($size -lt 256) { $sizeByte = $size }
    $record[0] = [byte]$sizeByte
    $record[1] = [byte]$sizeByte
    $record[4] = 1
    $record[6] = 32
    $length = [BitConverter]::GetBytes([int]$entry.Png.Length)
    [Array]::Copy($length, 0, $record, 8, 4)
    $position = [BitConverter]::GetBytes([int]$offset)
    [Array]::Copy($position, 0, $record, 12, 4)
    $out.Write($record, 0, $record.Length)
    $offset += $entry.Png.Length
  }
  foreach ($entry in $Entries) { $out.Write($entry.Png, 0, $entry.Png.Length) }
  $bytes = $out.ToArray()
  $out.Dispose()
  return , $bytes
}

$assets = New-Item -ItemType Directory -Force $OutDir
$assets = $assets.FullName

# --- Header tile (55x58 area on the wizard header) ---------------------------
# Opaque and page-coloured: Inno stretches this onto the light wizard header, so
# a transparent PNG would render as a dark box instead of blending in.
$small = New-GradientCanvas 110 116
$flat = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(248, 250, 249))
$small.Graphics.FillRectangle($flat, 0, 0, 110, 116)
$flat.Dispose()
Set-BrandTile -Graphics $small.Graphics -Bounds (New-Object System.Drawing.Rectangle 8, 8, 94, 100) -RadiusRatio 0.20
Write-Png -Bitmap $small.Bitmap -Path (Join-Path $assets 'wizard-small.png') | Out-Null
$small.Graphics.Dispose()
$small.Bitmap.Dispose()

# --- Wizard side panel (240x459 area, drawn at 2x) ---------------------------
$large = New-GradientCanvas 480 918
$g = $large.Graphics
# Faint horizontal grid, like the terminal's chart backdrop.
$grid = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(46, 41, 70, 59)), ([single]2)
$grid.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dash
for ($y = 150; $y -lt 700; $y += 62) { $g.DrawLine($grid, 40, $y, 440, $y) }
$grid.Dispose()
Set-CandleField -Graphics $g -Width 480 -Height 918 -Count 7 -TopRatio 0.16 -BottomRatio 0.62 -Color ([System.Drawing.Color]::FromArgb(120, 200, 241, 105)) -Seed 3
Set-CandleField -Graphics $g -Width 480 -Height 918 -Count 11 -TopRatio 0.20 -BottomRatio 0.60 -Color ([System.Drawing.Color]::FromArgb(70, 120, 144, 135)) -Seed 11
# Moving-average sweep across the candles.
$sweep = New-Object System.Drawing.Pen (Get-BrandColor 'lime'), ([single]5)
$sweep.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$sweep.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$points = New-Object 'System.Drawing.PointF[]' 11
for ($i = 0; $i -le 10; $i++) {
  $px = 40 + ($i * 40)
  $py = 620 - ($i * 44) - [Math]::Sin($i * 0.7) * 26
  $points[$i] = New-Object System.Drawing.PointF ([single]$px), ([single]$py)
}
$g.DrawCurve($sweep, $points)
$sweep.Dispose()
$accent = New-Object System.Drawing.SolidBrush (Get-BrandColor 'lime')
$g.FillRectangle($accent, 40, 700, 120, 6)
$accent.Dispose()
Set-BrandTile -Graphics $g -Bounds (New-Object System.Drawing.Rectangle 40, 748, 92, 92) -RadiusRatio 0.20

# Wordmark: the largest size that still fits beside the tile.
$baseFont = New-Object System.Drawing.Font 'Segoe UI', ([single]30), ([System.Drawing.FontStyle]::Bold)
$measured = $g.MeasureString('D-PREDICT', $baseFont)
$baseFont.Dispose()
$wordSize = [single]30
$available = 448 - 150
if ($measured.Width -gt $available) { $wordSize = [single]([Math]::Floor(30 * ($available / $measured.Width))) }
$wordFont = New-Object System.Drawing.Font 'Segoe UI', $wordSize, ([System.Drawing.FontStyle]::Bold)
$wordBrush = New-Object System.Drawing.SolidBrush (Get-BrandColor 'lime')
$wordBox = $g.MeasureString('D-PREDICT', $wordFont)
$tagFont = New-Object System.Drawing.Font 'Segoe UI', ([single]13)
$tagBox = $g.MeasureString('Decision Intelligence Terminal', $tagFont)
$stackTop = 748 + [Math]::Max(0, (92 - ($wordBox.Height + $tagBox.Height)) / 2)
$g.DrawString('D-PREDICT', $wordFont, $wordBrush, [single]150, [single]($stackTop - 6))
$tagBrush = New-Object System.Drawing.SolidBrush (Get-BrandColor 'muted')
$g.DrawString('Decision Intelligence Terminal', $tagFont, $tagBrush, [single]152, [single]($stackTop + $wordBox.Height - 8))
$tagBrush.Dispose()
$tagFont.Dispose()
$wordBrush.Dispose()
$wordFont.Dispose()
Write-Png -Bitmap $large.Bitmap -Path (Join-Path $assets 'wizard-image.png') | Out-Null
$g.Dispose()
$large.Bitmap.Dispose()

# --- Application icon -------------------------------------------------------
$iconSizes = @(16, 24, 32, 48, 64, 128, 256)
$iconEntries = @()
foreach ($size in $iconSizes) {
  $canvas = New-TransparentCanvas $size $size
  $inset = [Math]::Max(0, [int]($size * 0.06))
  $inner = $size - 2 * $inset
  Set-BrandTile -Graphics $canvas.Graphics `
    -Bounds (New-Object System.Drawing.Rectangle $inset, $inset, $inner, $inner) `
    -RadiusRatio ([Math]::Max(0.12, 0.30 - ($size / 1000)))
  $ms = New-Object System.IO.MemoryStream
  $canvas.Bitmap.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $iconEntries += @{ Size = $size; Png = $ms.ToArray() }
  $ms.Dispose()
  $canvas.Graphics.Dispose()
  $canvas.Bitmap.Dispose()
}
$ico = Get-IcoBytes -Entries $iconEntries
[System.IO.File]::WriteAllBytes((Join-Path $assets 'dpredict-icon.ico'), $ico)
Write-Host "wrote $(Join-Path $assets 'dpredict-icon.ico') ($($ico.Length) bytes)"
