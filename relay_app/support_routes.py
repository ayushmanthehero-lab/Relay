"""Authenticated case workspace HTTP boundary; identity never comes from a body."""
from __future__ import annotations

import asyncio
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from .core import Conflict
from .providers import ProviderError


class Body(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)


class CaseBody(Body):
    title: str = Field(min_length=1, max_length=160)
    description: str = Field(min_length=1, max_length=12000)
    visibility: str = Field(default='team', pattern='^(team|private)$')
    request_id: str = Field(min_length=1, max_length=100)
    topic: str = Field(default='', max_length=100)


class MessageBody(Body):
    message: str = Field(min_length=1, max_length=6000)
    request_id: str = Field(min_length=1, max_length=100)


class RecoveryItemBody(Body):
    key: str = Field(pattern=r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$')
    title: str = Field(min_length=1, max_length=160)
    status: str = Field(default='pending', pattern='^(pending|done)$')
    capability: str = Field(default='dependency_analysis', min_length=1, max_length=80)


class RecoveryDependencyBody(Body):
    source: str = Field(min_length=1, max_length=80)
    target: str = Field(min_length=1, max_length=80)
    weight: float = Field(default=1, gt=0, allow_inf_nan=False, strict=True)


class RecoveryProjectBody(Body):
    title: str = Field(min_length=1, max_length=160)
    description: str = Field(min_length=1, max_length=12000)
    visibility: str = Field(default='team', pattern='^(team|private)$')
    request_id: str = Field(min_length=1, max_length=100)
    items: list[RecoveryItemBody] | None = Field(default=None, min_length=1, max_length=40)
    dependencies: list[RecoveryDependencyBody] | None = Field(default=None, max_length=80)


class RecoveryAskBody(Body):
    question: str = Field(min_length=1, max_length=3000)
    subject: str = Field(min_length=1, max_length=160)
    depth: int = Field(default=4, ge=1, le=4, strict=True)
    request_id: str = Field(min_length=1, max_length=100)


class RecoveryQueryBody(Body):
    tool: str = Field(pattern='^(trace_blockers|trace_dependents|explain_connection|rank_bottlenecks|ready_assignments)$')
    arguments: dict = Field(default_factory=dict)


class RecoveryRememberBody(Body):
    content: str = Field(min_length=1, max_length=6000)
    request_id: str = Field(min_length=1, max_length=100)


class ExecutionStartBody(Body):
    request_id: str = Field(min_length=1, max_length=100)


class RecoveryItemUpdateBody(Body):
    status: str = Field(pattern='^(pending|done)$')
    expected_revision: int = Field(ge=1, strict=True)
    reason: str = Field(min_length=1, max_length=2000)
    request_id: str = Field(min_length=1, max_length=100)


class TaskBody(Body):
    status: str = Field(pattern='^(todo|doing|done)$')
    expected_revision: int = Field(ge=0)
    evidence: str = Field(default='', max_length=6000)


class OutcomeBody(Body):
    resolution: str = Field(min_length=1, max_length=6000)
    request_id: str = Field(min_length=1, max_length=100)


class ApproveBody(Body):
    expected_revision: int = Field(ge=0)
    title: str | None = Field(default=None, min_length=1, max_length=160)
    content: str | None = Field(default=None, min_length=1, max_length=12000)


class ReviseBody(Body):
    content: str = Field(min_length=1, max_length=12000)
    expected_revision: int = Field(ge=0)
    reason: str = Field(min_length=1, max_length=2000)


class WorkersBody(Body):
    workers: int = Field(default=3, ge=1, le=8)
    limit: int = Field(default=18, ge=1, le=60)


class SessionBody(Body):
    title: str = Field(default='Follow-up work', min_length=1, max_length=160)
    request_id: str = Field(min_length=1, max_length=100)


class TaskReviewBody(Body):
    expected_revision: int = Field(ge=0)
    evidence: str = Field(min_length=1, max_length=6000)
    request_id: str = Field(min_length=1, max_length=100)


class TaskDecisionBody(Body):
    review_id: str = Field(min_length=1, max_length=100)
    decision: str = Field(pattern='^(approve|reject)$')
    expected_revision: int = Field(ge=0)
    reason: str = Field(min_length=1, max_length=2000)
    request_id: str = Field(min_length=1, max_length=100)


def create_support_router(get_settings, principal, is_local):
    router = APIRouter(prefix='/api/support', tags=['Relay support workspace'])

    async def service(p=Depends(principal)):
        from .support_service import SupportService
        from .knowledge import MemoryKnowledge
        cfg = get_settings()
        instance = SupportService(cfg, p)
        await asyncio.to_thread(instance.initialize)
        knowledge = MemoryKnowledge(cfg, p)
        instance.knowledge = knowledge
        try:
            yield instance
        except (Conflict, ProviderError):
            raise
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        finally:
            await knowledge.close()

    @router.get('/state')
    async def state(s=Depends(service)):
        result = await asyncio.to_thread(s.state)
        result['capabilities'] = {
            'graphiti': s.knowledge.capability(),
            'automatic_work': {'enabled': s.cfg.support_worker_enabled, 'workers': s.cfg.support_worker_concurrency},
            'database': {'engine': 'FalkorDB', 'status': 'connected'},
        }
        return result

    @router.post('/cases')
    def create(body: CaseBody, s=Depends(service)):
        return s.create_case(**body.model_dump())

    @router.post('/recovery/projects')
    def recovery_project(body: RecoveryProjectBody, s=Depends(service)):
        from .recovery_store import RecoveryStore
        return RecoveryStore(s).create_project(**body.model_dump())

    @router.get('/cases/{case_id}/recovery')
    def recovery_state(case_id: str, s=Depends(service)):
        from .recovery_store import RecoveryStore
        return RecoveryStore(s).state(case_id)

    @router.get('/cases/{case_id}/execution')
    def execution_state(case_id: str, s=Depends(service)):
        from .execution_store import ExecutionStore
        return ExecutionStore(s).state(case_id)

    @router.post('/cases/{case_id}/execution/start')
    def execution_start(case_id: str, body: ExecutionStartBody, s=Depends(service)):
        from .execution_store import ExecutionStore
        return ExecutionStore(s).start(case_id, body.request_id)

    @router.get('/cases/{case_id}/execution/artifacts/{artifact_id}')
    def execution_artifact(case_id: str, artifact_id: str, s=Depends(service)):
        from .execution_store import ExecutionStore
        return ExecutionStore(s).artifact(case_id, artifact_id)

    @router.post('/cases/{case_id}/recovery/ask')
    def recovery_ask(case_id: str, body: RecoveryAskBody, s=Depends(service)):
        from .recovery_store import RecoveryStore
        return RecoveryStore(s).ask(case_id, **body.model_dump())

    @router.post('/cases/{case_id}/recovery/query')
    def recovery_query(case_id: str, body: RecoveryQueryBody, s=Depends(service)):
        from .recovery_store import RecoveryStore
        return RecoveryStore(s).query(case_id, **body.model_dump())

    @router.post('/cases/{case_id}/recovery/remember')
    def recovery_remember(case_id: str, body: RecoveryRememberBody, s=Depends(service)):
        from .recovery_store import RecoveryStore
        return RecoveryStore(s).remember(case_id, **body.model_dump())

    @router.post('/cases/{case_id}/recovery/items/{item_key}')
    def recovery_update_item(case_id: str, item_key: str, body: RecoveryItemUpdateBody, s=Depends(service)):
        from .recovery_store import RecoveryStore
        return RecoveryStore(s).update_item(case_id, item_key, **body.model_dump())

    @router.get('/flow')
    def flow(case_id: str | None = Query(default=None, min_length=1, max_length=100), s=Depends(service)):
        return s.flow(case_id=case_id)

    @router.post('/cases/{case_id}/sessions')
    def start_session(case_id: str, body: SessionBody, s=Depends(service)):
        return s.start_session(case_id, **body.model_dump())

    @router.post('/cases/{case_id}/tasks/{task_id}/review')
    async def review_task(case_id: str, task_id: str, body: TaskReviewBody, s=Depends(service)):
        return await s.review_task(case_id, task_id, **body.model_dump())

    @router.post('/cases/{case_id}/tasks/{task_id}/decision')
    def decide_task(case_id: str, task_id: str, body: TaskDecisionBody, s=Depends(service)):
        return s.decide_task(case_id, task_id, **body.model_dump())

    @router.get('/cases/{case_id}')
    def detail(case_id: str, s=Depends(service)):
        return s.detail(case_id)

    @router.post('/cases/{case_id}/pause')
    def pause(case_id: str, s=Depends(service)):
        return s.pause(case_id)

    @router.post('/cases/{case_id}/resume')
    def resume(case_id: str, s=Depends(service)):
        return s.resume(case_id)

    @router.post('/cases/{case_id}/tasks/{task_id}')
    def update_task(case_id: str, task_id: str, body: TaskBody, s=Depends(service)):
        return s.update_task(case_id, task_id, **body.model_dump())

    @router.post('/cases/{case_id}/chat')
    async def chat(case_id: str, body: MessageBody, s=Depends(service)):
        return await s.chat(case_id, **body.model_dump())

    @router.post('/cases/{case_id}/resolve')
    def resolve(case_id: str, body: OutcomeBody, s=Depends(service)):
        return s.resolve(case_id, **body.model_dump())

    @router.post('/learning/{learning_id}/approve')
    def approve(learning_id: str, body: ApproveBody, s=Depends(service)):
        return s.approve_learning(learning_id, **body.model_dump())

    @router.post('/memories/{memory_id}/revise')
    def revise(memory_id: str, body: ReviseBody, s=Depends(service)):
        return s.revise_memory(memory_id, **body.model_dump())

    @router.post('/workers/run')
    async def workers(body: WorkersBody, s=Depends(service)):
        return await s.workers(**body.model_dump())

    @router.post('/episodes/{episode_id}/retry')
    def retry_index(episode_id: str, s=Depends(service)):
        from .support_indexer import EpisodeIndexer
        return EpisodeIndexer(s.graph, s.principal, s.knowledge,
                              max_attempts=s.cfg.graphiti_max_attempts).retry(episode_id)

    @router.post('/seed')
    async def seed(request: Request, s=Depends(service)):
        if not s.cfg.demo_mode or not is_local(request):
            raise HTTPException(403, 'Synthetic examples are available only in local demo mode.')
        return await s.seed()

    return router
