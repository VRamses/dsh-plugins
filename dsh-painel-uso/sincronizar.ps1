# Sincroniza o plugin com o perfil web do DSH.
#
# O `dsh plugin --profile web add` deixa um HARDLINK entre este diretorio e
# <perfil>\node_modules\dsh-painel-uso. Editar o arquivo "no lugar" mantem o
# vinculo, mas editor (ou ferramenta) que substitui o arquivo quebra o link e a
# copia do perfil fica velha. Rodar isto depois de editar resolve, sem reinstalar.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\sincronizar.ps1
#
# A copia vai para um arquivo temporario e so entao substitui o destino: copiar
# direto por cima pode falhar com "arquivo em uso", porque o watcher de HMR do
# cliente le os bundles, e o retry abaixo cobre essa janela.
#
# Depois: recarregar a pagina do DSH com Ctrl+R.
# NAO use Ctrl+Shift+R: ele reinicia o Harness e mata o turno em curso.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$origem = $PSScriptRoot
$perfil = Join-Path $env:APPDATA 'dsh-desktop\harness\profiles\web'
$destino = Join-Path $perfil 'node_modules\dsh-painel-uso'

if (-not (Test-Path -LiteralPath $destino)) {
  throw "Plugin nao instalado no perfil ($destino). Rode antes: node `"<dsh bin>`" plugin --profile web add `"file:$origem`""
}

$arquivos = @('client.js', 'index.js', 'package.json', 'README.md')
foreach ($arquivo in $arquivos) {
  $de = Join-Path $origem $arquivo
  $para = Join-Path $destino $arquivo
  $temporario = Join-Path $destino ($arquivo + '.novo')

  Copy-Item -LiteralPath $de -Destination $temporario -Force

  $tentativa = 0
  while ($true) {
    try {
      Move-Item -LiteralPath $temporario -Destination $para -Force
      break
    } catch {
      $tentativa++
      if ($tentativa -ge 5) {
        Remove-Item -LiteralPath $temporario -Force -ErrorAction SilentlyContinue
        throw "Nao consegui substituir $arquivo depois de 5 tentativas: $($_.Exception.Message)"
      }
      Start-Sleep -Milliseconds 400
    }
  }

  $hashOrigem = (Get-FileHash -LiteralPath $de).Hash
  $hashDestino = (Get-FileHash -LiteralPath $para).Hash
  $estado = if ($hashOrigem -eq $hashDestino) { 'ok' } else { 'DIVERGENTE' }
  Write-Output ("{0}  {1}  {2}" -f $hashDestino.Substring(0, 16), $estado, $arquivo)
}

Write-Output ''
Write-Output 'Sincronizado. Recarregue a pagina do DSH com Ctrl+R (Ctrl+Shift+R reinicia o Harness e mata o turno em curso).'
