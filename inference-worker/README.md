# Frozen STEGASUS WSI worker

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
