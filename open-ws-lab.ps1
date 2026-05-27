param(
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"

$Port = 5177
$AuthPort = 8787
$HostName = "127.0.0.1"
$Url = "http://${HostName}:${Port}/"
$AuthUrl = "http://${HostName}:${AuthPort}/api/ws-lab-auth"
$Root = Split-Path -Parent $PSCommandPath
$PidFile = Join-Path $Root ".ws-lab-server.pid"
$AuthPidFile = Join-Path $Root ".ws-lab-auth.pid"
$AuthScript = Join-Path $Root "server/start-local-auth.js"
$UsersFile = Join-Path $Root "server/users.json"
$UsersExampleFile = Join-Path $Root "server/users.example.json"

function Test-LocalPort {
  param([int]$PortToCheck)

  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $async = $client.BeginConnect($HostName, $PortToCheck, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(350)) {
      return $false
    }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Get-PythonCommand {
  $python = Get-Command python -ErrorAction SilentlyContinue
  if ($python) {
    return @{
      File = $python.Source
      Args = @("-m", "http.server", "$Port", "--bind", $HostName)
    }
  }

  $py = Get-Command py -ErrorAction SilentlyContinue
  if ($py) {
    return @{
      File = $py.Source
      Args = @("-3", "-m", "http.server", "$Port", "--bind", $HostName)
    }
  }

  throw "Python was not found. Install Python or start any static server in $Root."
}

function Get-NodeCommand {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    return $node.Source
  }

  $codexNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if (Test-Path $codexNode) {
    return $codexNode
  }

  throw "Node.js was not found. Install Node.js or run server/start-local-auth.js manually."
}

function Quote-PowerShellString {
  param([string]$Value)

  return "'" + $Value.Replace("'", "''") + "'"
}

function Start-AuthServer {
  if (-not (Test-Path $AuthScript)) {
    throw "WS Lab auth launcher was not found: $AuthScript"
  }

  if (-not (Test-Path $UsersFile)) {
    if (-not (Test-Path $UsersExampleFile)) {
      throw "WS Lab auth users file was not found: $UsersFile"
    }
    Copy-Item -Path $UsersExampleFile -Destination $UsersFile
  }

  if (Test-LocalPort -PortToCheck $AuthPort) {
    return
  }

  $node = Get-NodeCommand
  $command = @"
`$env:WS_LAB_AUTH_HOST = $(Quote-PowerShellString $HostName)
`$env:WS_LAB_AUTH_PORT = $(Quote-PowerShellString $AuthPort)
`$env:WS_LAB_AUTH_USERS_FILE = $(Quote-PowerShellString $UsersFile)
`$env:WS_LAB_AUTH_SESSION_SECRET = 'local-dev-only-ws-lab-auth-secret-change-before-production'
& $(Quote-PowerShellString $node) $(Quote-PowerShellString $AuthScript)
"@

  $process = Start-Process `
    -FilePath "powershell" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $command) `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -PassThru

  Set-Content -Path $AuthPidFile -Value $process.Id -Encoding ASCII

  $deadline = (Get-Date).AddSeconds(5)
  while (-not (Test-LocalPort -PortToCheck $AuthPort)) {
    if ((Get-Date) -gt $deadline) {
      throw "WS Lab auth server did not start on $AuthUrl."
    }
    Start-Sleep -Milliseconds 120
  }
}

Start-AuthServer

if (-not (Test-LocalPort -PortToCheck $Port)) {
  $command = Get-PythonCommand
  $process = Start-Process `
    -FilePath $command.File `
    -ArgumentList $command.Args `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -PassThru

  Set-Content -Path $PidFile -Value $process.Id -Encoding ASCII

  $deadline = (Get-Date).AddSeconds(5)
  while (-not (Test-LocalPort -PortToCheck $Port)) {
    if ((Get-Date) -gt $deadline) {
      throw "WS Lab static server did not start on $Url."
    }
    Start-Sleep -Milliseconds 120
  }
}

Write-Host "WS Lab: $Url"
Write-Host "WS Lab Auth: $AuthUrl"

if (-not $NoOpen) {
  Start-Process $Url
}
