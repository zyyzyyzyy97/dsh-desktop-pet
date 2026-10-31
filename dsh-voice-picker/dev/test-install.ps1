# 安装脚本干跑测试：在临时目录伪造一个 web profile，端到端跑 install-voice-picker.ps1，
# 验证拷贝/注册/junction/幂等，全程绝不碰真实 profile。
$ErrorActionPreference = 'Stop'
$t = Join-Path $env:TEMP ("vp-install-test-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$prof = Join-Path $t '.dsh\profiles\web'
New-Item -ItemType Directory -Force -Path (Join-Path $prof 'plugins') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $prof 'node_modules') | Out-Null
$pkg = [ordered]@{
  name = 'dsh-profile-web'
  private = $true
  dependencies = [ordered]@{ 'dsh-meme' = '0.1.68' }
  dsh = [ordered]@{ profile = [ordered]@{ bundles = @('dsh-base', 'dsh-meme') } }
}
$json = $pkg | ConvertTo-Json -Depth 32
[System.IO.File]::WriteAllText((Join-Path $prof 'package.json'), $json, [System.Text.UTF8Encoding]::new($false))

$fails = 0
function Check($name, $ok) { if ($ok) { Write-Host "  OK $name" } else { $script:fails++; Write-Host "  FAIL $name" } }

Write-Host '[run 1] 首次安装'
& "$PSScriptRoot\..\install-voice-picker.ps1" -ProfileName web -HomeDir $t | Out-Null

Check '插件目录已拷贝（src/index.js 存在）' (Test-Path (Join-Path $prof 'plugins\dsh-voice-picker\src\index.js'))
$pkg2 = Get-Content (Join-Path $prof 'package.json') -Raw | ConvertFrom-Json
Check 'dependencies 已注册' ($pkg2.dependencies.PSObject.Properties['dsh-voice-picker'] -and $pkg2.dependencies.'dsh-voice-picker' -eq 'link:plugins/dsh-voice-picker')
Check '原有依赖保留（dsh-meme）' ($pkg2.dependencies.PSObject.Properties['dsh-meme'] -ne $null)
Check 'bundles 已追加' ($pkg2.dsh.profile.bundles -contains 'dsh-voice-picker')
Check '原有 bundles 保留（dsh-base 在前）' ($pkg2.dsh.profile.bundles[0] -eq 'dsh-base' -and $pkg2.dsh.profile.bundles[1] -eq 'dsh-meme')
Check 'bundle 无重复' (@($pkg2.dsh.profile.bundles | Where-Object { $_ -eq 'dsh-voice-picker' }).Count -eq 1)
Check 'package.json 无 BOM' (([IO.File]::ReadAllBytes((Join-Path $prof 'package.json'))[0] -ne 0xEF))
$link = Get-Item (Join-Path $prof 'node_modules\dsh-voice-picker') -ErrorAction SilentlyContinue
Check 'junction 已建' ($link -and $link.LinkType -eq 'Junction' -and $link.Target -like '*plugins\dsh-voice-picker')

Write-Host '[run 2] 重复安装（幂等）'
& "$PSScriptRoot\..\install-voice-picker.ps1" -ProfileName web -HomeDir $t | Out-Null
$pkg3 = Get-Content (Join-Path $prof 'package.json') -Raw | ConvertFrom-Json
Check '二次安装 bundle 仍无重复' (@($pkg3.dsh.profile.bundles | Where-Object { $_ -eq 'dsh-voice-picker' }).Count -eq 1)
Check '二次安装生成 package.json 备份' ((Get-ChildItem (Join-Path $prof 'package.json.bak-*')).Count -ge 1)
Check '二次安装生成插件目录备份' ((Get-ChildItem (Join-Path $prof 'plugins') -Filter 'dsh-voice-picker.bak-*').Count -ge 1)

Remove-Item $t -Recurse -Force -ErrorAction SilentlyContinue
if ($fails -gt 0) { Write-Host "[FAIL] $fails 项未通过"; exit 1 }
Write-Host '[PASS] 安装脚本干跑全部通过（含幂等）'
