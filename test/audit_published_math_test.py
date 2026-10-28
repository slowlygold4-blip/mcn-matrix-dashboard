"""Standard-library, synthetic fault injection for the standalone read-only audit."""
import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest

spec = importlib.util.spec_from_file_location('math_audit', Path(__file__).resolve().parents[1] / 'scripts/audit-published-math.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ArithmeticAudit(unittest.TestCase):
    def report(self, rows, kind='topics'):
        with tempfile.TemporaryDirectory() as home:
            path = Path(home)
            (path / 'manifest.json').write_text(json.dumps({'asOf': '2026-10-28T00:00:00Z', 'files': [{'kind': kind, 'path': 'rows.json'}]}))
            (path / 'rows.json').write_text(json.dumps({'items': rows}))
            return module.audit(path)

    def topic(self, day, participants, views, previous=None, target=1):
        row = {'targetId': target, 'date': day, 'participants': participants, 'views': views,
               'capturedAt': day + 'T01:00:00Z', 'sourceChecksum': day}
        for field in ['participants', 'views']:
            delta = None if not previous or row[field] is None or previous[field] is None else row[field] - previous[field]
            row.update({field + 'Delta': delta, field + 'BaselineAt': previous['capturedAt'] if delta is not None else None,
                        field + 'BaselineChecksum': previous['sourceChecksum'] if delta is not None else None})
        return row

    def test_correct_negative_zero_and_partial_topic_changes(self):
        first = self.topic('2026-10-25', 20, 0)
        second = self.topic('2026-10-26', 18, 0, first)
        third = self.topic('2026-10-27', None, 5, second)
        result = self.report([first, second, third])
        self.assertEqual(result['mismatchCount'], 0)
        self.assertEqual(result['topicMetricComparisons'], 6)
        self.assertEqual(result['topicBaselineChecks'], 12)

    def test_wrong_delta_and_baseline_are_independently_detected(self):
        first = self.topic('2026-10-25', 20, 100)
        second = self.topic('2026-10-26', 22, 150, first)
        second.update(participantsDelta=9, viewsBaselineChecksum='wrong', viewsBaselineAt='wrong')
        self.assertEqual(self.report([first, second])['mismatchCount'], 3)

    def test_missing_calendar_day_cannot_be_zero_or_carried_baseline(self):
        first = self.topic('2026-10-25', 20, 100)
        gap = self.topic('2026-10-27', 25, 200)
        self.assertEqual(self.report([first, gap])['mismatchCount'], 0)
        gap['viewsDelta'] = 0
        self.assertEqual(self.report([first, gap])['mismatchCount'], 1)

    def test_other_topic_never_supplies_baseline(self):
        first = self.topic('2026-10-25', 20, 100)
        other = self.topic('2026-10-26', 25, 200, target=2)
        self.assertEqual(self.report([first, other])['mismatchCount'], 0)

    def test_duplicate_topic_day_is_rejected(self):
        row = self.topic('2026-10-25', 20, 100)
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            self.report([row, row])

    def test_missing_null_fields_are_schema_failures_not_silent_passes(self):
        row = self.topic('2026-10-25', 20, 100)
        del row['viewsDelta']
        self.assertEqual(self.report([row])['mismatchCount'], 1)

    def test_cli_rejects_wrong_topic_math_without_modifying_input(self):
        with tempfile.TemporaryDirectory() as home:
            path = Path(home)
            row = self.topic('2026-10-25', 20, 100)
            row['viewsDelta'] = 0
            (path / 'manifest.json').write_text(json.dumps({'asOf': '2026-10-28T00:00:00Z',
                'files': [{'kind': 'topics', 'path': 'rows.json'}]}))
            (path / 'rows.json').write_text(json.dumps({'items': [row]}))
            before = {p.name: p.read_bytes() for p in path.iterdir()}
            completed = subprocess.run([sys.executable, str(Path(module.__file__)), str(path)],
                                       text=True, capture_output=True, timeout=5)
            self.assertEqual(completed.returncode, 1)
            self.assertEqual(json.loads(completed.stdout)['mismatchCount'], 1)
            self.assertEqual(before, {p.name: p.read_bytes() for p in path.iterdir()})

    def test_account_arithmetic_and_estimate_policy_remain_enforced(self):
        first = {'targetId': 1, 'date': '2026-10-25', 'followers': 1, 'likes': 5, 'posts': 0,
                 'followersDelta': None, 'likesDelta': None, 'postsDelta': None, 'estimatedPlaysDelta': None}
        second = dict(first, date='2026-10-26', followers=3, likes=4, followersDelta=2,
                      likesDelta=-1, postsDelta=0, estimatedPlaysDelta=-100)
        self.assertEqual(self.report([first, second], 'daily')['mismatchCount'], 0)
        second['estimatedPlaysDelta'] = 0
        self.assertEqual(self.report([first, second], 'daily')['mismatchCount'], 1)


if __name__ == '__main__':
    unittest.main()
