"""Durable Graphiti outbox: serialize extraction per scope and acknowledge success."""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from .core import Conflict


class EpisodeIndexer:
    def __init__(self, graph, principal, knowledge, max_attempts=3):
        self.graph, self.principal, self.knowledge = graph, principal, knowledge
        self.max_attempts = max_attempts

    def claim(self, lease_seconds=600):
        now, token = time.time(), uuid.uuid4().hex
        self.graph.q(
            'MATCH (e:Episode) WHERE e.owner=$owner AND coalesce(e.index_attempts,0)>=$maximum '
            'AND (e.index_status IN ["queued","error","demo","disabled"] '
            'OR (e.index_status="running" AND e.index_lease_until<$now)) '
            'SET e.index_status="blocked",e.index_lease_until=0,'
            'e.index_error="Automatic retry limit reached. Check the provider, then retry indexing." '
            'WITH e MERGE (g:Gate {id:"memory"}) SET g.epoch=coalesce(g.epoch,0)+1 RETURN e.id',
            owner=self.principal['id'], maximum=self.max_attempts, now=now)
        rows = self.graph.q(
            'MATCH (e:Episode) WHERE e.owner=$owner AND '
            'coalesce(e.knowledge_current,true)=true AND coalesce(e.index_attempts,0)<$maximum AND '
            '((e.index_status IN ["queued","error","demo","disabled"] AND coalesce(e.index_retry_after,0)<=$now) '
            'OR (e.index_status="running" AND e.index_lease_until<$now)) '
            'WITH e ORDER BY e.created_at LIMIT 1 '
            'MERGE (l:KnowledgeLease {id:CASE WHEN e.visibility="private" THEN "private:"+e.owner ELSE "team" END}) '
            'WITH e,l WHERE coalesce(l.lease_until,0)<$now '
            'SET l.token=$token,l.lease_until=$until,e.index_status="running",e.index_token=$token,'
            'e.index_lease_until=$until,e.index_attempts=coalesce(e.index_attempts,0)+1,e.index_error="" '
            'WITH e MERGE (g:Gate {id:"memory"}) SET g.epoch=coalesce(g.epoch,0)+1 '
            'RETURN e', owner=self.principal['id'], now=now, token=token,
            until=now+lease_seconds, maximum=self.max_attempts)
        return rows[0]['e'] if rows else None

    @staticmethod
    def scope(episode):
        return 'private:' + episode['owner'] if episode['visibility'] == 'private' else 'team'

    def complete(self, episode, receipt):
        if not isinstance(receipt, dict) or not receipt.get('episode_uuid'):
            raise ValueError('Graphiti did not return a completed episode receipt.')
        now = time.time()
        rows = self.graph.q(
            'MATCH (e:Episode {id:$id,index_status:"running",index_token:$token}), '
            '(l:KnowledgeLease {id:$scope,token:$token}) '
            'WHERE e.index_lease_until>$now AND l.lease_until>$now '
            'SET e.index_status="complete",e.graphiti_uuid=$uuid,e.index_completed_at=$now,'
            'e.index_receipt=$receipt,e.index_lease_until=0,e.index_error="",l.lease_until=0 '
            'WITH e MERGE (g:Gate {id:"memory"}) SET g.epoch=coalesce(g.epoch,0)+1 '
            'RETURN e.id AS id', id=episode['id'], token=episode['index_token'],
            scope=self.scope(episode), now=now, uuid=receipt['episode_uuid'], receipt=json.dumps(receipt))
        return bool(rows)

    def fail(self, episode, message):
        delay = min(300, 10 * 2 ** min(episode.get('index_attempts', 1), 5))
        self.graph.q(
            'MATCH (e:Episode {id:$id,index_token:$token,index_status:"running"}), '
            '(l:KnowledgeLease {id:$scope,token:$token}) '
            'SET e.index_status=CASE WHEN e.index_attempts>=$maximum THEN "blocked" ELSE "error" END,'
            'e.index_error=$error,e.index_retry_after=$retry,'
            'e.index_lease_until=0,l.lease_until=0 '
            'WITH e MERGE (g:Gate {id:"memory"}) SET g.epoch=coalesce(g.epoch,0)+1 RETURN e.id',
            id=episode['id'], token=episode['index_token'], scope=self.scope(episode),
            error=message[:500], retry=time.time()+delay, maximum=self.max_attempts)

    def retry(self, episode_id):
        rows = self.graph.q(
            'MATCH (e:Episode {id:$id}) WHERE (e.visibility="team" OR e.owner=$owner) '
            'AND e.index_status IN ["error","blocked","demo","disabled"] '
            'AND coalesce(e.knowledge_current,true)=true '
            'SET e.index_status="queued",e.index_attempts=0,e.index_retry_after=0,e.index_error="" '
            'WITH e MERGE (g:Gate {id:"memory"}) SET g.epoch=coalesce(g.epoch,0)+1 RETURN e',
            id=episode_id, owner=self.principal['id'])
        if not rows:
            raise Conflict('This episode is unavailable or cannot be retried in its current state.')
        return {'episode': rows[0]['e']}

    def mark_inactive(self, status):
        self.graph.q(
            'MATCH (e:Episode) WHERE e.owner=$owner AND e.index_status IN ["queued","demo","disabled"] '
            'SET e.index_status=$status RETURN count(e) AS count',
            owner=self.principal['id'], status=status)

    async def step(self, timeout=540):
        episode = await asyncio.to_thread(self.claim, timeout+60)
        if not episode:
            return {'claimed': False, 'completed': False}
        try:
            receipt = await asyncio.wait_for(self.knowledge.ingest_episode(episode), timeout=timeout)
            committed = await asyncio.to_thread(self.complete, episode, receipt)
            return {'claimed': True, 'completed': committed, 'episode_id': episode['id']}
        except asyncio.CancelledError:
            await asyncio.to_thread(self.fail, episode, 'Indexing interrupted; the saved episode will be retried.')
            raise
        except Exception as exc:
            # Credentials and upstream response bodies must not become UI error messages.
            message = 'Memory indexing failed (' + type(exc).__name__ + '). Check the configured model and embedding service. Automatic retries are limited; use Retry indexing if blocked.'
            await asyncio.to_thread(self.fail, episode, message)
            return {'claimed': True, 'completed': False, 'episode_id': episode['id'], 'error': message}
