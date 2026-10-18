"""Bounded generation contracts for the Relay domain."""

ARTIFACT_SCHEMA = {
    'type': 'object', 'additionalProperties': False,
    'properties': {
        'title': {'type': 'string', 'minLength': 1, 'maxLength': 160},
        'content': {'type': 'string', 'minLength': 1, 'maxLength': 16000},
        'tasks': {'type': 'array', 'maxItems': 8, 'items': {
            'type': 'object', 'additionalProperties': False,
            'properties': {
                'title': {'type': 'string', 'minLength': 1, 'maxLength': 160},
                'description': {'type': 'string', 'minLength': 1, 'maxLength': 1500}},
            'required': ['title', 'description']}},
    }, 'required': ['title', 'content', 'tasks'],
}

LEARNING_SCHEMA = {
    'type': 'object', 'additionalProperties': False,
    'properties': {
        'semantic_title': {'type': 'string', 'minLength': 1, 'maxLength': 160},
        'semantic_content': {'type': 'string', 'minLength': 1, 'maxLength': 6000},
        'procedure_title': {'type': 'string', 'minLength': 1, 'maxLength': 160},
        'procedure_content': {'type': 'string', 'minLength': 1, 'maxLength': 6000},
        'source_episode_ids': {'type': 'array', 'minItems': 1, 'maxItems': 8,
                               'uniqueItems': True, 'items': {'type': 'string'}},
    }, 'required': ['semantic_title', 'semantic_content', 'procedure_title',
                    'procedure_content', 'source_episode_ids'],
}
