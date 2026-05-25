param(
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"

$Port = 5177
$HostName = "127.0.0.1"
$Url = "http://${HostName}:${Port}/"
$Root = Split-Path -Parent $PSCommandPath
$PidFile = Join-Path $Root ".ws-lab-server.pid"

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

if (-not $NoOpen) {
  Start-Process $Url
}
