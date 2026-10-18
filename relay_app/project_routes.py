"""Authenticated Projects boundary; imports and chat never imply start consent."""
from fastapi import APIRouter, Depends, HTTPException

from .core import Conflict
from .project_models import ImportBody, ProjectChatBody, RevisionBody, StartBody
from .project_store import ProjectStore
from .support_service import SupportService


def create_project_router(get_settings, principal):
    router = APIRouter(prefix='/api/projects', tags=['Relay Projects'])

    def store(p=Depends(principal)):
        service = SupportService(get_settings(), p)
        service.initialize()
        try:
            yield ProjectStore(service)
        except Conflict:
            raise
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @router.get('')
    def projects(s=Depends(store)):
        return s.list()

    @router.post('')
    @router.post('/import')
    def import_plan(body: ImportBody, s=Depends(store)):
        return s.import_plan(**body.model_dump())

    @router.get('/{project_id}')
    def detail(project_id: str, s=Depends(store)):
        return s.detail(project_id)

    @router.post('/{project_id}/start')
    def start(project_id: str, body: StartBody, s=Depends(store)):
        return s.start(project_id, **body.model_dump())

    @router.post('/{project_id}/revisions')
    def revise(project_id: str, body: RevisionBody, s=Depends(store)):
        return s.revise(project_id, **body.model_dump())

    @router.post('/{project_id}/chat')
    def chat(project_id: str, body: ProjectChatBody, s=Depends(store)):
        return s.chat(project_id, **body.model_dump())

    return router
