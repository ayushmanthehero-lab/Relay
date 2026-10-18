"""Clearly labeled deterministic examples; no model or external execution."""


def bounded(text, limit):
    """Bound derived display text; the complete source stays in its Episode."""
    return text if len(text) <= limit else text[:limit - 1].rstrip() + '…'


def artifact(case, agent, memories, messages, saved_tasks=()):
    updates = '\n'.join('- ' + m['content'] for m in messages if m['role'] == 'user')
    evidence = '\n'.join('[' + m['id'] + '] ' + m['content'] for m in memories)
    context = case['description'] + ('\nCustomer updates:\n' + updates if updates else '')
    csv = any(word in (case['title'] + context).lower() for word in ('csv', 'import', 'duplicate'))
    procedures = [m for m in memories if m['kind'] == 'procedural']
    if procedures:
        first = procedures[0]['content'] + ' [' + procedures[0]['id'] + ']'
    elif csv:
        first = 'Preserve the original CSV and a backup of affected customer records before changing any data.'
    else:
        first = 'Confirm the expected result, affected scope, and a reversible way to test the proposed change.'
    if csv:
        tasks = [
            {'title': 'Confirm recovery preparation', 'description': first},
            {'title': 'Inspect identifiers and duplicate groups', 'description': 'Compare a small sample of original and duplicate records. Check whether a stable external ID exists; record missing IDs and expected matching behavior.'},
            {'title': 'Preview a safe import in staging', 'description': 'Test a small upsert import using the agreed matching key. Compare counts and fields before proposing a production change.'},
            {'title': 'Verify the outcome with the customer', 'description': 'Ask an authorized operator to confirm the result and rollback readiness. Record what actually worked before resolving this case.'},
        ]
    else:
        tasks = [
            {'title': 'Confirm the evidence and scope', 'description': first},
            {'title': 'Prepare and review a small test', 'description': 'Document inputs, expected output, owner, and rollback steps; ask the responsible person to perform the test.'},
            {'title': 'Verify and record the outcome', 'description': 'Compare the observed result to the objective and record confirmation before resolving the case.'},
        ]
    if agent == 'Researcher':
        content = ('Investigation brief\n' + context + '\n\nWhat to verify: ' +
                   ('the import mode, matching key, record counts, and a recoverable backup.' if csv else
                    'the affected scope, expected result, relevant logs, and the responsible operator.') +
                   '\nThe reported problem is evidence; its root cause has not been independently verified.')
    elif agent == 'Planner':
        content = 'First action: ' + first + '\n\nPlan for ' + case['title'] + '\n' + context + '\n\n' + '\n'.join(
            str(i + 1) + '. ' + task['title'] + ': ' + task['description'] for i, task in enumerate(tasks))
    else:
        content = ('Review for ' + case['title'] + '\n' + context +
                   '\n\nCheck that the plan preserves recovery options, names a verification step, and follows the current playbook. '
                   'Use the recorded checklist evidence below to distinguish verified progress from remaining work.')
        if saved_tasks:
            content += '\n\nHuman-recorded project progress:\n' + task_progress(saved_tasks)
        else:
            content += '\nNo completed operational work has been recorded in the checklist.'
    if evidence:
        content += '\n\nRemembered evidence:\n' + evidence
    return {'title': agent + ': ' + case['title'],
            'content': 'Deterministic sample\n' + content + '\n\nThis is a draft recommendation; no external action has been performed.',
            'tasks': tasks if agent == 'Planner' else []}


def task_progress(tasks):
    return '\n'.join('- ' + t['title'] + ': ' + t['status'] +
                     ('; recorded evidence: ' + t['evidence'] if t.get('evidence') else '')
                     for t in tasks)


def learning(case, episode):
    return {
        'semantic_title': bounded('Confirmed outcome: ' + case['title'], 160),
        'semantic_content': bounded('A teammate recorded this outcome for ' + case['title'] + ': ' + episode['content'], 6000),
        'procedure_title': bounded('Playbook: ' + case['title'], 160),
        'procedure_content': bounded(episode['content'], 5800) + '\nVerify the same conditions apply, test safely, and obtain outcome confirmation before marking a future case resolved.',
        'source_episode_ids': [episode['id']],
    }
