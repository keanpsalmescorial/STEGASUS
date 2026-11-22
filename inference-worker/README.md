# STEGASUS GPU worker

For a no-subscription deployment on an existing laboratory GPU, see
[FREE_GPU_SETUP.md](FREE_GPU_SETUP.md) for startup and optional Windows sign-in
automation. To remove reliance on the researcher's personal computer, an
institution-provided Linux GPU can use [GPU_DEPLOYMENT.md](GPU_DEPLOYMENT.md).
Neither installation nor publication starts a worker or queues/retries a slide.

## Studio progress and time estimates

Restarting the worker loads progress reporting for both processing paths. It sends
stage, counts and measured elapsed time with fenced job heartbeats every ten seconds;
the Studio refreshes every five seconds. Progress bars describe the current stage,
not a fabricated percentage of total inference. Upload and download estimates use
observed throughput; patch estimates use new work since the first observed batch.
Graph processing remains indeterminate without measured comparable job timings.
A total time estimate for the reference pipeline uses at least three successful jobs on the same worker and
pipeline with file sizes within 25 percent. This is approximate: tissue content and
hardware load can differ. Expired predictions revert to calculating rather than zero.
Stale telemetry pauses estimates. Failed and queued jobs have no countdown.
Telemetry is stored inside the existing protected job result metadata while processing;
only completed jobs have prediction results. No database privileges were added.
Five minutes is a user-facing target, not an achieved benchmark or a timeout. Jobs
continue after exceeding it. No slide resolution, tissue coverage or models are reduced
to meet this target. Publication does not restart workers or submit jobs.

## Default optimized direct-slide path

The frozen pipeline already reads coordinates directly from OpenSlide and stores
scores/features in SQLite; its progress message does not represent separate tile
image files. `direct_pipeline.py` preserves that pixel contract while processing
batches, retaining the three appearance models on the available device and
committing one transaction per batch. The direct-gpu-v3 implementation uses
FP32 reference-shape forward passes with consolidated GPU transfers, batches accepted tissue rather than background,
and overlaps bounded CPU patch reading with GPU inference. Each reader has its
own OpenSlide handle. CUDA OOM splits a batch without discarding patches. Small
floating-point differences are assessed with declared regression tolerances;
bitwise equivalence is checked where practical. Mixed precision is not enabled.
Fully vectorized forwards are implemented behind --experimental-vectorized in
direct_pipeline.py, but not used by the Studio worker: 128 real tissue patches
exceeded the declared patch/feature regression gates despite passing the sampled
graph and ensemble comparison. See benchmarks/rtx3050-vectorized-candidate.json.
It retains the original physical scale,
96-pixel resize, tissue heuristic, coordinate order, max pooling, graph policy,
20,000-node limit, stacker, threshold and output artifact formats. Frozen source
and weights are unchanged. This is an independently implemented optimization;
CLAM's coordinate-reading design is documented at https://github.com/mahmoodlab/CLAM.

Run regression checks without accessing the queue:

~~~powershell
& '..\..\stegasus\.venv\Scripts\python.exe' -m unittest discover -s inference-worker -p 'test_*.py' -v
& '..\..\stegasus\.venv\Scripts\python.exe' inference-worker/check_batch_equivalence.py --run '..\..\stegasus-pcam\runs\20261030_234916_956062'
~~~

The default worker is now `direct`; the untouched reference can be selected with
`--pipeline frozen` on Windows. Real-slide numerical checks and timing are in
`benchmark_gpu.py`; sampled checks alone do not establish complete-slide
equivalence or behavior on near-threshold slides. A complete-slide acceptance
comparison is required before claiming unchanged performance across a dataset.

Historical validation on 20 November 2026 of the earlier batch-one implementation
produced exact agreement on nine synthetic patches. That result does not certify
the new vectorized implementation; use its own benchmark report instead.

To opt in after stopping the existing worker with Ctrl+C, run from this repository:

~~~powershell
.\inference-worker\start-worker.ps1 -Pipeline direct -BatchSize 8 -ReadWorkers 2
~~~

This command claims existing queued jobs. Do not run a second worker with the same
worker ID. The Windows launcher enables private persistent caching by default: it retains downloaded slides,
coordinates, scores and features until manually removed, including after completion.
Choose a local disk outside OneDrive with sufficient space. Complete downloads are
verified by SHA-256 before reuse; partial downloads are discarded. A per-job OS
lock excludes concurrent cache writers. Processing manifests bind cached batches to
the slide, model hashes, implementation, batch size and preprocessing. Changed
settings require a new compatible output directory. With an empty `-CacheDirectory`, the worker uses
temporary storage and cannot resume between claimed attempts. Local `--slide` mode
in direct processing can resume the same `--output` directory.

No queue jobs are reset or retried by installing these files. Existing worker
processes must be restarted to load changes. Transient heartbeat failures are
tolerated within the confirmed lease window; expiry, revocation and permanent API
errors stop processing. Artifact upload and completion retries do not rerun models.

Run from a Windows laboratory computer with CPython 3.12, the listed dependencies and the private frozen run directory. The original WSI entry point uses Windows file locking. Its three source modules are included byte-for-byte. Every source module, all four model checkpoints and the calibrated stacker must match the study hash manifest before any job can be claimed. Treat checkpoints and the joblib file as trusted executable inputs. Keep them outside the web root and Git repository.

## Local setup and verification

In the original Kean Folder checkout, use the existing laboratory environment.

~~~powershell
$python = '.\stegasus\.venv\Scripts\python.exe'
$worker = '.\sites\STEGASUS\inference-worker'
$run = (Resolve-Path '.\stegasus-pcam\runs\20261030_234916_956062').Path
& $python "$worker\worker.py" --check --run $run
& $python "$worker\check_replay.py" --run $run --slide '.\stegasus-pcam\data\wsi\test_018.tif' --reference '.\stegasus-pcam\wsi_results\test_018'
~~~

For another Windows machine install the matching PyTorch and torchvision builds, then run `python -m pip install -r requirements.txt` in an isolated venv. Restore these private run files from the laboratory store:

- efficientnet_b0.pt
- mobilevit_xxs.pt
- resnet50.pt
- spatial_graph_expert.pt
- reliability_candidate/ensemble.joblib

For a fresh individual slide run, use `python worker.py --run MODEL_DIRECTORY --slide PATH_TO_TIFF --output NEW_DIRECTORY`. Accepted inputs are research TIFFs (.tif, .tiff) supported by OpenSlide with embedded positive X/Y physical scales. The published decision threshold rounds to 0.628536. Classification uses 0.6285356451984643 from the frozen stacker. An unsupported slide, zero accepted tissue, or a graph larger than the original 20,000-node default stops the job. Outputs include four expert scores, a threshold flag, a tissue thumbnail, a ResNet50 score heatmap, patch scores and processing records.

## Connect a laboratory worker

1. Deploy the inference Edge Function, configure its private R2 bucket and worker token, and apply the queue migrations.
2. Inject SUPABASE_URL (HTTPS URL), WORKER_TOKEN (matching server secret), WORKER_ID (a unique stable name for this process), and STEGASUS_MODEL_RUN (absolute model directory) into the worker's process environment. Never use a Supabase service-role key as the worker token. WORKER_TMP optionally sets an existing private temporary directory, and WORKER_MAX_BYTES defaults to 5 GiB. Allow enough disk for the slide and tile cache.
3. Start `python worker.py` with the verified laboratory venv. Keep this foreground process running or supervise it with the laboratory's service manager. It uses outbound HTTPS polling only.
4. Upload an authorized, de-identified TIFF through a configured workspace. Check job completion, recorded model version, score, threshold, patch count and private artifacts. The local file replay establishes computational reproducibility. A live multi-user upload-to-result acceptance test additionally requires configured Supabase and R2.

The worker renews its five-minute lease every ten seconds and stops before the
last confirmed lease expires, using a 60-second safety margin. The server fences
writes with the current lease token. Persistent cache is retained until manually
removed; temporary-directory mode cleans up after a job. Input downloads are
verified before reuse. New results use outputs-direct-gpu-v3, so
older scores and features cannot be mixed with the new implementation.

## Resident model process and validation status

Online direct mode reuses one inference subprocess between jobs. A model bundle
contains all three appearance experts on the selected device and the original
graph expert on CPU. It is keyed by verified checkpoint identities, model path,
and device. Changing identities reloads the bundle. Cancellation, child failure,
or worker shutdown terminates the child and releases its models. No credentials
are passed in its environment; it has no HTTP listener or queue client.
Per-job TIFF handles, cache connections and writer locks are closed after each job.
Records now include preparation, patch, graph, artifact and total compute timings.

Saved v2 sample validation: all 128 real patch scores and graph features matched
the previous output exactly in reference-shape mode. Throughput was 6.17 patches/s
at batch 1 and 7.32 at batch 8. These exclude I/O and do not establish full-slide
runtime. The vectorized candidate reached 122.64 patches/s at batch 32 but failed
patch/feature tolerances, so it remains experimental and is not enabled online.
The v3 resident lifecycle is covered by stub-process/model-pool tests; it has not
been benchmarked with a real slide. No full-slide or live queue inference was run
for the November 22 changes. Docker/Linux execution and cross-hardware validation
still require the actual destination server.
