# Hosted GPU worker for the existing Studio

Status: deployment configuration prepared; a GPU host has not been provisioned.
For the free-only route, supply a school-owned, university-owned or donated GPU
host. No paid cloud instance is created or required by this package.
The website continues to use its existing authenticated queue and private storage.
This worker polls the queue over HTTPS, so it requires no public inference port,
new browser credentials, or website URL change. Running it continuously removes
the need for a researcher to start a local worker for each session.

## Host requirements

Use a Linux NVIDIA GPU VM with Docker Engine, Docker Compose, the NVIDIA driver,
and NVIDIA Container Toolkit configured. Start with 8+ GB GPU memory, 16+ GB RAM,
4 CPU cores, and 50+ GB local SSD; these are starting specifications, not a
measured performance guarantee. Data locality matters: place the worker near
private object storage and test actual download speed. Use one worker per GPU.
Provider, region, account access, and spending limit must be selected before
provisioning. No paid resources have been created by this change.

## Prepare the private model directory

Copy the four original .pt files and reliability_candidate/ensemble.joblib into
the directory set by MODEL_DIRECTORY. Never put these files or credentials in
the public repository or container image. The worker verifies all checkpoint
and frozen source SHA-256 hashes and the exact decision threshold before it can
claim any job. Keep the full original model directory as the private source.

Copy .env.gpu.example to .env.gpu on the host. Populate the existing project's
SUPABASE_URL, a workspace-scoped WORKER_TOKEN, and a unique WORKER_ID through the
host's private configuration. Restrict .env.gpu to the server administrator.
Do not use a Supabase service-role key in this worker or in the browser.

## Build and verify without claiming jobs

From the inference-worker directory on the server:

```sh
docker compose --env-file .env.gpu -f compose.gpu.yaml build
docker compose --env-file .env.gpu -f compose.gpu.yaml run --rm worker --check --require-gpu
```

This verifies CUDA, native slide-reading libraries, model identity, and stacker
settings. It does not read, claim, or submit Studio jobs. Build and Linux smoke
checks still need to be run on a host with Docker; they were not run on the
Windows workstation, which has no Docker installation.

## Start serving the Studio queue

Starting the following service lets it process already queued slides. Choose
the handover time and stop the old local worker first if only one worker should
serve this workspace. Existing lease checks prevent two workers claiming the
same active job.

```sh
docker compose --env-file .env.gpu -f compose.gpu.yaml up -d
docker compose --env-file .env.gpu -f compose.gpu.yaml logs --tail=100 -f
```

The service restarts after a host reboot, requires CUDA, batches transfers while
retaining the reference forward shape,
and stores verified inputs and versioned patch caches on its persistent volume.
One resident inference child retains the appearance models and CPU graph expert
between jobs, avoiding repeated Python imports and checkpoint loading. Models
reload when verified identities change. Failure or lease loss stops that child.
The browser's existing progress bar and stage ETA continue to work. Total-time
profiles from the previous batch-one implementation are deliberately ignored.
Temporary heartbeat failures are tolerated only inside the valid lease window;
revocation or expiry stops processing. Retried artifact transfers reopen files
from the beginning. Model computation is independent of transfer retries.

## Stop and update

```sh
docker compose --env-file .env.gpu -f compose.gpu.yaml stop
```

Stopping during a job preserves committed patches. A subsequent user-controlled
retry can reuse the verified input and matching cache. Before deploying code
updates, stop this service, update source, rebuild, run --check, then start it.
Do not use `down -v` unless intentionally deleting private cache data. Monitor
disk space and remove private completed-job caches according to lab retention
policy; no automated retention policy is introduced here.

## Performance and validation

The reference frozen source, model weights, tissue heuristic, sampling scale,
all four experts, graph limits, and decision threshold remain fixed. GPU batch
kernels can differ numerically from batch-one kernels. Fully vectorized inference
is experimental and excluded from the serving worker because sampled patch and
feature checks exceeded their declared tolerance. Compare real sampled
tissue scores and features, then the complete graph and slide prediction before
accepting an optimized deployment. Linux and a different GPU need their own
validation; Windows timing cannot certify that host.

Record upload, queue, download, preparation, patches, graph, and artifact transfer
separately. A five-minute upload-to-report guarantee cannot be made independently
of slide size, upload bandwidth, queue load, and server hardware. Do not reduce
tissue coverage or graph nodes silently to meet a timer.

References: https://docs.docker.com/compose/how-tos/gpu-support/
and https://openslide.org/api/python/
