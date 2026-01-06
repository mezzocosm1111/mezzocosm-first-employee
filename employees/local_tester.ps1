
# Mezzo Local Tester (PowerShell Version)
# Usage:
# $env:OPENAI_API_KEY="sk-..."
# .\mezzo\employees\local_tester.ps1

param (
    [string]$ApiKey = $env:OPENAI_API_KEY
)

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    Write-Host "Error: OPENAI_API_KEY not found." -ForegroundColor Red
    Write-Host "Please set it: `$env:OPENAI_API_KEY='sk-...'"
    exit
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir
$ReadmePath = Join-Path $RootDir "README.md"
$KbPath = Join-Path $RootDir "sops\knowledge_base.md"

if (-not (Test-Path $ReadmePath) -or -not (Test-Path $KbPath)) {
    Write-Host "Error: Critical files missing." -ForegroundColor Red
    exit
}

$SystemPrompt = Get-Content -Path $ReadmePath -Raw -Encoding utf8
$KnowledgeBase = Get-Content -Path $KbPath -Raw -Encoding utf8

$FullSystemMessage = @"
$SystemPrompt

# REFERENCE MATERIAL (KNOWLEDGE BASE)
$KnowledgeBase

# INSTRUCTIONS FOR THIS SESSION
You are running in 'local_tester' mode.
Act exactly as Mezzo.
"@

# API Endpoint
$Url = "https://api.openai.com/v1/chat/completions"

# Init Conversation
$Messages = @(
    @{ role = "system"; content = $FullSystemMessage }
)

Write-Host "--------------------------------------------------" -ForegroundColor Cyan
Write-Host "MEZZO LOCAL TESTER (PowerShell)" -ForegroundColor Cyan
Write-Host "Type 'quit' or 'exit' to stop." -ForegroundColor White
Write-Host "--------------------------------------------------" -ForegroundColor Cyan

while ($true) {
    $UserInput = Read-Host "`nYOU"
    if ($UserInput -in "quit", "exit") { break }

    $Messages += @{ role = "user"; content = $UserInput }

    $Body = @{
        model = "gpt-4"
        messages = $Messages
        temperature = 0.3
    } | ConvertTo-Json -Depth 10 -Compress

    try {
        $Response = Invoke-RestMethod -Uri $Url -Method Post -Headers @{
            "Authorization" = "Bearer $ApiKey"
            "Content-Type"  = "application/json"
        } -Body $Body -ErrorAction Stop

        $Reply = $Response.choices[0].message.content
        Write-Host "`nMEZZO: $Reply" -ForegroundColor Green

        $Messages += @{ role = "assistant"; content = $Reply }
    }
    catch {
        Write-Host "`nError: $($_.Exception.Message)" -ForegroundColor Red
        if ($_.Exception.Response) {
             # Try to read detail
             $Stream = $_.Exception.Response.GetResponseStream()
             $Reader = New-Object System.IO.StreamReader($Stream)
             Write-Host $Reader.ReadToEnd()
        }
    }
}
