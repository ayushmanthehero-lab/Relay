# Complete local setup

Run commands from the root of the cloned **Relay** repository. Relay has no runtime dependency on Automate. Python 3.13 is used by the Docker image and local verification; Docker Compose supplies the pinned FalkorDB image.

## 1. Prerequisites and configuration

Install Git, Python 3.13, and Docker Desktop on Windows/macOS or Docker Engine with the Compose plugin on Linux. Start Docker before continuing. A live model is required to execute tasks; choose Codex on the host, an OpenAI-compatible API, or Ollama.

Windows PowerShell:

```powershell
git clone https://github.com/ayushmanthehero-lab/Relay.git
Set-Location Relay
Copy-Item .env.example .env
```

macOS/Linux:

```bash
git clone https://github.com/ayushmanthehero-lab/Relay.git
cd Relay
cp .env.example .env
```

Edit `.env` locally. It is ignored by Git. Keep these settings for the supplied host database:

```dotenv
FALKORDB_HOST=127.0.0.1
FALKORDB_PORT=6381
DEMO_MODE=true
SUPPORT_WORKER_ENABLED=true
SUPPORT_WORKER_CONCURRENCY=3
```

`DEMO_MODE` controls local sample identities. `MODEL_PROVIDER` independently controls inference. Local synthetic identities work with a real provider. The default `MODEL_PROVIDER=demo` offers scripted investigation behavior but refuses real task execution.

## 2. Select a model

### Host Codex login

Install the official Codex CLI and complete its normal login on the same operating-system account that will run Relay:

```text
codex login
```

Set `MODEL_PROVIDER=codex`. `MODEL_NAME` may be blank to use the CLI default. If the command is not on PATH, configure `CODEX_COMMAND`. Relay invokes the CLI with structured output and disabled general tools; the application controls execution through its own bounded tools. It uses the CLI's existing login without reading or copying authentication files.

Use the **host Python instructions below**. The application container does not contain the host's Codex binary or login.

### OpenAI-compatible API

Configure a model and endpoint supporting tool calls and JSON schema structured output:

```dotenv
MODEL_PROVIDER=api
MODEL_NAME=your-model-id
MODEL_BASE_URL=https://your-provider.example/v1
MODEL_API_KEY=your-local-api-key
MODEL_TIMEOUT=180
```

Replace the example values with actual provider values. The adapter uses the compatible chat-completions API; the URL must end at the API's `/v1` base, not a completion route. A live provider error stays visible and never falls back to sample output.

### Local Ollama

Start Ollama and pull a model supporting tools and structured outputs. Then set:

```dotenv
MODEL_PROVIDER=ollama
MODEL_NAME=your-installed-model
MODEL_BASE_URL=http://127.0.0.1:11434/v1
MODEL_TIMEOUT=180
```

The model name must match an installed model. In the application container, `127.0.0.1` refers to the container itself; use a reachable host address such as Docker Desktop's `http://host.docker.internal:11434/v1` and configure Ollama to accept that connection.

## 3. Run Python on the host

### Windows quick launcher

```powershell
./scripts/start.ps1 -Provider codex
```

Substitute `api` or `ollama` as appropriate. The launcher's `-Provider` overrides `.env` for the process. Use `-SkipInstall` after dependencies have been installed, `-SkipDatabase` for an already-running database, or `-Port 8095` to change the app port.

For a fully explicit setup, or to prepare embeddings before launching:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
docker compose up -d falkordb
.\.venv\Scripts\python.exe -m uvicorn relay_app.main:app --host 127.0.0.1 --port 8091
```

Install Microsoft Edge for signup-page execution checks on Windows: the executor selects Playwright's `msedge` channel. Linux/macOS and the Docker image use Playwright Chromium. Writer-only projects do not need a browser executor. The web interface itself only requires an ordinary browser.

### macOS/Linux

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
docker compose up -d falkordb
python -m playwright install chromium
python -m uvicorn relay_app.main:app --host 127.0.0.1 --port 8091
```

On Linux, Playwright may require operating-system browser packages; use `python -m playwright install --with-deps chromium` with the privileges required by your distribution. The supplied Dockerfile performs this installation during image build.

| Service | Address |
| --- | --- |
| Relay | http://127.0.0.1:8091 |
| API schemas | http://127.0.0.1:8091/docs |
| Health check | http://127.0.0.1:8091/health |
| FalkorDB Browser | http://127.0.0.1:3002 |
| FalkorDB protocol | `127.0.0.1:6381` |

`/health` proves database connectivity, not model readiness or completed Graphiti indexing. Choose **Maya** or **Noah** for the shared `atlas` tenant, or **Rhea** for the separate `orbit` tenant. Sample identities appear only when both the request hostname and peer are loopback. Create a project under **Projects**; creating or importing starts no tasks.

## 4. Enable Graphiti semantic memory

Native memory, conversations and scheduling already use FalkorDB. For semantic extraction and hybrid recall, keep `GRAPHITI_ENABLED=true`, select a live reasoning provider and prepare embeddings. The default local CPU model is `BAAI/bge-small-en-v1.5` with 384 dimensions.

Windows:

```powershell
.\.venv\Scripts\python.exe scripts/model_download.py
```

macOS/Linux, in the virtual environment:

```bash
python scripts/model_download.py
```

Then add this to `.env` and restart the app:

```dotenv
GRAPHITI_ENABLED=true
EMBEDDING_BACKEND=local
EMBEDDING_MODEL=BAAI/bge-small-en-v1.5
EMBEDDING_DIMENSIONS=384
EMBEDDING_LOCAL_PATH=data/embedding-models/bge-small-en-v1.5
```

The downloader checks ONNX weights against a pinned checksum. If Hugging Face is unreachable, `scripts/model_download.py --source modelscope` explicitly selects the fallback mirror with the same weights checksum. Embedding assets are not committed to the repository.

Alternatively, set `EMBEDDING_BACKEND=api` or `ollama` and configure that model's `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_BASE_URL` and, for an API, `EMBEDDING_API_KEY`. These are separate from the reasoning settings. Choose the embedding configuration before first indexing; changing its fingerprint requires deliberate reindexing, not mixing vectors in an existing scope.

To run without semantic indexing, set `GRAPHITI_ENABLED=false`. Native graph memory still works. **Activity** reports actual episode indexing state; “configured” does not mean every episode is indexed. Extraction can make several model calls per episode.

## 5. Run both services in Docker

Use API or a container-reachable Ollama endpoint. Use configured bearer identities rather than the host-only demo selector, since the app container sees the Docker gateway as the request peer.

Edit `.env` with your chosen provider and these settings:

```dotenv
DEMO_MODE=false
APP_SECRET=replace-with-a-long-random-secret
AUTH_TOKENS_JSON='{"replace-with-a-long-random-token":{"id":"maya","name":"Maya","tenant":"atlas"}}'
```

Replace both placeholder secrets. Each JSON value is an identity; each key is its bearer token. The single quotes belong to `.env` quoting, not the JSON object. Do not commit real tokens. Generate a random value locally with `python -c "import secrets; print(secrets.token_urlsafe(32))"`.

For local embeddings, run the downloader on the host first. Compose mounts `data/embedding-models` at `/app/data/embedding-models`. Then run:

```text
docker compose up -d --build
docker compose ps
docker compose logs --tail 60 app
```

Open http://127.0.0.1:8091 and enter the configured token. The container uses `falkordb:6379` automatically; published host ports remain 6381 and 3002. Chromium and its dependencies are included. Supplied ports bind to loopback.

## 6. Persistence, stopping and restart

For a host app, press Ctrl+C to stop Python, then start it with the same configuration. Docker data lives in `agentmemory_relay_graph_data`, with AOF and periodic snapshots enabled. Project state, output file contents, memory and approvals are graph records. Model caches and temporary transport files live under ignored `data/`.

```text
docker compose stop
docker compose start
```

For host Python, restart only the database with `docker compose start falkordb`, then rerun the Python launcher. `docker compose down` removes containers but preserves the named volume. **Do not use `down -v` unless you intend to erase the database.** Back up the database volume for valuable work.

Unfinished jobs persist. After a crash, the previous claim must expire before another worker can safely claim it. Model computation may repeat; committed artifacts and handoff receipts remain in the graph. The default attempt budget is three; **Continue work** or **Retry indexing** explicitly retries exhausted work.

## 7. Optional Automate connection

Start [Automate](https://github.com/ayushmanthehero-lab/Automate) separately. A downloaded plan imports through **Projects → Upload plan** without a server connection.

For direct sending and company knowledge sync, configure Automate's Relay connection with this server's reachable URL and an identity token whose tenant and visibility contain the intended project. A host demo token is localhost-only; a configured `AUTH_TOKENS_JSON` identity is suitable for server-to-server use. Automate calls `POST /api/projects` and `GET /api/company-brain/export`. Syncing and importing do not execute tasks.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Execution refuses walkthrough mode | Select live `codex`, `api` or `ollama` and restart. |
| Database unavailable / HTTP 503 | Run `docker compose ps`; verify host port 6381 and `.env`. |
| Provider error / HTTP 502 | Check model, endpoint, credentials or host Codex login, and timeout. |
| No demo identities in Docker | Configure bearer tokens; demo authentication requires genuine loopback. |
| Browser executable missing | Install Edge on Windows or run Playwright's Chromium install. |
| Graphiti indexing fails | Check provider, embeddings/model/dimensions; inspect Activity and retry. |
| Task waits after a prerequisite succeeds | Projects require separate **Approve & run task** consent for each task. |
| Conflict / HTTP 409 | Refresh; the project's revision, evidence or approval changed. |
| Background work does not run | Ensure `SUPPORT_WORKER_ENABLED=true`; the identity must be in server configuration. |
| Port in use | Stop the conflicting service or change the host port and matching settings. |

## Frontend asset rebuild

Node.js is needed only to rebuild the graph component, not to start Relay:

```text
npm ci
npm run build
```

The build uses pinned official `@falkordb/canvas` and regenerates JavaScript chunks and third-party notices under `static/vendor`. Keep these files together when packaging the application.
