"""Bounded background scheduling; every work decision remains in FalkorDB."""
from __future__ import annotations

import asyncio
import json
import logging
import re
from redis import Redis

log = logging.getLogger(__name__)


def configured_principals(cfg):
    identities = []
    if cfg.demo_mode:
        identities.extend([
            {'id': 'maya', 'name': 'Maya · team lead', 'tenant': 'atlas'},
            {'id': 'noah', 'name': 'Noah · teammate', 'tenant': 'atlas'},
            {'id': 'rhea', 'name': 'Rhea · isolated team', 'tenant': 'orbit'},
        ])
    try:
        values = json.loads(cfg.auth_tokens_json)
        if isinstance(values, dict):
            identities.extend(values.values())
    except (TypeError, ValueError):
        pass
    valid = {}
    for p in identities:
        if not isinstance(p, dict):
            continue
        if (isinstance(p.get('id'), str) and isinstance(p.get('tenant'), str)
                and re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', p['id'])
                and re.fullmatch(r'[a-zA-Z0-9_]{1,80}', p['tenant'])
                and isinstance(p.get('name'), str) and p['name'].strip()):
            valid[(p['tenant'], p['id'])] = {key: p[key] for key in ('id', 'name', 'tenant')}
    return list(valid.values())


class SupportWorker:
    def __init__(self, cfg, principals):
        self.cfg, self.principals = cfg, principals
        self.tasks = []
        self.connection = Redis(host=cfg.falkordb_host, port=cfg.falkordb_port,
                                password=cfg.falkordb_password, socket_connect_timeout=2, socket_timeout=5)

    async def work_once(self, principal, *, index=False):
        # EXISTS inspects a graph key without creating an empty tenant graph.
        exists = await asyncio.to_thread(self.connection.exists, 'relay_support_' + principal['tenant'])
        if not exists:
            return {'claimed': False, 'completed': False}
        from .support_service import SupportService
        from .knowledge import MemoryKnowledge
        from .support_indexer import EpisodeIndexer
        service = SupportService(self.cfg, principal)
        await asyncio.to_thread(service.initialize)
        knowledge = MemoryKnowledge(self.cfg, principal)
        service.knowledge = knowledge
        try:
            if index:
                indexer = EpisodeIndexer(service.graph, principal, knowledge, max_attempts=self.cfg.graphiti_max_attempts)
                if not self.cfg.graphiti_enabled or self.cfg.model_provider == 'demo':
                    await asyncio.to_thread(indexer.mark_inactive, 'demo' if self.cfg.model_provider == 'demo' else 'disabled')
                    return {'claimed': False, 'completed': False}
                return await indexer.step(timeout=max(120, self.cfg.model_timeout * 6))
            return await service.step()
        finally:
            await knowledge.close()

    async def _loop(self, offset, *, index=False):
        cursor = offset
        while True:
            worked = False
            if self.principals:
                principal = self.principals[cursor % len(self.principals)]
                cursor += 1
                try:
                    result = await self.work_once(principal, index=index)
                    worked = bool(result.get('completed'))
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    # Domain errors are persisted by service/indexer. Don't log credentials or source content.
                    log.warning('Relay background attempt unavailable: %s', type(exc).__name__)
            await asyncio.sleep(.05 if worked else self.cfg.support_worker_interval)

    def start(self):
        if self.tasks or not self.cfg.support_worker_enabled:
            return
        for index in range(self.cfg.support_worker_concurrency):
            self.tasks.append(asyncio.create_task(self._loop(index), name='relay-work-' + str(index)))
        self.tasks.append(asyncio.create_task(self._loop(0, index=True), name='relay-memory-index'))

    async def close(self):
        for task in self.tasks:
            task.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)
        self.tasks.clear()
        await asyncio.to_thread(self.connection.close)
