# Registers the daily registry sync with Windows Task Scheduler.
#
#   npm run schedule:install     install / update
#   npm run schedule:status      show it
#   npm run schedule:remove      delete it
#
# The daily task takes a full snapshot and reconciles rosters for brokerages
# licensed in the past year. The weekly task adds a deep reconcile across every
# brokerage, which is slower but closes gaps on older firms.

param(
    [string]$Action     = "install",
    [string]$ProjectsTime = "07:00",
    [string]$DailyTime  = "07:15",
    [string]$CrmTime    = "07:45",
    [string]$CrmMidday  = "13:30",
    [string]$WeeklyDay  = "Sunday",
    [string]$WeeklyTime = "04:30"
)

$ErrorActionPreference = "Stop"

$ProjectRoot  = Split-Path -Parent $PSScriptRoot
$ProjectsName = "HLabs DXB Projects Sync"
$DailyName    = "HLabs DXB Registry Sync"
$WeeklyName   = "HLabs DXB Registry Deep Sync"
$CrmName      = "HLabs DXB CRM Sync"
$CrmMiddayName = "HLabs DXB CRM Sync (Midday)"

$AllTasks = @($ProjectsName, $DailyName, $CrmName, $CrmMiddayName, $WeeklyName)
$LogDir       = Join-Path $ProjectRoot "logs"

function Get-NpmCommand {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $npm) { throw "npm not found on PATH." }
    return $npm.Source
}

function Install-SyncTask {
    param([string]$Name, [string]$Script, $Trigger, [string]$LogFile)

    $npm = Get-NpmCommand

    # cmd.exe wrapper so stdout and stderr both land in the log file; Task
    # Scheduler itself captures neither.
    $argument = "/c `"cd /d `"$ProjectRoot`" && `"$npm`" run $Script >> `"$LogFile`" 2>&1`""

    $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $argument -WorkingDirectory $ProjectRoot

    $settings = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -DontStopOnIdleEnd `
        -RunOnlyIfNetworkAvailable `
        -ExecutionTimeLimit (New-TimeSpan -Hours 3) `
        -MultipleInstances IgnoreNew

    # Runs as the logged-in user so it inherits the same environment and .env
    # the manual command uses. No stored password required.
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Trigger `
        -Settings $settings -Principal $principal -Force | Out-Null

    Write-Host "  installed: $Name"
}

switch ($Action.ToLower()) {
    "install" {
        if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

        Write-Host "Installing scheduled syncs for $ProjectRoot"

        Install-SyncTask -Name $ProjectsName -Script "projects:sync:scheduled" `
            -Trigger (New-ScheduledTaskTrigger -Daily -At $ProjectsTime) `
            -LogFile (Join-Path $LogDir "projects-sync.log")

        Install-SyncTask -Name $DailyName -Script "sync:scheduled" `
            -Trigger (New-ScheduledTaskTrigger -Daily -At $DailyTime) `
            -LogFile (Join-Path $LogDir "sync-daily.log")

        # CRM sync runs 30 minutes after the registry sync so that the batches it
        # cuts are built from the leads that arrived this morning, not yesterday's.
        Install-SyncTask -Name $CrmName -Script "crm:scheduled" `
            -Trigger (New-ScheduledTaskTrigger -Daily -At $CrmTime) `
            -LogFile (Join-Path $LogDir "crm-sync.log")

        # A midday run picks up the morning's outreach so batch progress, delay
        # state and target attainment are current before the afternoon.
        Install-SyncTask -Name $CrmMiddayName -Script "crm:scheduled" `
            -Trigger (New-ScheduledTaskTrigger -Daily -At $CrmMidday) `
            -LogFile (Join-Path $LogDir "crm-sync.log")

        Install-SyncTask -Name $WeeklyName -Script "sync:deep" `
            -Trigger (New-ScheduledTaskTrigger -Weekly -DaysOfWeek $WeeklyDay -At $WeeklyTime) `
            -LogFile (Join-Path $LogDir "sync-deep.log")

        Write-Host ""
        Write-Host "Projects sync   daily $ProjectsTime"
        Write-Host "Registry sync   daily $DailyTime"
        Write-Host "CRM sync        daily $CrmTime and $CrmMidday"
        Write-Host "Deep reconcile  $WeeklyDay $WeeklyTime"
        Write-Host "Logs: $LogDir"
    }

    "status" {
        foreach ($name in $AllTasks) {
            $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
            if (-not $task) { Write-Host "$name : not installed"; continue }
            $info = Get-ScheduledTaskInfo -TaskName $name
            Write-Host "$name"
            Write-Host "  state     : $($task.State)"
            Write-Host "  last run  : $($info.LastRunTime)  (result $($info.LastTaskResult))"
            Write-Host "  next run  : $($info.NextRunTime)"
        }
    }

    "remove" {
        foreach ($name in $AllTasks) {
            if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
                Unregister-ScheduledTask -TaskName $name -Confirm:$false
                Write-Host "removed: $name"
            }
        }
    }

    default { throw "Unknown action '$Action'. Use install, status or remove." }
}
