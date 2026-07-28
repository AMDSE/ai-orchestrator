# 设置 UTF-8 编码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$body = [System.Text.Encoding]::UTF8.GetBytes('{"userInput":"做一个简单的番茄工作法计时器网页","mode":"standard"}')
$request = [System.Net.WebRequest]::Create("http://localhost:3000/api/projects")
$request.Method = "POST"
$request.ContentType = "application/json; charset=utf-8"
$request.ContentLength = $body.Length

$stream = $request.GetRequestStream()
$stream.Write($body, 0, $body.Length)
$stream.Close()

$response = $request.GetResponse()
$reader = New-Object System.IO.StreamReader($response.GetResponseStream(), [System.Text.Encoding]::UTF8)
$result = $reader.ReadToEnd()
Write-Host $result
