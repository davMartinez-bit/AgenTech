# Levanta AgenTech en este computador (solo local): base de datos, Ollama, API y paneles.
#   powershell -ExecutionPolicy Bypass -File src\levantar_local.ps1
# Luego abre http://localhost:5173

$ErrorActionPreference = "Stop"
$src = $PSScriptRoot

# 1. Base de datos (Docker Desktop debe estar abierto)
Write-Host "1/4 Base de datos..."
docker compose -f "$src\docker-compose.yml" up -d db | Out-Null

# 2. Ollama con los modelos guardados en D:
Write-Host "2/4 Ollama..."
if (-not $env:OLLAMA_MODELS) { $env:OLLAMA_MODELS = [Environment]::GetEnvironmentVariable("OLLAMA_MODELS", "User") }
try { Invoke-RestMethod http://127.0.0.1:11434/api/tags -TimeoutSec 3 | Out-Null }
catch { Start-Process ollama -ArgumentList serve -WindowStyle Hidden; Start-Sleep -Seconds 5 }

# 3. Dependencias (solo la primera vez)
foreach ($app in "api", "web") {
    if (-not (Test-Path "$src\$app\node_modules")) {
        Write-Host "    Instalando dependencias de $app..."
        npm --prefix "$src\$app" install --no-audit --no-fund | Out-Null
    }
}

# 4. API y paneles, cada uno en su ventana
Write-Host "3/4 API en http://localhost:3000 (documentación en /docs)"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "npm --prefix '$src\api' run dev"
Write-Host "4/4 Paneles en http://localhost:5173"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "npm --prefix '$src\web' run dev"

Start-Sleep -Seconds 6
Start-Process "http://localhost:5173"
