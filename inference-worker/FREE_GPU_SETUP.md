# Use the existing RTX 3050 as the Studio GPU server

This route adds no GPU hosting subscription. It uses the laboratory computer's
hardware, electricity, disk and internet. GitHub Pages, Supabase and private
storage keep their existing configuration and usage limits. Researchers can
continue using the website from another device; only the laboratory computer
needs the model files and Python installation.

The computer must stay on, awake and connected. This is not an always-available
cloud server. The worker makes outbound HTTPS connections; no port forwarding,
public Python endpoint, or browser worker secret is needed.

## Check first without processing the queue

From the Kean Folder:

```powershell
.\stegasus\.venv\Scripts\python.exe .\sites\STEGASUS\inference-worker\worker.py --check --require-gpu --run .\stegasus-pcam\runs\20261030_234916_956062
```

## Start manually

Stop any old worker with Ctrl+C first. Then, from sites/STEGASUS:

```powershell
.\inference-worker\start-worker.ps1 -Pipeline direct -BatchSize 8 -ReadWorkers 2
```

Starting the worker can process already queued jobs. The agent does not start or
retry Studio jobs during implementation. Input caching now defaults to
LOCALAPPDATA/STEGASUS/worker-cache, outside OneDrive. The new implementation uses
outputs-direct-gpu-v3 beneath each job, preserving old outputs separately.
The same input, model, runtime, GPU and settings can resume committed patches.
Different implementation or batch settings need a fresh matching output folder.

## Optional automatic startup at sign-in

The scripts below are prepared but installation does not run automatically.
From sites/STEGASUS, install a task for the current Windows user:

```powershell
.\inference-worker\install-worker-task.ps1
```

This registers a hidden worker at your next sign-in; it does not start one now.
The computer must remain signed in. It does not install an administrator service,
change sleep settings or open firewall ports. To explicitly start it now after
stopping an old foreground worker:

```powershell
Start-ScheduledTask -TaskName 'STEGASUS GPU Worker'
Get-ScheduledTaskInfo -TaskName 'STEGASUS GPU Worker'
```

To stop it and its Python child processes, use Task Scheduler's End action and
verify no worker remains running; if using the foreground command, Ctrl+C stops
the worker cleanly. To prevent future starts:

```powershell
Disable-ScheduledTask -TaskName 'STEGASUS GPU Worker'
```

Task output is recorded in LOCALAPPDATA/STEGASUS/worker-logs. Private .env values
are not printed. Logs and completed slide caches remain local until removed
under the laboratory's retention policy. The background task uses batch 8 and
two reader threads. Change run-worker-service.ps1 before installing if needed.

## Free cloud alternative and limits

Hugging Face ZeroGPU currently permits up to two free Gradio Spaces for eligible
personal accounts (verified email, account older than 30 days). Free signed-in
users receive five minutes of GPU quota per day; allocation is shared and queued.
It requires adapting execution to Gradio's GPU-decorated functions; the polling
Docker worker cannot simply be deployed there unchanged. It is an option for a
limited demo, not a guaranteed always-on Studio worker. No Hugging Face Space or
paid GPU resources have been created.

Source checked 2026-11-20: https://huggingface.co/docs/hub/spaces-zerogpu

The optional Linux Docker package in GPU_DEPLOYMENT.md is retained for a future
school-owned or donated GPU host. No paid host is needed for this selected route.
