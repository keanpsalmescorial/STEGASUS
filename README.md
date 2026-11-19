# STEGASUS
Independent implementation of the November 2026 D1 research website and laboratory platform.

## Run locally
Serve dist using any static HTTP server, then open index.html. The frontend uses relative asset paths for GitHub Pages subpaths. Browser config is dist/studio/config.js and contains only the Supabase URL and publishable key.

## Backend
Supabase project ommvptpnpboyunnlxoew has the three migrations in supabase/migrations applied. Workspaces, memberships, projects, experiments, typed variables, runs, measurements, datasets, notes, audit history, invitations, document attachment policies and inference queue are included. Roles are owner, administrator, researcher, reviewer and viewer.

Set the Supabase Auth Site URL and redirect allowlist to the deployed Studio origin. Email confirmation and password reset require configured delivery and redirect settings. Never commit server secrets.

## Private image analysis
Use supabase/functions/inference/index.ts as the inference Edge Function, with gateway JWT verification disabled because it separately validates browser JWTs and scoped worker tokens. Configure SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, WORKER_TOKEN, WORKER_WORKSPACE_ID and STEGASUS_ALLOWED_ORIGINS in the server secret store. Configure private R2 bucket CORS for the deployed frontend and multipart PUT/ETag access. Set workspace upload quotas through the queue schema.
Read inference-worker/README.md for the existing laboratory environment, frozen checkpoints, hashes, threshold, supported TIFF inputs and outbound worker operation. Checkpoints remain in their existing private laboratory folder.
The local replay reproduced archived scores and artifact hashes. The live browser upload, storage, worker and result roundtrip requires the configured R2 service and deployed function.

## GitHub Pages
The independent repository is https://github.com/keanpsalmescorial/STEGASUS. GitHub Actions publishes dist to https://keanpsalmescorial.github.io/STEGASUS/. Pages is enabled and deployment has been verified. The included workflow runs tests and syntax checks before publication.

## Research provenance
dist/data/manuscript.json contains the abstract, 37 numbered tables plus appendix A1, references, captions and limitations. dist/data/figures holds 22 extracted study figures. PHAGOS was inspected read-only. This checkout contains original presentation code and conceptual artwork.

## Tests
Run node --test tests/*.test.mjs. Run tests/workspace-rls.sql through psql against a disposable migrated Supabase project to test authenticated role scenarios. It uses psql variables and cannot be passed directly to the SQL API.

See TESTING.md for verified scope and pending checks.
