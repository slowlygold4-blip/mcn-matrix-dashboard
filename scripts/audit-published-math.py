"""Independent arithmetic replay of sealed daily partitions; never fills gaps."""
from pathlib import Path
from datetime import date, timedelta
import argparse
import collections
import json


def audit(directory):
    manifest = json.loads((directory / 'manifest.json').read_text())
    fields = ['followers', 'likes', 'posts']
    mismatches = []
    daily = collections.defaultdict(lambda: {k: {'net': 0, 'comparable': 0} for k in fields})
    points = topic_points = topic_baseline_checks = 0

    def check(row, field, expected, kind):
        if field not in row or row[field] != expected:
            mismatches.append({'targetId': row['targetId'], 'date': row['date'], 'field': field, 'kind': kind})

    for meta in manifest['files']:
        if meta['kind'] not in ('daily', 'topics'):
            continue
        rows = json.loads((directory / meta['path']).read_text())['items']
        index = {(row['targetId'], row['date']): row for row in rows}
        if len(index) != len(rows):
            raise ValueError('duplicate account/topic day')
        for row in rows:
            previous_date = (date.fromisoformat(row['date']) - timedelta(days=1)).isoformat()
            previous = index.get((row['targetId'], previous_date))
            if meta['kind'] == 'topics':
                topic_points += 1
                for field in ['participants', 'views']:
                    current, base = row[field], None if previous is None else previous[field]
                    expected = None if current is None or base is None else current - base
                    check(row, field + 'Delta', expected, 'topic')
                    check(row, field + 'BaselineAt', None if expected is None else previous['capturedAt'], 'topic')
                    check(row, field + 'BaselineChecksum', None if expected is None else previous['sourceChecksum'], 'topic')
                    topic_baseline_checks += 2
                continue
            points += 1
            for field in fields:
                current, base = row[field], None if previous is None else previous[field]
                expected = None if current is None or base is None else current - base
                check(row, field + 'Delta', expected, 'account')
                if expected is not None:
                    daily[row['date']][field]['net'] += expected
                    daily[row['date']][field]['comparable'] += 1
            expected_estimate = None if row['likesDelta'] is None else row['likesDelta'] * 100
            check(row, 'estimatedPlaysDelta', expected_estimate, 'account')
    return {
        'asOf': manifest['asOf'], 'pointsChecked': points, 'metricComparisons': points * 4,
        'topicPointsChecked': topic_points, 'topicMetricComparisons': topic_points * 2,
        'topicBaselineChecks': topic_baseline_checks,
        'totalComparisons': points * 4 + topic_points * 2 + topic_baseline_checks,
        'mismatchCount': len(mismatches), 'mismatches': mismatches[:50],
        'daily': dict(sorted(daily.items())),
        'limits': [
            'Arithmetic replay only; source identity and field attribution require separate validation.',
            'Daily cohorts vary. Summing daily values does not prove a full-matrix period total.',
            'Estimated plays are like change times 100, never actual platform plays.',
            'Topic changes require the previous calendar day for the same target and matching baseline time/checksum.',
        ],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    result = audit(args.directory)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: v for k, v in result.items() if k != 'daily'}, ensure_ascii=False))
    return 1 if result['mismatchCount'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
