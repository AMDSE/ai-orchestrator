$r = Invoke-RestMethod "http://localhost:3000/api/projects/cbf1a0ee-9a93-46fe-84af-c3626d26030e"
Write-Host "status:   $($r.status)"
Write-Host "progress: $($r.progress)%"
Write-Host "tasks:    $($r.tasks.Count)"
if ($r.plan.title) { Write-Host "title:    $($r.plan.title)" }
if ($r.plan.summary) { Write-Host "summary:  $($r.plan.summary)" }
Write-Host "messages: $($r.messages.Count)"
if ($r.messages.Count -gt 0) {
    foreach ($m in $r.messages) {
        Write-Host "  [$($m.role)] $($m.content.Substring(0, [Math]::Min(80, $m.content.Length)))..."
    }
}
