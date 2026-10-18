"""Portable project-plan contract. Assignment hints never establish identity."""
from __future__ import annotations

from typing import Literal
from urllib.parse import urlsplit
from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictBody(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)


class PlanOwner(StrictBody):
    company_person_id: str = Field(default='', max_length=100)
    name: str = Field(default='', max_length=160)
    relay_person_id: str = Field(default='', max_length=100)


class PlanTask(StrictBody):
    id: str = Field(pattern=r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$')
    title: str = Field(min_length=1, max_length=160)
    description: str = Field(default='', max_length=6000)
    capability: Literal['write_document', 'design_contract', 'build_page', 'test_page', 'package_release']
    depends_on: list[str] = Field(default_factory=list, max_length=40)
    acceptance_criteria: list[str] = Field(default_factory=list, max_length=20)
    owner: PlanOwner = Field(default_factory=PlanOwner)

    @model_validator(mode='after')
    def bounded_criteria(self):
        if any(not value.strip() or len(value) > 1200 for value in self.acceptance_criteria):
            raise ValueError('Acceptance criteria require 1–1200 characters each.')
        return self


class PlanProvenance(StrictBody):
    source: Literal['automate', 'relay']
    source_plan_id: str = Field(min_length=1, max_length=100)
    source_tenant: str = Field(min_length=1, max_length=100)
    source_version: int = Field(ge=1, le=1_000_000, strict=True)
    generated_at: str = Field(min_length=1, max_length=100)
    source_url: str = Field(default='', max_length=1000)

    @model_validator(mode='after')
    def safe_source_url(self):
        if self.source_url:
            url = urlsplit(self.source_url)
            if ((url.scheme not in {'http', 'https'} and not self.source_url.startswith('/'))
                    or self.source_url.startswith('//') or url.username or url.password):
                raise ValueError('Source URLs must be HTTP(S) or a relative application path without credentials.')
        return self


class ProjectPlan(StrictBody):
    schema_version: Literal[1]
    plan_id: str = Field(min_length=1, max_length=100)
    version: int = Field(ge=1, le=1_000_000, strict=True)
    title: str = Field(min_length=1, max_length=160)
    description: str = Field(min_length=1, max_length=12000)
    assumptions: list[str] = Field(default_factory=list, max_length=30)
    tasks: list[PlanTask] = Field(min_length=1, max_length=40)
    provenance: PlanProvenance

    @model_validator(mode='after')
    def valid_graph(self):
        keys = {task.id for task in self.tasks}
        if len(keys) != len(self.tasks):
            raise ValueError('Task IDs must be unique.')
        if sum(len(task.depends_on) for task in self.tasks) > 80:
            raise ValueError('A plan allows at most 80 dependencies.')
        if any(not value.strip() or len(value) > 1000 for value in self.assumptions):
            raise ValueError('Assumptions require 1–1000 characters each.')
        graph = {task.id: task.depends_on for task in self.tasks}
        visiting, visited = set(), set()
        def visit(key):
            if key in visiting:
                raise ValueError('Task dependencies must be acyclic.')
            if key in visited:
                return
            visiting.add(key)
            dependencies = graph[key]
            if len(set(dependencies)) != len(dependencies) or any(dep not in keys for dep in dependencies):
                raise ValueError('Dependencies require unique, existing task IDs.')
            for dep in dependencies:
                visit(dep)
            visiting.remove(key)
            visited.add(key)
        for key in keys:
            visit(key)
        if len(self.model_dump_json().encode()) > 180_000:
            raise ValueError('The plan exceeds the bounded import size.')
        return self


class ImportBody(StrictBody):
    plan: ProjectPlan
    visibility: Literal['team', 'private'] = 'team'
    request_id: str = Field(min_length=1, max_length=100)


class StartBody(StrictBody):
    task_id: str = Field(min_length=1, max_length=100)
    expected_revision: int = Field(ge=1, strict=True)
    plan_version: int = Field(ge=1, strict=True)
    approved: bool = Field(strict=True)
    request_id: str = Field(min_length=1, max_length=100)


class RevisionBody(StrictBody):
    task_id: str = Field(min_length=1, max_length=100)
    prompt: str = Field(min_length=1, max_length=3000)
    expected_revision: int = Field(ge=1, strict=True)
    request_id: str = Field(min_length=1, max_length=100)


class ProjectChatBody(StrictBody):
    message: str = Field(min_length=1, max_length=3000)
    request_id: str = Field(min_length=1, max_length=100)
    mode: Literal['status', 'revise'] = 'status'
    task_id: str = Field(default='', max_length=100)
    expected_revision: int | None = Field(default=None, ge=1, strict=True)
