# Frozen STEGASUS WSI worker

## Optional batched direct-slide path

The frozen pipeline already reads coordinates directly from OpenSlide and stores
scores/features in SQLite; its progress message does not represent separate tile
image files. `direct_pipeline.py` preserves that pixel contract while processing
batches, retaining the three appearance models on the available device and
committing one transaction per batch. Forward passes retain the frozen batch-one
shape: fully vectorized CUDA inference showed score drift in the regression test
and is not enabled. Batch size controls patch preparation and cache commits.
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

The default worker remains `frozen` until full-slide validation. The synthetic
regression checks real expert weights, graph and ensemble outputs within explicit
tolerances, but cannot establish full-slide equivalence, throughput, or behavior
on near-threshold slides. A future acceptance run should compare both paths on
the same complete slides and hardware, including all patch scores and decisions.

Validation on 20 November 2026: five local regression tests passed. The real frozen
checkpoints on CUDA produced identical appearance scores and expert-0 features for
nine synthetic patches, followed by identical small-graph and ensemble scores.
These checks do not measure whole-slide runtime or establish full-slide agreement.

To opt in after stopping the existing worker with Ctrl+C, run from this repository:

~~~powershell
.\inference-worker\start-worker.ps1 -Pipeline direct -BatchSize 8 -CacheDirectory "$env:LOCALAPPDATA\STEGASUS\worker-cache"
~~~

This command claims existing queued jobs. Do not run a second worker with the same
worker ID. Persistent caching is optional and private: it retains downloaded slides,
coordinates, scores and features until manually removed, including after completion.
Choose a local disk outside OneDrive with sufficient space. Complete downloads are
verified by SHA-256 before reuse; partial downloads are discarded. A per-job Windows
lock excludes concurrent cache writers. Processing manifests bind cached batches to
the slide, model hashes, implementation, batch size and preprocessing. Changed
settings require a new cache directory. Without `-CacheDirectory`, the worker uses
temporary storage and cannot resume between claimed attempts. Local `--slide` mode
in direct processing can resume the same `--output` directory.

No queue jobs are reset or retried by installing these files. Existing worker
processes must be restarted to load changes. This optimization does not repair
network outages or the existing fail-on-heartbeat-error policy.

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

The worker renews its five-minute lease every 45 seconds. A lost renewal stops the computation. A separate attempt uses a fresh private temporary directory, and the server fences writes with the current lease token. On normal exit from a job, downloaded inputs and cached files are removed. Reclaim abandoned OS temporary folders after an abrupt host shutdown under laboratory policy.
