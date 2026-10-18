"""Actual MCP execution tools; the application owns the permitted effects."""
from __future__ import annotations
from datetime import timedelta
from mcp.server.fastmcp import FastMCP
from mcp.shared.memory import create_connected_server_and_client_session
from .recovery_mcp import RecoveryMCP


class ExecutionMCP(RecoveryMCP):
    def __init__(self, service, job, context):
        self.service, self.job = service, job
        self.server = FastMCP('Relay task execution ' + job['agent'])

        @self.server.tool()
        async def execute_work(work_item_id: str) -> dict:
            """Execute the graph-assigned task, create its deliverables, and run real bounded validation tools."""
            if work_item_id != job['work_item_id']:
                raise ValueError('Only the graph-assigned work item can be executed by this job.')
            from .execution_tools import execute_work as perform
            return await perform(service.provider, job['capability'], context)

    async def __aenter__(self):
        self.transport = create_connected_server_and_client_session(self.server,
            read_timeout_seconds=timedelta(seconds=max(180, self.service.cfg.model_timeout * 3 + 60)))
        self.client = await self.transport.__aenter__()
        return self
