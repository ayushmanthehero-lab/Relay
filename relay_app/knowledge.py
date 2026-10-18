"""Scoped Graphiti memory. FalkorDB receipts gate derived knowledge visibility."""
from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import math
import os
import re
import time
import uuid
from copy import deepcopy
from datetime import datetime, timezone


class KnowledgeUnavailable(RuntimeError):
    """Extraction or semantic retrieval cannot safely run with this configuration."""


def validate_vectors(vectors, *, expected_count, dimensions):
    if len(vectors) != expected_count:
        raise KnowledgeUnavailable('Embedding endpoint returned the wrong number of vectors.')
    clean = []
    for vector in vectors:
        if len(vector) != dimensions:
            raise KnowledgeUnavailable('Embedding dimension mismatch; configure the model dimension before indexing.')
        try:
            values = [float(value) for value in vector]
        except (ValueError, TypeError) as exc:
            raise KnowledgeUnavailable('Embedding vectors must contain finite numbers.') from exc
        if not all(math.isfinite(value) for value in values):
            raise KnowledgeUnavailable('Embedding vectors must contain finite numbers.')
        if not any(values):
            raise KnowledgeUnavailable('Embedding endpoint returned a zero vector.')
        clean.append(values)
    return clean


class MemoryKnowledge:
    def __init__(self, cfg, principal, *, llm_client=None, embedder=None):
        tenant = principal.get('tenant', '')
        owner = principal.get('id', '')
        if not isinstance(tenant, str) or not re.fullmatch(r'[A-Za-z0-9_]{1,80}', tenant):
            raise ValueError('Invalid tenant identity.')
        if not isinstance(owner, str) or not owner.strip() or len(owner) > 200:
            raise ValueError('Invalid owner identity.')
        self.cfg, self.tenant, self.owner = cfg, tenant, owner
        self._llm_override, self._embedder_override = llm_client, embedder
        self._clients = {}

    def _scope(self, visibility, owner=None):
        if visibility == 'private' and owner is not None and owner != self.owner:
            raise ValueError('Private memory owner must match the authenticated identity.')
        if visibility not in {'team', 'private'}:
            raise ValueError('Invalid memory visibility.')
        if visibility == 'team':
            return f'relaykg_{self.tenant}_team'
        digest = hashlib.sha256(self.owner.encode('utf-8')).hexdigest()[:32]
        return f'relaykg_{self.tenant}_user_{digest}'

    def capability(self):
        enabled = getattr(self.cfg, 'graphiti_enabled', True)
        provider = self.cfg.model_provider
        backend = getattr(self.cfg, 'embedding_backend', 'local')
        status = 'configured'
        detail = 'Graphiti extraction is configured; indexing status is reported per episode.'
        if not enabled:
            status, detail = 'disabled', 'Graphiti indexing is disabled.'
        elif provider == 'demo':
            status, detail = 'demo', 'Deterministic demo; live Graphiti extraction has not run.'
        elif not importlib.util.find_spec('graphiti_core'):
            status, detail = 'unavailable', 'Install the pinned Graphiti dependencies to enable extraction.'
        elif backend not in {'local', 'api', 'ollama'}:
            status, detail = 'unavailable', 'Choose a local, API, or Ollama embedding backend.'
        elif backend == 'local' and self._embedder_override is None and not importlib.util.find_spec('fastembed'):
            status, detail = 'unavailable', 'Install FastEmbed for local semantic embeddings.'
        elif backend == 'api' and self._embedder_override is None and not getattr(self.cfg, 'embedding_api_key', ''):
            status, detail = 'unavailable', 'Configure the embedding API key.'
        return dict(status=status, enabled=enabled, live_extraction=status == 'configured',
                    backend=backend, model=getattr(self.cfg, 'embedding_model', ''), detail=detail)

    async def _client(self, scope):
        if scope in self._clients:
            return self._clients[scope]
        # Keep the local application free of unsolicited SDK telemetry.
        os.environ.setdefault('GRAPHITI_TELEMETRY_ENABLED', 'false')
        from graphiti_core import Graphiti
        from graphiti_core.driver.falkordb_driver import FalkorDriver
        from falkordb.asyncio import FalkorDB
        from .knowledge_clients import ProviderLLM, make_embedder, EmbeddingRanker
        embedder = self._embedder_override or make_embedder(self.cfg)
        llm = self._llm_override or ProviderLLM(self.cfg)
        try:
            # The async SDK constructor performs a synchronous cluster probe.
            connection = await asyncio.to_thread(FalkorDB,
                host=self.cfg.falkordb_host, port=self.cfg.falkordb_port,
                password=self.cfg.falkordb_password, socket_connect_timeout=3, socket_timeout=30)
        except Exception as exc:
            raise KnowledgeUnavailable('FalkorDB knowledge graph is unavailable; indexing cannot proceed.') from exc
        driver = FalkorDriver(falkor_db=connection, database=scope)
        client = Graphiti(graph_driver=driver, llm_client=llm, embedder=embedder,
            cross_encoder=EmbeddingRanker(embedder), max_coroutines=self.cfg.graphiti_max_coroutines)
        try:
            await client.build_indices_and_constraints()
            fingerprint = hashlib.sha256(embedder.fingerprint.encode()).hexdigest()
            result = await driver.execute_query(
                'MERGE (c:RelayEmbeddingConfig {id:"embedding"}) '
                'ON CREATE SET c.fingerprint=$fingerprint, c.dimensions=$dimensions '
                'RETURN c.fingerprint AS fingerprint',
                fingerprint=fingerprint, dimensions=embedder.dimensions)
            if result[0][0]['fingerprint'] != fingerprint:
                raise KnowledgeUnavailable('Embedding fingerprint changed; reindex this knowledge scope before retrieval.')
        except Exception as exc:
            await client.close()
            if isinstance(exc, KnowledgeUnavailable):
                raise
            raise KnowledgeUnavailable('FalkorDB knowledge graph is unavailable; indexing cannot proceed.') from exc
        self._clients[scope] = client
        return client

    @staticmethod
    def _receipt(row, scope):
        return dict(status='complete', scope=scope, source_episode_id=row['source_episode_id'],
            episode_uuid=row['episode_uuid'], node_ids=row.get('node_ids') or [],
            edge_ids=row.get('edge_ids') or [], completed_at=row.get('completed_at'))

    async def ingest_episode(self, episode):
        scope = self._scope(episode.get('visibility', 'team'), episode.get('owner'))
        capability = self.capability()
        if capability['status'] != 'configured':
            raise KnowledgeUnavailable(capability['detail'])
        from graphiti_core.nodes import EpisodicNode, EpisodeType
        from graphiti_core.errors import NodeNotFoundError
        from .knowledge_clients import entity_types
        for field in ('id', 'case_id', 'title', 'content', 'owner'):
            if not isinstance(episode.get(field), str) or not episode[field].strip():
                raise ValueError(f'Episode requires {field}.')
        try:
            reference_time = datetime.fromtimestamp(float(episode['created_at']), timezone.utc)
        except (KeyError, TypeError, ValueError, OverflowError, OSError) as exc:
            raise ValueError('Episode requires a valid creation time.') from exc
        episode_uuid = str(uuid.uuid5(uuid.NAMESPACE_URL, scope + ':' + episode['id']))
        source_fields = {key: episode[key] for key in ('id', 'case_id', 'title', 'content', 'owner')}
        source_fields['visibility'] = episode.get('visibility', 'team')
        digest = hashlib.sha256(json.dumps(source_fields, sort_keys=True).encode()).hexdigest()
        client = await self._client(scope)
        driver = client.driver
        existing = await driver.execute_query(
            'MATCH (r:RelayEpisodeReceipt {episode_uuid:$uuid}) '
            'RETURN r.source_episode_id AS source_episode_id,r.episode_uuid AS episode_uuid,'
            'r.digest AS digest,r.status AS status,r.node_ids AS node_ids,r.edge_ids AS edge_ids,'
            'r.completed_at AS completed_at', uuid=episode_uuid)
        if existing[0]:
            row = existing[0][0]
            if row['digest'] != digest:
                raise ValueError('Episode ID already belongs to different source content.')
            if row['status'] == 'complete':
                return self._receipt(row, scope)
        await driver.execute_query(
            'MERGE (r:RelayEpisodeReceipt {episode_uuid:$uuid}) '
            'SET r.source_episode_id=$id,r.case_id=$case_id,r.digest=$digest,r.status="processing",'
            'r.title=$title,r.started_at=$now', uuid=episode_uuid, id=episode['id'],
            case_id=episode['case_id'], digest=digest, title=episode['title'], now=time.time())
        try:
            previous = await driver.execute_query(
                'MATCH (r:RelayEpisodeReceipt {status:"complete"}) '
                'WHERE r.episode_uuid<>$uuid RETURN r.episode_uuid AS uuid '
                'ORDER BY r.completed_at DESC LIMIT 6', uuid=episode_uuid)
            previous_ids = [row['uuid'] for row in previous[0]]
            try:
                await EpisodicNode.get_by_uuid(driver, episode_uuid)
            except NodeNotFoundError:
                raw = EpisodicNode(uuid=episode_uuid, name=episode['title'], group_id=scope,
                    source=EpisodeType.text, source_description=f'Relay case {episode["case_id"]}; episode {episode["id"]}',
                    content=episode['title'] + '\n' + episode['content'], valid_at=reference_time)
                await raw.save(driver)
            result = await client.add_episode(name=episode['title'], episode_body=episode['content'],
                source_description=f'Relay case {episode["case_id"]}; episode {episode["id"]}',
                reference_time=reference_time, source=EpisodeType.text, group_id=scope,
                uuid=episode_uuid, previous_episode_uuids=previous_ids,
                entity_types=entity_types(), update_communities=False,
                custom_extraction_instructions='Extract case facts and explicitly described successful procedures. '
                    'An observation or suggested action is not a confirmed outcome or approval.')
            node_ids = sorted({node.uuid for node in result.nodes})
            edge_ids = sorted({edge.uuid for edge in result.edges})
            completed_at = time.time()
            await driver.execute_query(
                'MATCH (r:RelayEpisodeReceipt {episode_uuid:$uuid,digest:$digest}) '
                'SET r.status="complete",r.node_ids=$nodes,r.edge_ids=$edges,r.completed_at=$now',
                uuid=episode_uuid, digest=digest, nodes=node_ids, edges=edge_ids, now=completed_at)
            return self._receipt(dict(source_episode_id=episode['id'], episode_uuid=episode_uuid,
                node_ids=node_ids, edge_ids=edge_ids, completed_at=completed_at), scope)
        except Exception as exc:
            await driver.execute_query('MATCH (r:RelayEpisodeReceipt {episode_uuid:$uuid}) '
                'SET r.status="failed",r.error_kind=$kind', uuid=episode_uuid, kind=type(exc).__name__)
            if isinstance(exc, (KnowledgeUnavailable, ValueError)):
                raise
            raise KnowledgeUnavailable('Graphiti extraction failed; the episode remains unacknowledged and can be retried.') from exc

    async def recall(self, query, visibility='team', owner=None, limit=8):
        self._scope(visibility, owner)
        status = self.capability()
        if status['status'] in {'demo', 'disabled'}:
            return []
        if status['status'] != 'configured':
            raise KnowledgeUnavailable(status['detail'])
        if not isinstance(query, str) or not query.strip():
            return []
        if not isinstance(limit, int) or not 1 <= limit <= 50:
            raise ValueError('Knowledge result limit must be between 1 and 50.')
        from graphiti_core.search.search_config_recipes import EDGE_HYBRID_SEARCH_RRF
        from graphiti_core.search.search_filters import SearchFilters, DateFilter, ComparisonOperator as Op
        now = datetime.now(timezone.utc)
        filters = SearchFilters(
            expired_at=[[DateFilter(comparison_operator=Op.is_null)]],
            invalid_at=[[DateFilter(comparison_operator=Op.is_null)],
                        [DateFilter(date=now, comparison_operator=Op.greater_than)]],
            valid_at=[[DateFilter(comparison_operator=Op.is_null)],
                      [DateFilter(date=now, comparison_operator=Op.less_than_equal)]])
        scopes = [self._scope('team')]
        if visibility == 'private':
            scopes.append(self._scope('private', owner))
        found = []
        for scope in scopes:
            client = await self._client(scope)
            # Empty/unprocessed scopes should not download a model or call inference.
            ready = await client.driver.execute_query(
                'MATCH (r:RelayEpisodeReceipt {status:"complete"}) RETURN count(r) AS count')
            if not ready[0][0]['count']:
                continue
            config = deepcopy(EDGE_HYBRID_SEARCH_RRF)
            config.limit = min(limit * 3, 100)
            result = await client.search_(query=query, group_ids=[scope], config=config, search_filter=filters)
            for edge in result.edges:
                if (edge.expired_at is not None or (edge.invalid_at and edge.invalid_at <= now)
                        or (edge.valid_at and edge.valid_at > now) or edge.group_id != scope):
                    continue
                episode_uuids = list(set(edge.episodes))
                if not episode_uuids:
                    continue
                provenance = await client.driver.execute_query(
                    'MATCH (r:RelayEpisodeReceipt {status:"complete"}) '
                    'WHERE r.episode_uuid IN $uuids RETURN r.episode_uuid AS uuid,'
                    'r.source_episode_id AS id,r.case_id AS case_id,r.title AS title', uuids=episode_uuids)
                if {row['uuid'] for row in provenance[0]} != set(episode_uuids):
                    continue
                sources = provenance[0]
                found.append(dict(id='kg_' + edge.uuid, content=edge.fact,
                    title=sources[0]['title'] if sources else 'Remembered case fact', kind='semantic',
                    source_episode_ids=sorted({row['id'] for row in sources}),
                    source_case_ids=sorted({row['case_id'] for row in sources}), scope=scope,
                    fact_uuid=edge.uuid, valid_at=edge.valid_at.isoformat() if edge.valid_at else None))
        return found[:limit]

    async def close(self):
        for client in self._clients.values():
            await client.close()
        self._clients.clear()
