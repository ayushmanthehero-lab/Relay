"""Real MCP client/server graph tools over the official SDK memory transport."""
from __future__ import annotations
import asyncio
import json
from datetime import timedelta
from typing import Annotated
from pydantic import Field
from mcp.server.fastmcp import FastMCP
from mcp.shared.memory import create_connected_server_and_client_session
from .recovery_queries import RecoveryQueries
from .providers import ProviderError


class RecoveryMCP:
    def __init__(self, service, job, request, handoff=None, actions=None):
        self.service, self.job, self.request = service, job, request
        self.handoff, self.actions = handoff, actions or []
        self.server = FastMCP('Relay graph recovery ' + job['agent'])
        queries = RecoveryQueries(service, job['case_id'])
        if job['stage'] == 0:
            @self.server.tool()
            async def trace_blockers(subject: str, depth: Annotated[int, Field(strict=True, ge=1, le=4)] = 4) -> dict:
                """Trace actual dependency paths to pending prerequisites, at depth 1 to 4."""
                return await asyncio.to_thread(queries.trace_blockers, subject, depth)
            @self.server.tool()
            async def trace_dependents(subject: str, depth: Annotated[int, Field(strict=True, ge=1, le=4)] = 4) -> dict:
                """Trace dependent goals affected by this work item."""
                return await asyncio.to_thread(queries.trace_dependents, subject, depth)
            @self.server.tool()
            async def explain_connection(source: str, target: str, depth: Annotated[int, Field(strict=True, ge=1, le=4)] = 4) -> dict:
                """Run native shortest path algorithm between two known work items."""
                return await asyncio.to_thread(queries.explain_connection, source, target, depth)
            @self.server.tool()
            async def rank_bottlenecks(limit: Annotated[int, Field(strict=True, ge=1, le=40)] = 5) -> dict:
                """Run native PageRank on this project's dependency graph. Scores are centrality."""
                return await asyncio.to_thread(queries.rank_bottlenecks, limit)
            @self.server.tool()
            async def ready_assignments(subject: str, depth: Annotated[int, Field(strict=True, ge=1, le=4)] = 4) -> dict:
                """Find pending frontier blockers and actual capability paths to available agents."""
                return await asyncio.to_thread(queries.ready_assignments, subject, depth)
        elif job['stage'] == 1:
            @self.server.tool()
            async def prepare_recovery_actions(handoff_id: str) -> dict:
                """Consume the explicit Scout handoff, compute graph-supported frontier assignments; commit occurs after lease validation."""
                self._check_handoff(handoff_id)
                result = await asyncio.to_thread(queries.ready_assignments, request['subject'], request['depth'])
                result['handoff_id'] = handoff_id
                result['scout_finding_id'] = self.handoff['finding_id']
                result['handoff_graph_revision'] = self.handoff.get('graph_revision')
                result['handoff_current'] = self.handoff.get('graph_revision') == result['project_revision']
                return result
        else:
            @self.server.tool()
            async def review_recovery_coverage(handoff_id: str) -> dict:
                """Check saved recovery action coverage and agent assignments against current graph evidence. This is not human completion approval."""
                self._check_handoff(handoff_id)
                result = await asyncio.to_thread(queries.ready_assignments, request['subject'], request['depth'])
                expected = {row['id']: row for row in result['rows']}
                actions_by_item = {a['work_item_id']: a for a in self.actions if a['graph_revision'] == result['project_revision']}
                checks = []
                for item_id, row in expected.items():
                    action = actions_by_item.get(item_id)
                    permitted = {a['id'] for a in row['agents']}
                    checks.append(dict(work_item_id=item_id, covered=bool(action),
                                       assigned=bool(action and action.get('assigned_agent_id') in permitted),
                                       evidence_paths=row['paths']))
                result['checks'] = checks
                result['recommendation'] = ('review_actions' if checks and not result['truncated'] and all(c['covered'] and c['assigned'] for c in checks)
                                            else 'needs_evidence' if not checks else 'needs_assignment')
                result['human_completion'] = 'unverified'
                result['handoff_id'] = handoff_id
                result['handoff_graph_revision'] = self.handoff.get('graph_revision')
                result['handoff_current'] = self.handoff.get('graph_revision') == result['project_revision']
                return result

    def _check_handoff(self, handoff_id):
        if not self.handoff or handoff_id != self.handoff['id']:
            raise ValueError('Select the explicit saved handoff for this job.')

    async def __aenter__(self):
        self.transport = create_connected_server_and_client_session(self.server, read_timeout_seconds=timedelta(seconds=30))
        self.client = await self.transport.__aenter__()
        return self

    async def __aexit__(self, *args):
        try:
            return await self.transport.__aexit__(*args)
        except BaseExceptionGroup as group:
            # AnyIO nests body failures while closing its two task groups. Keep
            # the original typed failure so SupportService can persist retries.
            if args[1] is not None:
                raise args[1] from group
            raise ProviderError('MCP session ended unexpectedly.') from group

    async def catalog(self):
        result = await self.client.list_tools()
        return [dict(name=t.name, description=t.description, inputSchema=t.inputSchema) for t in result.tools]

    async def call(self, name, arguments):
        response = await self.client.call_tool(name, arguments)
        if response.isError:
            message = ' '.join(getattr(c, 'text', '') for c in response.content)
            raise ProviderError('MCP graph tool failed: ' + message[:500])
        if response.structuredContent is not None:
            result = response.structuredContent
            if isinstance(result, dict) and set(result) == {'result'}:
                result = result['result']
            return result
        for block in response.content:
            if getattr(block, 'type', '') == 'text':
                try:
                    return json.loads(block.text)
                except ValueError:
                    continue
        raise ProviderError('MCP graph tool returned no structured evidence.')
