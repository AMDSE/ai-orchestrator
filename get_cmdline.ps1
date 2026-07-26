# 从 language_server 进程命令行获取 HTTP 端口和 CSRF token
$ls = Get-WmiObject Win32_Process | Where-Object { $_.Name -eq "language_server.exe" }
if ($ls) {
    Write-Host "CommandLine:"
    Write-Host $ls.CommandLine
} else {
    Write-Host "language_server.exe not found"
}
