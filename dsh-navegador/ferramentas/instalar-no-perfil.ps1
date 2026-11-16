# Instala (ou atualiza) o plugin dsh-navegador no perfil web do DSH Desktop,
# do jeito que os outros add-ons do Ramses sao instalados: juncao em
# node_modules, dependencia `file:` no package.json do perfil e bloco no
# cordis.patch.yml ANTES da sentinela dos MCPs.
#
# Uso: pwsh -File instalar-no-perfil.ps1
#      pwsh -File instalar-no-perfil.ps1 -Perfil web -Conferir
#
# O patch do perfil e `patchReload: live`, entao o host monta o plugin sozinho
# depois da insercao. Se o /ola nao responder, feche e reabra o DSH.

[CmdletBinding()]
param(
    [string]$DshHome = '',
    [string]$Perfil = 'web',
    [string]$Fonte = '',
    [switch]$Conferir,
    [switch]$SemPatch
)

$ErrorActionPreference = 'Stop'

# `$MyInvocation.MyCommand.Path` fica VAZIO na avaliacao do valor padrao de um
# parametro (armadilha ja registrada na memoria do vault), entao a fonte e
# resolvida aqui, no corpo, a partir de `$PSScriptRoot`.
if (-not $Fonte) {
    if (-not $PSScriptRoot) { throw 'nao consegui descobrir a pasta do script; passe -Fonte na mao' }
    $Fonte = Split-Path -Parent $PSScriptRoot
}

$SENTINELA = '# MCPs hospedados no host central (mcp-host/host.py).'
$ID_PATCH = 'dsh-navegador'
$PACOTE = 'dsh-navegador'

function Info($texto, $cor = 'Gray') { Write-Host $texto -ForegroundColor $cor }

if (-not $DshHome) {
    if ($env:DSH_HOME -and (Test-Path -LiteralPath $env:DSH_HOME)) { $DshHome = $env:DSH_HOME }
    else { $DshHome = Join-Path $env:APPDATA 'dsh-desktop\harness' }
}
if (-not (Test-Path -LiteralPath $DshHome)) { throw "nao achei o harness do DSH em $DshHome" }

$perfilDir = Join-Path $DshHome "profiles\$Perfil"
if (-not (Test-Path -LiteralPath $perfilDir)) { throw "nao achei o perfil em $perfilDir" }
if (-not (Test-Path -LiteralPath (Join-Path $Fonte 'package.json'))) { throw "a fonte nao tem package.json: $Fonte" }

$patch = Join-Path $perfilDir 'cordis.patch.yml'
$pacoteJson = Join-Path $perfilDir 'package.json'
$link = Join-Path $perfilDir "node_modules\$PACOTE"
$fonteAbs = (Resolve-Path -LiteralPath $Fonte).Path

Info "fonte : $fonteAbs"
Info "perfil: $perfilDir"

if ($Conferir) {
    $tipoLink = 'ausente'
    if (Test-Path -LiteralPath $link) {
        $item = Get-Item -LiteralPath $link -Force
        if ($item.LinkType) { $tipoLink = $item.LinkType } else { $tipoLink = 'pasta' }
    }
    $temPatch = (Get-Content -LiteralPath $patch -Raw) -match [regex]::Escape("- id: $ID_PATCH")
    $temDep = (Get-Content -LiteralPath $pacoteJson -Raw) -match [regex]::Escape('"' + $PACOTE + '"')
    Info ''
    Info "juncao  : $tipoLink"
    Info "patch   : $(if ($temPatch) { 'registrado' } else { 'ausente' })"
    Info "depend. : $(if ($temDep) { 'registrada' } else { 'ausente' })"
    exit 0
}

$carimbo = Get-Date -Format 'yyyyMMdd-HHmmss'

# 1. juncao (ou pasta real, se ja existir)
if (Test-Path -LiteralPath $link) {
    $item = Get-Item -LiteralPath $link -Force
    if ($item.LinkType -eq 'Junction') {
        $alvoAtual = ($item.Target | Select-Object -First 1)
        if ($alvoAtual -ne $fonteAbs) {
            Remove-Item -LiteralPath $link -Force
            New-Item -ItemType Junction -Path $link -Target $fonteAbs | Out-Null
            Info "juncao refeita: $link -> $fonteAbs" Green
        } else {
            Info 'juncao ja aponta para a fonte' 'DarkGray'
        }
    } else {
        Info "existe uma pasta real em $link ; deixo como esta" Yellow
    }
} else {
    New-Item -ItemType Junction -Path $link -Target $fonteAbs | Out-Null
    Info "juncao criada: $link -> $fonteAbs" Green
}

# 2. dependencia `file:` no package.json do perfil
$textoPacote = Get-Content -LiteralPath $pacoteJson -Raw
if ($textoPacote -notmatch [regex]::Escape('"' + $PACOTE + '"')) {
    Copy-Item -LiteralPath $pacoteJson -Destination "$pacoteJson.bak-antes-$ID_PATCH-$carimbo" -Force
    $objeto = $textoPacote | ConvertFrom-Json
    if ($null -eq $objeto.dependencies) { $objeto | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
    $objeto.dependencies | Add-Member -NotePropertyName $PACOTE -NotePropertyValue ("file:" + ($fonteAbs -replace '\\', '/')) -Force
    $novo = $objeto | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($pacoteJson, $novo, (New-Object System.Text.UTF8Encoding($false)))
    Info "dependencia registrada no package.json do perfil" Green
} else {
    Info 'dependencia ja registrada' 'DarkGray'
}

# 3. bloco no cordis.patch.yml, antes da sentinela
if (-not $SemPatch) {
    $textoPatch = Get-Content -LiteralPath $patch -Raw
    if ($textoPatch -match [regex]::Escape("- id: $ID_PATCH")) {
        Info 'bloco ja esta no patch' 'DarkGray'
    } else {
        $indice = $textoPatch.IndexOf($SENTINELA)
        if ($indice -lt 0) { throw "nao achei a sentinela dos MCPs em $patch ; inserir depois dela perderia o bloco" }
        Copy-Item -LiteralPath $patch -Destination "$patch.bak-antes-$ID_PATCH-$carimbo" -Force
        $bloco = @"
# ${PACOTE}: ponte local entre o DSH e o add-on do navegador (Opera/Chromium).
# Expoe rotas com token proprio em /dsh-navegador (loopback) e registra as
# ferramentas navegador_ler e navegador_agir para o agente trabalhar na aba.
# Fonte e documentacao: $fonteAbs
# Fica DE PROPOSITO antes da sentinela "MCPs hospedados no host central": o
# instalar-cliente.ps1 reescreve tudo o que vem depois dela.
- insert:
    - id: $ID_PATCH
      name: '$PACOTE'

"@
        $novo = $textoPatch.Substring(0, $indice) + $bloco + $textoPatch.Substring($indice)
        [System.IO.File]::WriteAllText($patch, $novo, (New-Object System.Text.UTF8Encoding($false)))
        Info 'bloco inserido no patch, antes da sentinela' Green
    }
}

Info ''
Info 'OK. O patch e live: em alguns segundos o host monta a ponte.' Green
Info 'Confira com: curl.exe -s http://127.0.0.1:43129/dsh-navegador/ola' 'DarkGray'
