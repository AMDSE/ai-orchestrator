Get-Process | Where-Object { $_.Name -like "*language_server*" -or $_.Name -like "*Antigravity*" } | Select-Object Name, Id
