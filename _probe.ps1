$p = Get-CimInstance Win32_Process -Filter "Name='node.exe'";
$out = $p | ForEach-Object { "PID $($_.ProcessId) START $($_.CreationDate.ToString('HH:mm:ss')) CMD $($_.CommandLine.Substring(0, [Math]::Min(100, $_.CommandLine.Length)))" };
$out | Out-File -FilePath 'C:/Users/yufei/WorkBuddy/2048/_probe_out.txt' -Encoding utf8;
