"""Publication encoding, repository boundaries, and changed-source accounting."""
import base64
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import policy
import run


class ProposalFilesTests(unittest.TestCase):
    def test_modes_binary_links_and_unicode_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '画像 fixture.png').write_bytes(b'\x89PNG\x00\xff')
            (root / 'script.sh').write_text('#!/bin/sh\necho ok\n')
            (root / 'script.sh').chmod(0o755)
            (root / 'link').symlink_to('script.sh')
            files = run.changes({}, run.snapshot(root))
            by_path = {item['path']: item for item in files}
            self.assertEqual(by_path['script.sh']['mode'], '100755')
            self.assertEqual(by_path['link']['mode'], '120000')
            image = by_path['画像 fixture.png']
            self.assertEqual(base64.b64decode(image['content']), b'\x89PNG\x00\xff')
            policy.validate_files(files)

    def test_unchanged_large_files_and_caches_do_not_reject_proposal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'large').write_bytes(b'x' * (policy.MAX_FILE_BYTES + 1))
            for index in range(1001):
                (root / str(index)).touch()
            before = run.snapshot(root)
            (root / '.cache').mkdir()
            (root / '.cache' / 'generated').write_bytes(b'ignored')
            (root / 'src.ts').write_text('export {};')
            self.assertEqual([i['path'] for i in run.changes(before, run.snapshot(root))], ['src.ts'])
            (root / 'src.ts').write_text('modified')
            self.assertNotEqual(run.snapshot(root), before)

    def test_link_escape_chain_and_secret_content_cannot_publish(self):
        for target in ['/etc/passwd', '../outside', '.git/config']:
            with self.assertRaises(policy.PolicyError):
                policy.validate_files([{'path': 'link', 'content': target, 'mode': '120000'}])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'out').symlink_to('/etc')
            (root / 'via').symlink_to('out/passwd')
            with self.assertRaises(policy.PolicyError):
                run.snapshot(root)
        item = {'path': 'fixture.bin', 'encoding': 'base64',
                'content': base64.b64encode(b'-----BEGIN PRIVATE KEY-----\n' + b'A' * 80 + b'\n-----END PRIVATE KEY-----').decode()}
        with self.assertRaisesRegex(policy.PolicyError, 'secret_detected'):
            policy.validate_files([item])

    def test_changed_file_and_proposal_limits_and_warnings(self):
        item = {'path': 'fixture.yaml', 'content': 'x' * 20}
        with patch.object(policy, 'MAX_FILE_BYTES', 10), self.assertRaises(policy.PolicyError):
            policy.validate_files([item])
        with patch.object(policy, 'MAX_PROPOSAL_BYTES', 10), self.assertRaises(policy.PolicyError):
            policy.validate_files([item])
        self.assertEqual(policy.safe_path('日本語 `file`'), '"\\u65e5\\u672c\\u8a9e `file`"')
        self.assertEqual(policy.safe_path('ghp_' + 'a' * 40), '[redacted path]')


if __name__ == '__main__':
    unittest.main()
