Write-Host "=== Port 10655 ==="
try {
    $r = Invoke-WebRequest -Uri "http://localhost:10655/" -Method GET -TimeoutSec 3 -ErrorAction Stop
    Write-Host "Status: $($r.StatusCode)"
    Write-Host "Content-Type: $($r.Headers['Content-Type'])"
    Write-Host "Body (first 500): $($r.Content.Substring(0, [Math]::Min(500, $r.Content.Length)))"
} catch {
    Write-Host "Error: $($_.Exception.Message)"
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        Write-Host "Response: $($reader.ReadToEnd())"
    }
}

Write-Host "`n=== Port 10656 ==="
try {
    $r = Invoke-WebRequest -Uri "http://localhost:10656/" -Method GET -TimeoutSec 3 -ErrorAction Stop
    Write-Host "Status: $($r.StatusCode)"
    Write-Host "Body (first 500): $($r.Content.Substring(0, [Math]::Min(500, $r.Content.Length)))"
} catch {
    Write-Host "Error: $($_.Exception.Message)"
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        Write-Host "Response: $($reader.ReadToEnd())"
    }
}

Write-Host "`n=== Try /api on both ==="
foreach ($port in @(10655, 10656)) {
    foreach ($path in @("/api", "/v1/chat", "/chat", "/agent", "/api/agent")) {
        try {
            $r = Invoke-WebRequest -Uri "http://localhost:$port$path" -Method GET -TimeoutSec 2 -ErrorAction Stop
            Write-Host "[$port$path] Status: $($r.StatusCode) Body: $($r.Content.Substring(0, [Math]::Min(200, $r.Content.Length)))"
        } catch {
            Write-Host "[$port$path] $($_.Exception.Message.Substring(0, [Math]::Min(60, $_.Exception.Message.Length)))"
        }
    }
}
