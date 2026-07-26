Add-Type @"
using System.Net;
using System.Security.Cryptography.X509Certificates;
public class BypassSSL : ICertificatePolicy {
    public bool CheckValidationResult(ServicePoint sp, X509Certificate cert, WebRequest req, int problem) { return true; }
}
"@
[System.Net.ServicePointManager]::CertificatePolicy = New-Object BypassSSL
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Write-Host "=== HTTPS Port 10655 ==="
foreach ($path in @("/", "/api", "/v1", "/v1/chat", "/api/agent/chat", "/agent/v1/chat/completions")) {
    try {
        $r = Invoke-WebRequest -Uri "https://localhost:10655$path" -Method GET -TimeoutSec 3 -ErrorAction Stop
        Write-Host "[$path] $($r.StatusCode): $($r.Content.Substring(0, [Math]::Min(300, $r.Content.Length)))"
    } catch {
        $msg = $_.Exception.Message
        $resp = ""
        if ($_.Exception.Response) {
            try {
                $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                $resp = $reader.ReadToEnd()
            } catch {}
        }
        Write-Host "[$path] ERR: $($msg.Substring(0, [Math]::Min(80,$msg.Length))) | Body: $($resp.Substring(0,[Math]::Min(200,$resp.Length)))"
    }
}

Write-Host "`n=== HTTPS Port 10656 ==="
foreach ($path in @("/", "/api", "/v1/chat/completions")) {
    try {
        $r = Invoke-WebRequest -Uri "https://localhost:10656$path" -Method GET -TimeoutSec 3 -ErrorAction Stop
        Write-Host "[$path] $($r.StatusCode): $($r.Content.Substring(0, [Math]::Min(300, $r.Content.Length)))"
    } catch {
        $msg = $_.Exception.Message
        $resp = ""
        if ($_.Exception.Response) {
            try {
                $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                $resp = $reader.ReadToEnd()
            } catch {}
        }
        Write-Host "[$path] ERR: $($msg.Substring(0, [Math]::Min(80,$msg.Length))) | Body: $($resp.Substring(0,[Math]::Min(200,$resp.Length)))"
    }
}
