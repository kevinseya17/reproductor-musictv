$env:PORT = "3001"
$logFile = "$PSScriptRoot\tunnel.log"
$urlFile = "$PSScriptRoot\tunnel_url.txt"

if (Test-Path $logFile) { Remove-Item $logFile -Force }
if (Test-Path $urlFile) { Remove-Item $urlFile -Force }

# Iniciar servidor Node.js en puerto 3001
$nodeProc = Start-Process -FilePath "node.exe" -ArgumentList "server.js" -WorkingDirectory $PSScriptRoot -PassThru -NoNewWindow

Start-Sleep -Seconds 3

# Iniciar túnel Cloudflare seguro HTTPS
$tunnelProc = Start-Process -FilePath "npx.cmd" -ArgumentList "-y cloudflared tunnel --url http://localhost:3001" -WorkingDirectory $PSScriptRoot -PassThru -NoNewWindow -RedirectStandardError $logFile

# Esperar asignación de la URL pública
$tunnelUrl = $null
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $logFile) {
        $match = Get-Content $logFile | Select-String -Pattern "https://[a-zA-Z0-9\-]+\.trycloudflare\.com"
        if ($match) {
            $tunnelUrl = $match.Matches[0].Value
            $tunnelUrl | Out-File -FilePath $urlFile -Encoding utf8
            Write-Host "ONLINE_URL: $tunnelUrl"
            break
        }
    }
}

# Mantener procesos vivos
Wait-Process -Id $nodeProc.Id, $tunnelProc.Id
