"""Gate definition lookup must succeed before recording a decision."""
from unittest.mock import Mock, patch
import pytest
from hermes_workflows.gate_reply import resolve_gate_reply


def engine(path=None):
    run = {'run_id': 'test-run', 'workflow_id': 'test-workflow', 'status': 'waiting',
           'origin': 'slack:C1', 'nodes': {'owner': {'status': 'waiting_for_review'}}}
    if path is not None:
        run['workflow_path'] = str(path)
    return Mock(active_runs=Mock(return_value=[run]))


def reply(e):
    return resolve_gate_reply('slack:C1', 'approved exact-packet', engine=e,
                              roots=['discovery-only'], core_cli=['bun', 'core'])


def test_pinned_definition_outside_roots_is_used(tmp_path):
    path = tmp_path / 'authorization.yaml'
    path.write_text('id: test-workflow')
    e = engine(path)
    with patch('hermes_workflows.cli_bridge.invoke') as compile_spec, patch('hermes_workflows.tools._resolve_spec_path') as lookup:
        result = reply(e)
    compile_spec.assert_called_once_with(['bun', 'core', 'compile-preview', str(path)])
    lookup.assert_not_called()
    e.decide_review.assert_called_once_with(str(path), 'test-run', 'owner', 'approved', note='exact-packet')
    assert 'resolved as approved' in result['reply']


@pytest.mark.parametrize('missing', [False, True])
def test_invalid_pinned_definition_never_records_or_substitutes(tmp_path, missing):
    path = tmp_path / 'authorization.yaml'
    if not missing:
        path.write_text('malformed')
    e = engine(path)
    with patch('hermes_workflows.cli_bridge.invoke', side_effect=ValueError('invalid definition')), patch('hermes_workflows.tools._resolve_spec_path') as lookup:
        result = reply(e)
    assert 'Could not resolve' in result['reply']
    e.decide_review.assert_not_called()
    lookup.assert_not_called()


def test_legacy_run_without_pinned_path_uses_discovery():
    e = engine()
    with patch('hermes_workflows.tools._resolve_spec_path', return_value='legacy.yaml') as lookup:
        reply(e)
    lookup.assert_called_once_with('test-workflow', ['discovery-only'], ['bun', 'core'])
    e.decide_review.assert_called_once_with('legacy.yaml', 'test-run', 'owner', 'approved', note='exact-packet')
