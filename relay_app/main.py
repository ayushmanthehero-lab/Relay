from __future__ import annotations
from pathlib import Path
import hashlib
import hmac
import ipaddress
import json
import re
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from .config import Settings
from .core import MemoryService, Conflict, GraphUnavailable
from .providers import ProviderError

cfg = Settings()


@asynccontextmanager
async def lifespan(application):
    from .support_worker import SupportWorker, configured_principals
    worker = SupportWorker(cfg, configured_principals(cfg))
    application.state.support_worker = worker
    worker.start()
    try:
        yield
    finally:
        await worker.close()


app = FastAPI(title='Relay · Agent Memory and Coordination', version='2.0.0', lifespan=lifespan)
ROOT = Path(__file__).resolve().parent.parent
app.mount('/static', StaticFiles(directory=ROOT/'static'), name='static')


def is_local(request):
    try:
        host = request.url.hostname
        peer = request.client.host
        return (host == 'localhost' or ipaddress.ip_address(host).is_loopback) and (peer == 'testclient' or ipaddress.ip_address(peer).is_loopback)
    except ValueError:
        return False


def personas():
    if not cfg.demo_mode:
        return []
    return [dict(id=id,name=name,tenant=tenant,token='demo.'+hmac.new(cfg.app_secret.encode(),(tenant+':'+id).encode(),hashlib.sha256).hexdigest())
            for id,name,tenant in [('maya','Maya · team lead','atlas'),('noah','Noah · teammate','atlas'),('rhea','Rhea · isolated team','orbit')]]


def principal(request: Request):
    token = request.headers.get('Authorization','').removeprefix('Bearer ')
    if not token or not token.isascii():
        raise HTTPException(401,'A valid bearer token is required.')
    for p in personas():
        if hmac.compare_digest(token,p['token']):
            if not is_local(request):
                raise HTTPException(403,'Demo identities are restricted to localhost.')
            return {k:p[k] for k in ('id','name','tenant')}
    try:
        configured = json.loads(cfg.auth_tokens_json)
        for secret,p in configured.items():
            if hmac.compare_digest(token,secret) and re.fullmatch(r'[a-zA-Z0-9_]{1,80}',p.get('tenant','')) and re.fullmatch(r'[a-zA-Z0-9_-]{1,80}',p.get('id','')) and p.get('name'):
                return {k:p[k] for k in ('id','name','tenant')}
    except (TypeError,ValueError,AttributeError):
        pass
    raise HTTPException(401,'A valid bearer token is required.')


def service(p=Depends(principal)):
    s = MemoryService(cfg,p)
    s.initialize()
    return s


@app.exception_handler(GraphUnavailable)
async def unavailable(request, exc):
    return JSONResponse(status_code=503,content={'detail':str(exc)})


@app.exception_handler(Conflict)
async def conflict(request, exc):
    return JSONResponse(status_code=409,content={'detail':str(exc)})


@app.exception_handler(ProviderError)
async def provider_error(request, exc):
    return JSONResponse(status_code=502,content={'detail':str(exc)})


class StrictBody(BaseModel):
    model_config = ConfigDict(extra='forbid')


class MemoryBody(StrictBody):
    kind: str = Field(pattern='^(semantic|procedural|episodic)$')
    title: str = Field(min_length=1,max_length=160)
    content: str = Field(min_length=1,max_length=12000)
    topic: str = Field(min_length=1,max_length=100)
    source: str = Field(min_length=1,max_length=500)
    visibility: str = Field(default='team',pattern='^(team|private)$')
    entities: list[str] = Field(default_factory=list,max_length=12)
    supersedes: str | None = Field(default=None,max_length=100)


class RunBody(StrictBody):
    objective: str = Field(min_length=1,max_length=2000)
    topic: str = Field(min_length=1,max_length=100)
    request_id: str = Field(min_length=1,max_length=100)


class WorkersBody(StrictBody):
    workers: int = Field(default=3,ge=1,le=8)
    limit: int = Field(default=18,ge=1,le=60)


class ChatBody(StrictBody):
    message: str = Field(min_length=1,max_length=6000)
    thread_id: str | None = Field(default=None,max_length=100)


@app.get('/')
def index():
    return FileResponse(ROOT/'static/index.html')


@app.get('/health')
def health():
    s = MemoryService(cfg,{'id':'health','name':'Health','tenant':'health'})
    s.graph.q('RETURN 1 AS ok')
    return {'ok':True,'database':'FalkorDB','role':'authoritative memory, coordination and history','provider':cfg.model_provider}


@app.get('/api/bootstrap')
def bootstrap(request: Request):
    return {'project':'Relay','track':'02 · Agent Memory and Coordination','provider':cfg.model_provider,
            'demo_mode':cfg.demo_mode,'personas':personas() if is_local(request) else []}


@app.get('/api/state')
def state(s=Depends(service)):
    return s.state()


@app.post('/api/seed')
def seed(request: Request,s=Depends(service)):
    if not cfg.demo_mode or not is_local(request):
        raise HTTPException(403,'Sample seeding requires local demo mode.')
    return s.seed()


@app.post('/api/memories')
def remember(body:MemoryBody,s=Depends(service)):
    try:
        return s.remember(**body.model_dump())
    except ValueError as exc:
        if isinstance(exc, Conflict):
            raise
        raise HTTPException(422,str(exc)) from exc


@app.post('/api/runs')
def run(body:RunBody,s=Depends(service)):
    return s.start(**body.model_dump())


@app.post('/api/runs/{run_id}/step')
async def step(run_id:str,s=Depends(service)):
    return await s.step(run_id)


@app.post('/api/runs/{run_id}/resume')
async def resume(run_id:str,s=Depends(service)):
    return await s.resume(run_id)


@app.post('/api/workers/run')
async def workers(body:WorkersBody,s=Depends(service)):
    return await s.workers(body.workers,body.limit)


@app.post('/api/chat')
async def chat(body:ChatBody,s=Depends(service)):
    return await s.chat(body.message,body.thread_id)


from .support_routes import create_support_router
app.include_router(create_support_router(lambda: cfg, principal, is_local))

from .company_brain_export import create_company_brain_router
app.include_router(create_company_brain_router(lambda: cfg, principal))

from .project_routes import create_project_router
app.include_router(create_project_router(lambda: cfg, principal))
