$lsPid = (Get-Process language_server).Id
Write-Host "language_server PID: $lsPid"
$connections = netstat -ano | Select-String "LISTENING" | Select-String " $lsPid$"
Write-Host "Listening ports:"
$connections
